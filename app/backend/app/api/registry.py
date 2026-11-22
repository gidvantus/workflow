"""Ручки реестра проектов: чтение, сохранение и пересборка документа из базы.

Реестр — документ формата v2 («проект → вложенные отделы»). Его читает плагин
диспетчера и кладёт кешем в `projects.json`; здесь документ живёт ревизиями в таблице
`registry_documents`. Три ручки и никакого экрана правки: `GET` отдаёт последнюю
ревизию, `PUT` принимает документ от человека, `POST /rebuild` собирает его из текущих
строк `projects`/`departments`.

**Токен.** В документе лежат токены телеграм-ботов, аутентификации в приложении нет,
поэтому все три ручки требуют общий токен из окружения (`REGISTRY_TOKEN`) в заголовке
`X-Registry-Token`. Незаданный `REGISTRY_TOKEN` — не «пускать всех», а отказ: иначе
стенд без переменной отдавал бы ботов по сети кому угодно.

**Проверка формы.** Документ принимается свободным телом: форму v2 знает
`plugins/registry.mjs`, и вторая её копия в схемах разошлась бы с первой. Валидаторы
здесь отказывают ровно по таблице отказов контракта, а не по составу ключей: новый
необязательный ключ отдела (порты, `areas`, `labels` живут только в файле) не должен
ронять сохранение. Порядок проверок фиксирован — версия, проекты, проект, расписание,
`default`, бот, — чтобы на документе с двумя ошибками ответ был предсказуемым.

**Ревизии только добавляются.** `PUT` и `rebuild` пишут новую строку, прошлые не
меняются; `GET` отдаёт последнюю. Документ сохраняется как прислан (ручка его не
переписывает), `rebuild` собирает его из базы по правилам из контракта задачи.

**Публикация на каждой правке.** Правка из веба (`POST`/`PATCH`/`DELETE` отделов и
проектов) публикует документ в **той же транзакции**, что и саму правку: `flush` правки,
сборка документа, добавление ревизии, один `commit`. Состояния «строка в базе изменена,
а документ реестра остался прежним» быть не должно — именно из него выросла поломка,
когда выключенный в вебе отдел продолжал работать. Отсюда три следствия. Правка,
после которой документ не проходит проверку формы, отклоняется тем же `422` с текстом
из таблицы отказов, а данные остаются нетронутыми. Гонка за номер ревизии повторяется
в savepoint и не откатывает правку; если номер не достался ни за `REVISION_ATTEMPTS`
попыток, ручка отвечает `409` и откатывает правку целиком. Правка, ничего не
изменившая в документе, ревизии не добавляет: номер растёт только вместе с содержимым.
Публикация не требует токена — она часть транзакции правки, а не отдельная запись
документа человеком.

**Расписание отделов.** В базе окна лежат колонкой `departments.windows` с ключами
`start_time`/`end_time`, а в документе v2 — массивом `windows` у отдела с ключами
`start`/`stop`: форму документа задаёт `plugins/registry.mjs`, и переименовывать его
ключи нельзя. Все окна отдела попадают в документ в том же порядке (по возрастанию
начала), пустой набор — ключа `windows` в документе нет вовсе.
"""

import json
import secrets
from collections.abc import Sequence
from datetime import datetime, time
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models.department import Department
from app.models.project import Project
from app.models.registry import RegistryDocument
from app.schemas.registry import RegistryRebuildResponse, RegistryStoredResponse

router = APIRouter(prefix="/api/registry", tags=["registry"])

DbSession = Annotated[Session, Depends(get_db)]

# Тексты отказов — часть контракта: фронт и человек видят их дословно.
TOKEN_REJECTED = "Токен реестра не принят"
REGISTRY_NOT_BUILT = "Реестр ещё не собран"
REGISTRY_CORRUPTED = "Реестр повреждён: документ последней ревизии не читается"
VERSION_UNSUPPORTED = "Поддерживается только версия реестра 2"
NO_PROJECTS = "В реестре нет ни одного проекта"
PROJECT_ID_REQUIRED = "У проекта не задан id"
PROJECT_ID_DUPLICATE = "Повторяющийся id проекта: «{id}»"
PROJECT_NO_DEPARTMENTS = "У проекта «{id}» нет ни одного отдела"
PROJECT_DUPLICATE_DEVELOPMENT = "У проекта «{id}» больше одного отдела разработки"
WINDOW_FORMAT = "Время работы указывается как ЧЧ:ММ, например 09:00"
WINDOW_CLOSED = "Начало и конец рабочего времени совпадают"
DEFAULT_UNKNOWN = "default указывает на неизвестный проект: «{id}»"
TELEGRAM_INCOMPLETE = "У бота проекта «{id}» не задан токен или id чата"
REVISION_CONFLICT = "Ревизию реестра не удалось записать: одновременная запись"
# Описание отказа `422` у ручек, которые публикуют реестр: текст ответа — из таблицы
# отказов проверки формы, своего текста правка не сочиняет.
PUBLISH_REFUSED = "Реестр не может выразить правку: текст отказа — у проверки формы реестра."

