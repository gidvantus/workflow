"""Ручки отделов: список и создание в проекте, правка/удаление отдельной строки.

Отдел живёт внутри проекта, поэтому список и создание вложены в проект
(`/api/projects/{project_id}/departments`) и первым шагом проверяют, что проект жив:
несуществующий или мягко удалённый проект — это `404` с тем же текстом, что у ручек
проектов. Проверка берётся из `app.api.projects`, а не переписывается здесь: текст
`404` у обеих половин один и тот же.

Создание выбирает только вид отдела: имя отдела — это `title` вида на момент создания,
а время работы и роли заполняются на странице правки. Поэтому новый отдел приходит с
`windows: []`, `roles: []` и `max_rework: 3`, и второго отдела
того же вида в проекте быть не может — имя занято (`409`).

Правка и удаление адресуются отделом, а не парой «проект + отдел»: плоский путь
`/api/departments/{department_id}` достаёт и строку без проекта — сироту, заведённую до
привязки отделов к проектам. В списке проекта такая строка не видна, а `PATCH` и
`DELETE` по ней работают: иначе мёртвый груз нельзя было бы убрать вовсе.

Вид отдела задаёт **набор полей страницы**, но не ограничивает `PATCH`: ручка принимает
любое известное поле, отказа «поле не того вида» в этой задаче нет. Набор полей — правило
отображения, а не авторизация, и третьему виду он тоже не мешает.

Уникальность названия — правило проекта: имя занято, только если живой отдел **этого**
проекта уже так называется. Одно и то же имя в двух проектах — не конфликт.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.

Время работы — **набор окон** «с/по»: от одного до шести диапазонов, порядок — по
возрастанию начала. `end_time` меньше `start_time` — это переход через полночь
(13:00 → 04:00) в **этом** окне, штатный случай: запрещать его нельзя и «исправлять»
тоже. Окна не пересекаются, а касание концами (13:00–18:00 и 18:00–21:00) пересечением
не считается. Набор заменяется целиком, как `role_ids`: сборки «итогового набора из
базы» нет, потому что у окон нет второй половины, которую надо было бы доставать.

**Процесс отдела** (`GET`/`PUT /api/departments/{id}/process`) — отдельная пара ручек, а
не поле страницы правки: документ ступеней слишком велик для `PATCH`, и сохранять его
надо целиком, вместе с пересборкой реестра. `GET` отдаёт сохранённый документ (или `null`,
если своего процесса у отдела нет), умолчания, коды живых ролей и каталог стражей:
своей копии справочников у фронта нет. `PUT` проверяет документ по таблице отказов,
пишет колонку и **пересобирает реестр** — правка процесса обязана доехать до диспетчера
в пределах интервала синхронизации, а не только выглядеть сохранённой на экране.
Обе ручки браузерные, как `PATCH`: аутентификации в приложении нет.
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime, time
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.projects import PROJECT_NOT_FOUND, _get_alive_project
from app.api.registry import rebuild_registry
from app.db import get_db
from app.models.department import DEFAULT_MAX_REWORK, Department
from app.models.department_kind import DepartmentKind
from app.models.role import Role
from app.process_defaults import GUARDS, default_process
from app.schemas.department import DepartmentCreate, DepartmentResponse, DepartmentUpdate
from app.schemas.process import (
    ProcessError,
    ProcessGuard,
    ProcessResponse,
    ProcessSaveResponse,
    validate_process_document,
)

# Отделы проекта: список и создание.
router = APIRouter(prefix="/api/projects/{project_id}/departments", tags=["departments"])

# Один отдел: правка и мягкое удаление. Путь плоский, потому что отдел уже существует
# и его проект для правки не нужен — см. политику сирот в докстроке модуля.
items_router = APIRouter(prefix="/api/departments", tags=["departments"])

# Сессия на запрос: одна и та же зависимость у всех четырёх ручек.
DbSession = Annotated[Session, Depends(get_db)]

# Время принимается строго как `ЧЧ:ММ`: `9:00` — это уже отказ, а не «починим сами».
CLOCK_PATTERN = re.compile(r"^\d{2}:\d{2}$")
CLOCK_FORMAT = "%H:%M"

# Длины полей страницы правки. Ограничение схемы, а не вкуса: у каждого — свой текст.
REPO_PATH_MAX_LENGTH = 500
BASE_BRANCH_MAX_LENGTH = 200
WORKSPACE_MAX_LENGTH = 500
HUMAN_WORKSPACE_MAX_LENGTH = 500
ARTIFACTS_DIR_MAX_LENGTH = 500
COMPOSE_PROJECT_MAX_LENGTH = 200
TELEGRAM_TOKEN_MAX_LENGTH = 200
TELEGRAM_CHAT_ID_MAX_LENGTH = 64

# Лимит возврата задачи: 0 — «возвращать нельзя», 99 — верхняя граница поля ввода.
MAX_REWORK_MIN = 0
MAX_REWORK_MAX = 99

# Окон времени работы: хотя бы одно и не больше шести. Предел — правило обеих половин:
# сервер отказывает `422`, фронт лишь не даёт добавить седьмое окно кнопкой.
WINDOWS_MAX = 6

# Минуты суток: окно переводится в полуинтервалы, чтобы пересечение считалось честно.
MINUTES_PER_HOUR = 60
MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

CLOCK_INVALID = "Время работы указывается как ЧЧ:ММ, например 09:00"
CLOCK_EQUAL = "Начало и конец рабочего времени совпадают"
WINDOWS_REQUIRED = "Укажите хотя бы одно окно времени работы"
WINDOWS_TOO_MANY = "Окон времени работы не может быть больше шести"
WINDOWS_OVERLAP = "Окна времени работы пересекаются"
ROLE_UNKNOWN = "Выбрана роль, которой нет в списке ролей"
KIND_UNKNOWN = "Выбран вид отдела, которого нет в справочнике"
NO_FIELDS_TO_UPDATE = "Нет полей для изменения"
NAME_TAKEN = "Отдел с таким названием уже есть"
DEPARTMENT_NOT_FOUND = "Отдел не найден"
REPO_PATH_TOO_LONG = "Путь репозитория длиннее 500 символов"
BASE_BRANCH_TOO_LONG = "Базовая ветка длиннее 200 символов"
WORKSPACE_TOO_LONG = "Рабочее пространство отдела длиннее 500 символов"
HUMAN_WORKSPACE_TOO_LONG = "Рабочее пространство человека длиннее 500 символов"
ARTIFACTS_DIR_TOO_LONG = "Директория для сохранения документов длиннее 500 символов"
COMPOSE_PROJECT_TOO_LONG = "Название проекта в Docker длиннее 200 символов"
TELEGRAM_TOKEN_TOO_LONG = "API telegram бота длиннее 200 символов"
TELEGRAM_CHAT_ID_TOO_LONG = "Ваш ID длиннее 64 символов"
MAX_REWORK_INVALID = "Лимит возврата задачи указывается целым числом от 0 до 99"

# Строковые поля страницы правки: имя поля → (предел длины, текст отказа). Порядок
# словаря — порядок проверки и сообщений в документации.
TEXT_FIELDS: dict[str, tuple[int, str]] = {
    "repo_path": (REPO_PATH_MAX_LENGTH, REPO_PATH_TOO_LONG),
    "base_branch": (BASE_BRANCH_MAX_LENGTH, BASE_BRANCH_TOO_LONG),
    "workspace": (WORKSPACE_MAX_LENGTH, WORKSPACE_TOO_LONG),
    "human_workspace": (HUMAN_WORKSPACE_MAX_LENGTH, HUMAN_WORKSPACE_TOO_LONG),
    "artifacts_dir": (ARTIFACTS_DIR_MAX_LENGTH, ARTIFACTS_DIR_TOO_LONG),
    "compose_project": (COMPOSE_PROJECT_MAX_LENGTH, COMPOSE_PROJECT_TOO_LONG),
    "telegram_token": (TELEGRAM_TOKEN_MAX_LENGTH, TELEGRAM_TOKEN_TOO_LONG),
    "telegram_chat_id": (TELEGRAM_CHAT_ID_MAX_LENGTH, TELEGRAM_CHAT_ID_TOO_LONG),
}


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def validate_text(value: str | None, max_length: int, too_long: str) -> str | None:
    """Строковое поле: обрезать по краям и превратить пустое в `NULL`.

    `null` и `""` значат одно и то же — «не заполнено», поэтому в базе не появляется ни
    пустая строка, ни строка из пробелов: и то и другое читается на экране как пустое
    поле. Длина проверяется после обрезки, чтобы пробелы по краям не считались.
    """
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > max_length:
        raise _reject(too_long)
    return cleaned


def validate_max_rework(value: int | None) -> int:
    """Лимит возврата: `null` (пустое поле) — умолчание `3`, иначе `0..99`."""
    if value is None:
        return DEFAULT_MAX_REWORK
    if not MAX_REWORK_MIN <= value <= MAX_REWORK_MAX:
        raise _reject(MAX_REWORK_INVALID)
    return value


def validate_time(value: str) -> time:
    """Время строго `ЧЧ:ММ`: формат проверяет шаблон, диапазон — `strptime`.

    `strptime` ловит то, что шаблон пропускает: `25:00`, `12:60` — они не превращаются
    в `ValueError` шаблона и обязаны получить тот же отказ, что и `9:00`.
    """
    if not CLOCK_PATTERN.match(value):
        raise _reject(CLOCK_INVALID)
    try:
        return datetime.strptime(value, CLOCK_FORMAT).time()
    except ValueError as error:
        raise _reject(CLOCK_INVALID) from error


def validate_times(start: str, end: str) -> tuple[time, time]:
    """Пара «с/по»: оба значения по формату и не равны друг другу.

    `end < start` здесь разрешено — это переход через полночь.
    """
    start_time = validate_time(start)
    end_time = validate_time(end)
    if start_time == end_time:
        raise _reject(CLOCK_EQUAL)
    return start_time, end_time


def validate_role_ids(db: Session, role_ids: list[int]) -> list[Role]:
    """Набор ролей: без повторов, каждая роль есть в справочнике и жива.

    Пустой набор допустим и означает «ролей нет»: требование «хотя бы одна роль» из
    контракта ушло. Повтор схлопывается молча — это не ошибка ввода. Порядок ответа
    задаёт `id` роли, а не порядок в присланном списке.

    Мягко удалённая роль из набора выбрасывается тем же `422 ROLE_UNKNOWN`: её нет в
    списке ролей, который видит человек, и отдел не должен ссылаться на неё молча.
    """
    unique_ids = list(dict.fromkeys(role_ids))
    if not unique_ids:
        return []
    roles = db.scalars(
        select(Role).where(Role.id.in_(unique_ids), Role.deleted_at.is_(None)).order_by(Role.id)
    ).all()
    if len(roles) != len(unique_ids):
        raise _reject(ROLE_UNKNOWN)
    return list(roles)


def _clock(value: time) -> str:
    """Время в колонке окон и в ответе — только часы и минуты: `"13:00"`, без секунд."""
    return value.strftime(CLOCK_FORMAT)


def _spans(start: time, end: time) -> list[tuple[int, int]]:
    """Окно в полуинтервалах минут суток: `[start, end)`.

    `end < start` — окно идёт через полночь (13:00 → 04:00), и это два куска:
    `[780, 1440)` и `[0, 240)`. Правый конец в интервал не входит, поэтому касание
    концами (13:00–18:00 и 18:00–21:00) пересечением не считается.
    """
    first = start.hour * MINUTES_PER_HOUR + start.minute
    second = end.hour * MINUTES_PER_HOUR + end.minute
    if second < first:
        return [(first, MINUTES_PER_DAY), (0, second)]
    return [(first, second)]


def _windows_overlap(spans: list[list[tuple[int, int]]]) -> bool:
    """Пересекается ли хоть одна пара **разных** окон: куски одного окна не сравниваются."""
    for index, first_window in enumerate(spans):
        for second_window in spans[index + 1 :]:
            for first_start, first_end in first_window:
                for second_start, second_end in second_window:
                    if max(first_start, second_start) < min(first_end, second_end):
                        return True
    return False


def validate_windows(raw: list[dict[str, str]]) -> list[dict[str, str]]:
    """Набор окон работы: от одного до шести, формат `ЧЧ:ММ`, без пересечений.

    Порядок проверок фиксирован и повторов не даёт: пустой набор → предел → формат
    каждого окна (тексты `CLOCK_INVALID` и `CLOCK_EQUAL` те же, что были у пары) →
    пересечения на уже разобранных значениях. Возвращаются канонические строки
    `"ЧЧ:ММ"`, отсортированные по возрастанию начала: порядок и формат задаёт сервер,
    а фронт показывает массив как пришёл и время не переформатирует.

    Совпадающие окна пересекаются, касание концами — нет; окно через полночь
    раскалывается на два полуинтервала и сравнивается с остальными обоими кусками.
    """
    if not raw:
        raise _reject(WINDOWS_REQUIRED)
    if len(raw) > WINDOWS_MAX:
        raise _reject(WINDOWS_TOO_MANY)
    windows: list[dict[str, str]] = []
    spans: list[list[tuple[int, int]]] = []
    for window in raw:
        start, end = validate_times(window["start_time"], window["end_time"])
        windows.append({"start_time": _clock(start), "end_time": _clock(end)})
        spans.append(_spans(start, end))
    if _windows_overlap(spans):
        raise _reject(WINDOWS_OVERLAP)
    return sorted(windows, key=lambda window: window["start_time"])


def _name_is_taken(
    db: Session,
    project_id: int | None,
    name: str,
    exclude_id: int | None = None,
) -> bool:
    """Занято ли название среди живых строк **этого проекта**: без учёта регистра.

    Имя удалённого отдела свободно — частичный индекс смотрит только на строки
    с `deleted_at IS NULL`. Имя, занятое в другом проекте, конфликтом не является:
    «Разработка» может быть в каждом проекте.

    Отдел без проекта (`project_id IS NULL`) сравнивается с такими же сиротами:
    `NULL` в индексе не равен `NULL`, поэтому уникальность сирот держит только эта
    проверка.

    Сравнение делается в Python, а не `lower()` в SQL: в SQLite `lower()` опускает
    только латиницу, и проверка «Разработка» / «разработка» на стенде (PostgreSQL)
    и в тестах (SQLite) разошлась бы. Отделов десятки, полный список живых имён
    дешевле диалектной разницы; уникальность на гонке держит частичный индекс.
    """
    statement = select(Department.name).where(Department.deleted_at.is_(None))
    if project_id is None:
        statement = statement.where(Department.project_id.is_(None))
    else:
        statement = statement.where(Department.project_id == project_id)
    if exclude_id is not None:
        statement = statement.where(Department.id != exclude_id)
    taken = {candidate.casefold() for candidate in db.scalars(statement)}
    return name.casefold() in taken


def _get_alive_department(db: Session, department_id: int) -> Department:
    """Живой отдел по id. Удалённый — это `404`: воскрешения через `PATCH` не бывает."""
    department = db.get(Department, department_id)
    if department is None or department.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DEPARTMENT_NOT_FOUND)
    return department


def _commit_or_conflict(db: Session) -> None:
    """Фиксация изменений; гонку по имени ловит индекс и превращается в тот же `409`."""
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN) from error


def _role_codes(db: Session) -> list[str]:
    """Коды живых ролей справочника: ими ограничен `role` ступени процесса.

    Порядок — по `id`, как в `GET /api/roles`: справочник маленький, и порядок ответа не
    должен зависеть от того, как легли строки. Мягко удалённые роли не попадают: сессию по
    удалённой роли диспетчер всё равно не поднимет.
    """
    statement = select(Role.code).where(Role.deleted_at.is_(None)).order_by(Role.id)
    return [code for code in db.scalars(statement) if code]


@router.get(
    "",
    response_model=list[DepartmentResponse],
    summary="Отделы проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def list_departments(project_id: int, db: DbSession) -> Sequence[Department]:
    """Только живые отделы этого проекта, порядок — по `id` возрастанию.

    Пустой проект — пустой массив, а не отказ. Отделы других проектов и строки без
    проекта в список не попадают. `fields` каждой строки — набор полей страницы правки
    по её виду: фронт рисует страницу прямо по ответу списка.
    """
    _get_alive_project(db, project_id)
    return db.scalars(
        select(Department)
        .where(
            Department.project_id == project_id,
            Department.deleted_at.is_(None),
        )
        .order_by(Department.id)
    ).all()


@router.post(
    "",
    response_model=DepartmentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создание отдела в проекте",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
        status.HTTP_409_CONFLICT: {"description": f"Имя занято: «{NAME_TAKEN}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": f"Вида нет в справочнике: «{KIND_UNKNOWN}».",
        },
    },
)
def create_department(project_id: int, payload: DepartmentCreate, db: DbSession) -> Department:
    """`201` с созданным отделом; `404` — проекта нет, `422` — вида нет, `409` — имя занято.

    Порядок проверок: проект → вид → занятость имени вида в проекте. Проект проверяется
    до вида, поэтому вложенный путь на удалённом проекте отвечает `404`, а не `422` о
    виде. Имя отдела — `title` вида; время работы и роли остаются пустыми до страницы
    правки, поэтому новый отдел приходит с `windows: []`, а «хотя бы одна роль» и
    «время обязательно» из прежнего контракта ушли.
    """
    _get_alive_project(db, project_id)
    kind = db.get(DepartmentKind, payload.kind_id)
    if kind is None:
        raise _reject(KIND_UNKNOWN)
    if _name_is_taken(db, project_id, kind.title):
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN)

    department = Department(
        project_id=project_id,
        kind_id=kind.id,
        name=kind.title,
        windows=[],
        roles=[],
    )
    db.add(department)
    _commit_or_conflict(db)
    db.refresh(department)
    return department


@items_router.patch(
    "/{department_id}",
    response_model=DepartmentResponse,
    summary="Правка отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": (
                f"Пустое тело: «{NO_FIELDS_TO_UPDATE}», кривое поле: тексты отказов контракта."
            ),
        },
    },
)
def update_department(
    department_id: int,
    payload: DepartmentUpdate,
    db: DbSession,
) -> Department:
    """`200` с обновлённым отделом; `422` на пустое тело и кривые поля, `404` для удалённого.

    Сначала проверяются все присланные поля, и только потом они присваиваются: отказ не
    должен оставлять в сессии половину правки. `role_ids` заменяет набор ролей целиком, а
    не дополняет его; пустой список роли стирает. Так же целиком заменяется `windows`:
    от одного до шести окон без пересечений, `[]` и `null` — отказ.

    Строковое поле со значением `null` или `""` стирает значение в базе: пустая строка в
    `departments` не появляется ни после одной правки. `max_rework: null` возвращает
    умолчание `3`, а `notifications_enabled: null` и `enabled: null` значат «не менять»: у
    флажка нет значения «пусто». `enabled` — работа отдела: выключенный отдел диспетчер не
    обслуживает, но настройки и роли у него остаются.

    Имя отдела не меняется: оно равно названию вида, а переименования отделов в
    приложении нет. Отдел между проектами не переезжает: `project_id` в теле — не поле
    правки, его значение игнорируется. Тело из одного `project_id` не меняет ничего,
    поэтому ручка отдаёт отдел как есть, не трогая строку; пустое тело по-прежнему `422`.
    """
    department = _get_alive_department(db, department_id)
    changes = payload.model_dump(exclude_unset=True)
    # Переноса отдела между проектами нет: присланный `project_id` не применяется.
    changes.pop("project_id", None)
    if not changes:
        if "project_id" in payload.model_fields_set:
            return department
        raise _reject(NO_FIELDS_TO_UPDATE)

    updates: dict[str, object] = {}
    for field, (max_length, too_long) in TEXT_FIELDS.items():
        if field in changes:
            updates[field] = validate_text(changes[field], max_length, too_long)
    if "max_rework" in changes:
        updates["max_rework"] = validate_max_rework(changes["max_rework"])
    # Флаг работы отдела: `null` и отсутствие ключа — «не менять», как у уведомлений.
    if payload.enabled is not None:
        updates["enabled"] = payload.enabled
    if payload.notifications_enabled is not None:
        updates["notifications_enabled"] = payload.notifications_enabled
    roles: list[Role] | None = None
    if "role_ids" in changes:
        roles = validate_role_ids(db, changes["role_ids"] or [])
    windows: list[dict[str, str]] | None = None
    if "windows" in changes:
        # `null` и `[]` одинаково значат «окон нет» — это отказ, а не очистка расписания:
        # расписание отдела — набор окон, и пустой набор через правку недостижим.
        windows = validate_windows(changes["windows"] or [])

    for field, value in updates.items():
        setattr(department, field, value)
    if windows is not None:
        department.windows = windows
    if roles is not None:
        department.roles = roles
        # Роли лежат в `department_roles`, а строка `departments` при такой правке не
        # меняется: без явного `updated_at` `onupdate=func.now()` не сработает, и
        # колонка «Обновлён» покажет дату до правки, хотя отдел уже изменили.
        department.updated_at = datetime.now(UTC)

    _commit_or_conflict(db)
    db.refresh(department)
    return department


@items_router.get(
    "/{department_id}/process",
    response_model=ProcessResponse,
    summary="Процесс отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
    },
)
def get_process(department_id: int, db: DbSession) -> ProcessResponse:
    """Сохранённый процесс отдела, умолчания, роли и стражи.

    `document: null` — своего процесса у отдела нет: диспетчер исполняет `defaults`, и это
    нормальное состояние только что заведённого отдела, а не ошибка. `defaults` приходят
    всегда: по ним экран рисует «Сбросить к умолчанию» без второго запроса.

    Документ отдаётся как лежит в колонке, без пересборки: сохранённое и показанное на
    экране обязано совпадать, иначе первое же «Сохранить» перепишет таблицу «само».
    """
    department = _get_alive_department(db, department_id)
    return ProcessResponse(
        document=department.process,
        defaults=default_process(),
        roles=_role_codes(db),
        guards=[ProcessGuard(id=guard_id, title=title) for guard_id, title in GUARDS],
    )


@items_router.put(
    "/{department_id}/process",
    response_model=ProcessSaveResponse,
    summary="Сохранить процесс отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
    },
)
def save_process(
    department_id: int,
    db: DbSession,
    payload: Annotated[Any, Body()],
) -> ProcessSaveResponse:
    """Проверить документ, записать колонку и пересобрать реестр.

    Тело — документ целиком, а не `PATCH`: таблица ступеней меняется только вместе с
    именами меток, и «половина сохранённого процесса» — это документ, который никто не
    проверял. Форма тела проверяется не моделью pydantic, а таблицей отказов
    (`app/schemas/process.py`): порядок текстов — часть контракта.

    Порядок записи — из постановки: сначала колонка, потом `rebuild_registry`. Если
    пересборка упадёт, сохранённый процесс останется в базе, а реестр — прежним: ручка
    ответит своей ошибкой, а следующий тик синхронизации привезёт документ отдела, как
    только пересборка пройдёт. Обратный порядок («пересобрать, потом сохранить») показал
    бы в реестре документ, которого нет в базе.
    """
    department = _get_alive_department(db, department_id)
    try:
        document = validate_process_document(payload, _role_codes(db))
    except ProcessError as error:
        raise _reject(str(error)) from None
    department.process = document
    _commit_or_conflict(db)
    rebuilt = rebuild_registry(db)
    return ProcessSaveResponse(revision=rebuilt.revision, document=document)


@items_router.delete(
    "/{department_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягкое удаление отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
    },
)
def delete_department(department_id: int, db: DbSession) -> Response:
    """`204` без тела: строка остаётся в таблице с `deleted_at`, из списка исчезает.

    Строки `department_roles` при этом не удаляются: физического удаления в приложении
    нет. Повторный `DELETE` — `404`.
    """
    department = _get_alive_department(db, department_id)
    department.deleted_at = datetime.now(UTC)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