# Версия формата реестра, которую понимают плагин и эти ручки.
SUPPORTED_VERSION = 2
DEVELOPMENT_KIND = "development"
# Сколько раз пробовать записать ревизию, если номер заняли между чтением и вставкой.
REVISION_ATTEMPTS = 3
# Сколько последних ревизий хранится: дальше история подрезается в той же транзакции.
KEEP_REVISIONS = 20
# Пометки о происхождении ревизии: их видно в базе и они объясняют, откуда документ.
NOTE_PUT = "получен через PUT /api/registry"
NOTE_REBUILD = "собран из базы: POST /api/registry/rebuild"
NOTE_EDIT = "опубликован правкой в вебе"

ClockPair = tuple[time, time]


class _Reject(HTTPException):
    """Отказ проверки: `422` с текстом из контракта, который показывают дословно."""

    def __init__(self, detail: str) -> None:
        super().__init__(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def require_registry_token(
    settings: Annotated[Settings, Depends(get_settings)],
    x_registry_token: Annotated[str | None, Header(alias="X-Registry-Token")] = None,
) -> None:
    """Пускает только с токеном из окружения; незаданный токен — отказ, а не «пускать всех»."""
    expected = settings.registry_token
    if (
        not expected
        or not x_registry_token
        or not secrets.compare_digest(expected, x_registry_token)
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            TOKEN_REJECTED,
            headers={"WWW-Authenticate": "X-Registry-Token"},
        )


def _is_text(value: Any) -> bool:
    """Непустая строка после обрезки пробелов: только такие значения считаются заданными."""
    return isinstance(value, str) and bool(value.strip())


def _is_department(value: Any) -> bool:
    """Годный отдел: объект с названием вида (`kind`).

    Ровно по этому признаку отдел читает `plugins/registry.mjs`: запись без `kind`
    потребитель выбрасывает, поэтому документ, где годных отделов нет, принимать
    нельзя — иначе правка из веба получает `200` и молча не доезжает до диспетчера.
    """
    return isinstance(value, dict) and _is_text(value.get("kind"))


def _pair(window: Any) -> ClockPair | None:
    """Пара «начало и конец» окна или `None`, если окно задано не парой.

    `None` — сигнал отказа формата: половина пары (одно поле пустое) — ошибка, а не
    «пустая пара», потому что расписание без конца не имеет смысла.
    """
    if not isinstance(window, dict):
        return None
    start, stop = window.get("start"), window.get("stop")
    if not _is_text(start) or not _is_text(stop):
        return None
    return _parse_clock(str(start)), _parse_clock(str(stop))


def _parse_clock(value: str) -> time:
    """`"ЧЧ:ММ"` в `time`; всё остальное, включая `25:00` и `12:60`, — отказ формата."""
    text = value.strip()
    if len(text) != 5 or text[2] != ":":
        raise _Reject(WINDOW_FORMAT)
    hours, minutes = text[:2], text[3:]
    if not (hours.isdigit() and minutes.isdigit()):
        raise _Reject(WINDOW_FORMAT)
    hour, minute = int(hours), int(minutes)
    if hour > 23 or minute > 59:
        raise _Reject(WINDOW_FORMAT)
    return time(hour=hour, minute=minute)


def _check_windows(departments: Sequence[Any]) -> None:
    """Окна всех отделов проекта: формат пары и ненулевая длина окна."""
    for department in departments:
        if not isinstance(department, dict) or "windows" not in department:
            continue
        windows = department["windows"]
        if windows is None:
            continue
        if not isinstance(windows, list):
            raise _Reject(WINDOW_FORMAT)
        for window in windows:
            pair = _pair(window)
            if pair is None:
                raise _Reject(WINDOW_FORMAT)
            if pair[0] == pair[1]:
                raise _Reject(WINDOW_CLOSED)


def _check_telegram(project_id: str, departments: Sequence[Any]) -> None:
    """Бот: `token` и `chatId` задаются только вместе.

    Заданность — наличие непустого значения, а не истинность: `chatId: 0` из старого
    примера файла — заданное значение, и пара «токен + нулевой чат» остаётся полной
    парой. Пустая строка и `null` — то же, что отсутствие поля.
    """
    for department in departments:
        if not isinstance(department, dict):
            continue
        telegram = department.get("telegram")
        if not isinstance(telegram, dict):
            continue
        has_token = _is_text(telegram.get("token"))
        has_chat = _is_text(telegram.get("chatId")) or isinstance(telegram.get("chatId"), int)
        if has_token != has_chat:
            raise _Reject(TELEGRAM_INCOMPLETE.format(id=project_id))


def validate_document(document: Any) -> dict[str, Any]:
    """Проверить документ реестра и вернуть его же; отказ — `422` с текстом контракта."""
    if not isinstance(document, dict) or document.get("version") != SUPPORTED_VERSION:
        raise _Reject(VERSION_UNSUPPORTED)
    projects = document.get("projects")
    if not isinstance(projects, list) or not projects:
        raise _Reject(NO_PROJECTS)

    seen: set[str] = set()
    for project in projects:
        raw_id = project.get("id") if isinstance(project, dict) else None
        if not _is_text(raw_id):
            raise _Reject(PROJECT_ID_REQUIRED)
        project_id = str(raw_id).strip()
        if project_id in seen:
            raise _Reject(PROJECT_ID_DUPLICATE.format(id=project_id))
        seen.add(project_id)
        departments = project.get("departments")
        if not isinstance(departments, list) or not any(
            _is_department(department) for department in departments
        ):
            raise _Reject(PROJECT_NO_DEPARTMENTS.format(id=project_id))
        if _development_count(departments) > 1:
            raise _Reject(PROJECT_DUPLICATE_DEVELOPMENT.format(id=project_id))
        _check_windows(departments)

    default = document.get("default")
    if default is not None and str(default) not in seen:
        raise _Reject(DEFAULT_UNKNOWN.format(id=str(default)))

    for project in projects:
        # `projects` проверен выше, поэтому здесь проект — объект и `id` у него есть.
        assert isinstance(project, dict)
        _check_telegram(str(project["id"]).strip(), project["departments"])
    return document


def _development_count(departments: Sequence[Any]) -> int:
    """Сколько отделов вида «разработка» у проекта: диспетчер обслуживает ровно один."""
    return sum(
        1
        for department in departments
        if _is_department(department) and department.get("kind") == DEVELOPMENT_KIND
    )


def _next_revision(db: Session) -> int:
    """Номер следующей ревизии: «предыдущая + 1», первая — 1."""
    current = db.scalar(select(func.max(RegistryDocument.revision)))
    return (current or 0) + 1


def _body(document: dict[str, Any]) -> str:
    """Текст документа для колонки `body`: одна и та же запись у всех, кто её пишет."""
    return json.dumps(document, ensure_ascii=False, indent=2)


def _insert(db: Session, document: dict[str, Any], note: str) -> RegistryDocument:
    """Одна попытка вставить ревизию в savepoint; `IntegrityError` по номеру — наружу.

    Номер выдаётся приложением, поэтому гонка двух одновременных записей возможна.
    Уникальный индекс `uq_registry_documents_revision` её ловит, а не превращает в два
    документа с одним номером: вставка идёт в savepoint (`begin_nested`), после
    `IntegrityError` откатывается только она, и внешняя транзакция остаётся живой. В ней
    лежит сама правка, ради которой публикуется документ, — `rollback()` потерял бы её.
    """
    row = RegistryDocument(revision=_next_revision(db), body=_body(document), note=note)
    with db.begin_nested():
        db.add(row)
    return row


def _store(db: Session, document: dict[str, Any], note: str) -> RegistryDocument:
    """Записать известный документ ревизией, повторив занятый номер. Коммитит вызывающий.

    Для `PUT` и `rebuild`: документ уже посчитан и на повторе не меняется — `PUT` пишет
    ровно то, что прислали, а `rebuild` собирает документ заново до вызова. Публикация
    правки сюда не ходит: у неё документ пересобирается на каждой попытке — см.
    `publish_registry`, иначе повтор записал бы состояние до чужого коммита.

    Подрез истории — здесь, а не в публикации: он общий для всех трёх записей, включая
    `PUT` и `rebuild`, иначе «хранятся последние `KEEP_REVISIONS`» было бы верно только
    для правок из веба.
    """
    for attempt in range(REVISION_ATTEMPTS):
        try:
            row = _insert(db, document, note)
        except IntegrityError:
            if attempt == REVISION_ATTEMPTS - 1:
                raise HTTPException(status.HTTP_409_CONFLICT, REVISION_CONFLICT) from None
            continue
        _prune(db)
        return row
    raise HTTPException(status.HTTP_409_CONFLICT, REVISION_CONFLICT)


def _prune(db: Session) -> None:
    """Оставить последние `KEEP_REVISIONS` ревизий, старые удалить в этой же транзакции.

    Ревизии — не документы отката, а журнал последних состояний (`GET` отдаёт только
    последнюю), поэтому история не растёт бесконечно. Текущая ревизия не подрезается
    никогда: порог считается по последним `KEEP_REVISIONS` строкам, а удаляются лишь те,
    что старше самой старой из них.
    """
    revisions = db.scalars(
        select(RegistryDocument.revision)
        .order_by(RegistryDocument.revision.desc())
        .limit(KEEP_REVISIONS)
    ).all()
    if len(revisions) < KEEP_REVISIONS:
        return
    oldest = min(revisions)
    db.execute(delete(RegistryDocument).where(RegistryDocument.revision < oldest))


def _last(db: Session) -> RegistryDocument | None:
    """Последняя ревизия или `None`: пустая таблица для записи — не ошибка, а «не собрано»."""
    return db.scalars(
        select(RegistryDocument).order_by(RegistryDocument.revision.desc()).limit(1)
    ).first()


def publish_registry(db: Session, note: str = NOTE_EDIT) -> RegistryDocument | None:
    """Опубликовать текущее состояние базы ревизией — в чужой транзакции, без коммита.

    Вызывается ручками правки перед их `commit()`: правка и документ фиксируются вместе.
    `None` — «публиковать нечего»: документ совпадает с последней ревизией, либо в базе
    ещё нет ни одного проекта с отделами и реестр ни разу не собирался.

    Порядок попытки: собрать → проверить форму → сравнить с последней ревизией →
    записать → подрезать историю. Проверка идёт до записи, поэтому «кривая» правка не
    оставляет ни строки, ни ревизии. Сравнение по тексту документа отсекает пустые
    правки: номер ревизии растёт только вместе с содержимым, иначе каждая перезапись того
    же значения раздувала бы историю и заставляла диспетчера перечитывать тот же документ.

    **Документ собирается заново на каждой попытке.** Это не оптимизация, а исправление
    гонки: пока мы вставляли ревизию `N`, соседняя вкладка могла закоммитить свою правку и
    занять этот номер. Её изменение уже в базе, поэтому повтор обязан увидеть его в
    документе — иначе ревизия `N+1` записала бы состояние *до* чужого коммита и вернула бы
    диспетчеру только что выключенный отдел. Сборка, проверка и сравнение входят в попытку
    по той же причине: после чужого коммита могло измениться и «публиковать нечего».

    Пустой документ — единственное исключение из проверки формы: `validate_document`
    отвечает на него `NO_PROJECTS`, потому что человек не должен стирать реестр пустым
    телом `PUT`. Проекция из базы, наоборот, обязана быть честной: если правка убрала
    последний проект или отдел, публикуется пустой документ, а не прежняя ревизия с уже
    удалёнными строками (иначе диспетчер продолжал бы обслуживать удалённое). Пока
    ревизий нет, публиковать нечего: реестр ещё не собран, и первая же правка, давшая
    проект с отделом, создаст ревизию 1.
    """
    for attempt in range(REVISION_ATTEMPTS):
        document = build_document(db)
        body = _body(document)
        latest = _last(db)
        if not document["projects"]:
            if latest is None or latest.body == body:
                return None
        else:
            validate_document(document)
            if latest is not None and latest.body == body:
                return None
        try:
            row = _insert(db, document, note)
        except IntegrityError:
            if attempt == REVISION_ATTEMPTS - 1:
                raise HTTPException(status.HTTP_409_CONFLICT, REVISION_CONFLICT) from None
            continue
        _prune(db)
        return row
    raise HTTPException(status.HTTP_409_CONFLICT, REVISION_CONFLICT)


def _latest(db: Session) -> RegistryDocument:
    """Последняя ревизия; пустая таблица — `404` «Реестр ещё не собран»."""
    row = _last(db)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, REGISTRY_NOT_BUILT)
    return row


def _document_of(row: RegistryDocument) -> dict[str, Any]:
    """Документ ревизии, разобранный из JSON; битый текст — `500`, а не пустой ответ."""
    try:
        document = json.loads(row.body)
    except ValueError:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, REGISTRY_CORRUPTED) from None
    if not isinstance(document, dict):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, REGISTRY_CORRUPTED)
    return document


def _windows(department: Department) -> list[dict[str, str]]:
    """Окна работы отдела парами `start`/`stop` в порядке из колонки.

    Пустой набор — расписания нет, и ключ `windows` в документ не попадает: форма v2
    знает его как необязательный, а пустой массив в файле реестра означал бы «окон ноль»
    вместо «нет данных». Окна уже лежат в колонке по возрастанию начала и без
    пересечений — ручка правки проверяет это до записи, — поэтому здесь только форма
    ключей: `windows` в документе — `start`/`stop`, а в базе — `start_time`/`end_time`.
    """
    return [
        {"start": window["start_time"], "stop": window["end_time"]} for window in department.windows
    ]


def _telegram(department: Department) -> dict[str, Any] | None:
    """Бот отдела по правилу контракта: уведомления включены **и** заполнены оба поля.

    `chatId` отдаётся числом, когда id чата — цифры: так его записывает файл реестра
    (`294292338`), а нецифровой id (имя канала) остаётся строкой.
    """
    if not department.notifications_enabled:
        return None
    token = (department.telegram_token or "").strip()
    chat_id = (department.telegram_chat_id or "").strip()
    if not token or not chat_id:
        return None
    return {"token": token, "chatId": int(chat_id) if chat_id.isdigit() else chat_id}


def _department_row(department: Department) -> dict[str, Any]:
    """Отдел в документе: код вида, имя и заполненные поля страницы правки.

    Незаполненное поле не попадает в документ вовсе, а не приходит `null`: плагин
    подставляет умолчание только на отсутствующем ключе, а `null` для `repo` или
    `workspace` он читает как значение.

    Исключение — `enabled` и `maxRework`: у них есть значение, отличное от «не задано»,
    поэтому они попадают в документ всегда. `enabled` — это `bool` из базы, а не
    отсутствующий ключ: диспетчер необязательный ключ читает как «включён».
    """
    row: dict[str, Any] = {"kind": department.kind.code, "title": department.name}
    for key, value in (
        ("repo", department.repo_path),
        ("base", department.base_branch),
        ("workspace", department.workspace),
        ("humanClone", department.human_workspace),
        ("artifacts", department.artifacts_dir),
        ("composeProject", department.compose_project),
    ):
        text = (value or "").strip()
        if text:
            row[key] = text
    windows = _windows(department)
    if windows:
        row["windows"] = windows
    row["maxRework"] = department.max_rework
    # Флаг работы отдела отдаётся **всегда**, в отличие от незаполненных полей: диспетчер
    # читает `dept.enabled !== false`, поэтому отсутствующий ключ и `null` для него значат
    # «включён». Опущенный ключ означал бы «включён» у выключенного отдела — то есть
    # выключатель не доезжал бы до работы, а только выглядел выключенным в вебе.
    row["enabled"] = department.enabled
    telegram = _telegram(department)
    if telegram is not None:
        row["telegram"] = telegram
    return row


def build_document(db: Session) -> dict[str, Any]:
    """Собрать документ v2 из живых строк `projects` и `departments`.

    **`id` проекта.** Если у проекта задан `code` (`workflow`, `CRMDormitory`), в документ
    идёт он: `id` в реестре должен быть стабильным человеческим слагом, потому что файл
    реестра отдела держится на слагах, а склейка `plugins/registry.mjs` сопоставляет
    проекты по `id`. Проект без кода остаётся под `str(id)` — обратная совместимость:
    старые документы и ещё не заполненные кодами базы читаются как прежде.

    Проект без отделов в реестр не попадает: правило формата — у проекта минимум один
    отдел, а проект, у которого отделов ещё не завели, диспетчеру всё равно нечем
    обслуживать. `default` не ставится: в базе нет признака «проект по умолчанию», и
    выдумывать его из порядка `id` значит молча переназначить проект человеку —
    плагин сохранит `default` из файла overlay-склейкой.

    Отделы читаются одним запросом на все проекты: список проектов маленький, но
    запрос на проект в ручке, которую вызывают после каждой правки, — лишнее.

    **Виды отделов — только чтение.** `kind.code` приходит из справочника
    `department_kinds`, а у него в API есть только `GET`: завести или переименовать вид
    через веб нельзя, поэтому публикация в `department_kinds.py` не нужна. Появится
    ручка записи вида — понадобится и публикация, как у отделов и проектов.
    """
    projects = db.scalars(
        select(Project).where(Project.deleted_at.is_(None)).order_by(Project.id)
    ).all()
    ids = [project.id for project in projects]
    departments_by_project: dict[int, list[Department]] = {}
    if ids:
        rows = db.scalars(
            select(Department)
            .where(Department.deleted_at.is_(None), Department.project_id.in_(ids))
            .order_by(Department.id)
        ).all()
        for department in rows:
            if department.project_id is None:
                continue
            departments_by_project.setdefault(department.project_id, []).append(department)

    document: dict[str, Any] = {"version": SUPPORTED_VERSION, "projects": []}
    for project in projects:
        departments = departments_by_project.get(project.id, [])
        if not departments:
            continue
        document["projects"].append(
            {
                # Код проекта, если он задан; иначе — прежний числовой `id` строки.
                "id": project.code or str(project.id),
                "title": project.name,
                "departments": [_department_row(department) for department in departments],
            }
        )
    return document


@router.get(
    "",
    response_model=dict[str, Any],
    summary="Последняя ревизия документа реестра",
    dependencies=[Depends(require_registry_token)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": f"Нет токена: «{TOKEN_REJECTED}»."},
        status.HTTP_404_NOT_FOUND: {"description": f"Таблица пуста: «{REGISTRY_NOT_BUILT}»."},
    },
)
def read_registry(db: DbSession) -> dict[str, Any]:
    """Документ v2 последней ревизии — ровно в том виде, в каком он сохранён."""
    return _document_of(_latest(db))


@router.put(
    "",
    response_model=RegistryStoredResponse,
    summary="Сохранить документ реестра новой ревизией",
    dependencies=[Depends(require_registry_token)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": f"Нет токена: «{TOKEN_REJECTED}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": "Документ не прошёл проверку формы; тексты отказов — в контракте."
        },
    },
)
def store_registry(
    db: DbSession,
    document: Annotated[Any, Body()] = None,
) -> RegistryStoredResponse:
    """Проверить присланный документ и записать его новой ревизией.

    Документ сохраняется как прислан: ручка проверяет форму, но не переписывает её —
    нормализация (умолчания `title`, `base`, портов) живёт в `plugins/registry.mjs`.
    """
    checked = validate_document(document)
    row = _store(db, checked, NOTE_PUT)
    db.commit()
    db.refresh(row)
    return RegistryStoredResponse(revision=row.revision, stored_at=_stored_at(row))


@router.post(
    "/rebuild",
    response_model=RegistryRebuildResponse,
    summary="Собрать документ реестра из базы и сохранить ревизией",
    dependencies=[Depends(require_registry_token)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": f"Нет токена: «{TOKEN_REJECTED}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": (
                "Собранный документ не прошёл проверку формы: в базе нет годных проектов "
                "или строки противоречат правилам реестра."
            )
        },
    },
)
def rebuild_registry(db: DbSession) -> RegistryRebuildResponse:
    """Собрать документ из `projects`/`departments`, сохранить ревизией и отдать его же.

    Собранный документ проходит ту же проверку, что и присланный `PUT`: одна таблица
    отказов на две ручки, и «кривая» база не попадает в реестр молча.
    """
    document = validate_document(build_document(db))
    row = _store(db, document, NOTE_REBUILD)
    db.commit()
    db.refresh(row)
    return RegistryRebuildResponse(
        revision=row.revision,
        stored_at=_stored_at(row),
        document=document,
    )


def _stored_at(row: RegistryDocument) -> datetime:
    """Время записи ревизии: колонка `created_at`, а не время ответа."""
    return row.created_at
