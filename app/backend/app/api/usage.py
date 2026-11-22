"""Ручки журнала расхода смен: приём смены от harness и суммы в разрезе проекта.

Журнал — вторая половина учёта токенов. Первая живёт в harness и уже посчитана: книга
привязок `dev-department-usage.json` знает, какая сессия к какому тикету относится, а
`usageCard` отдаёт по каждой сессии ходы и токены. Деньги при этом считает **сервер**:
у отдела один прайс — четыре цены проекта в долларах США за 1 000 000 токенов
(`projects.price_*`), и формула у него одна (`app.money.amount_for`). Смена приезжает
количествами, а не суммой: вторая формула в надстройке исчезла вместе со вторым прайсом.

Поэтому `rates`, `cost_usd` в сессиях и `totals` в теле смены больше не значат ничего.
Они **игнорируются**, а не отвергаются: в `dev-department-usage-queue.json` лежат смены
в старом формате, и `422` на них означал бы потерю расхода — очередь считает такой
отказ невременным и выбрасывает запись.

**Проекта в вебе нет** (или все четыре его цены нулевые) — смена принимается с нулевой
суммой. Отказом это не является по той же причине: отвергнутая смена выбрасывается из
очереди и теряет расход, а деньги проекта можно посчитать и позже, когда цены появятся.

**Одна сессия входит в суммы проекта один раз.** Смена может взять «продолженный
диалог» из прошлой смены (`carried`), и та же сессия приезжает второй раз. Её держит
уникальный индекс `(project_ref, session)`: повторная запись пропускается и считается в
ответе как `skipped`. Это и есть расхождение с текстом Telegram-сводки, где цифра дня,
а не сумма проекта.

**Идемпотентность смены.** Пара `(project_ref, shift_key)` уникальна: повторный `POST`
с той же сменой новых строк не заводит и отвечает `200` с `changed: false` и текущими
числами смены. `201` — смена заведена впервые (`changed: true`).

**Тексты отказов — часть контракта.** Их показывает человеку harness, поэтому они
собраны константами и не сочиняются на месте. Набор отказов закрыт таблицей контракта
(#57): «Укажите проект смены», «Укажите ключ смены», «Смена должна иметь начало и
конец», «Причина закрытия смены указывается как window или manual», «Сессия без роли или
id», «Отрицательный расход», «Слишком много сессий в смене». Проверки тарифов и сверки
итога из него ушли вместе с тарифами и `totals`. Сверх таблицы стоят четыре защиты от
сломанного отправителя — длина значения сверх колонки, строка вместо числа, отрицательное
количество и посчитанная сумма сверх разрядности колонки: они спасают от `500` на
PostgreSQL, приходят только от машины и в интерфейсе не показываются.

**Порядок проверок фиксирован** — проект, ключ, время, причина, число сессий, сессии по
одной, — чтобы на теле с двумя ошибками ответ был предсказуемым. Деньги считаются
`Decimal` с шестью знаками: `float` на границе округления дал бы расхождение сумм с
детализацией.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.projects import (
    PROJECT_NOT_FOUND,
    find_project_by_ref,
    prices_of,
)
from app.api.registry import require_registry_token
from app.db import get_db
from app.models.project import Project
from app.models.usage_session import UsageSession
from app.models.usage_shift import UsageShift
from app.money import amount_for
from app.schemas.usage import (
    UsageProjectTotal,
    UsageProjectUsage,
    UsageShiftDetail,
    UsageShiftStored,
)

# Ручки браузера: суммы по проекту и список смен. Токена у них нет — приложение ходит
# на свой же origin, а суммы расхода не секрет, в отличие от реестра с ботами.
router = APIRouter(prefix="/api", tags=["usage"])

# Машинная ручка: смену присылает harness. Токен надстройки — тот же, что у реестра и
# пресетов (`X-Registry-Token`): второго секрета в надстройке нет.
machine_router = APIRouter(
    prefix="/api/usage",
    tags=["usage"],
    dependencies=[Depends(require_registry_token)],
)

DbSession = Annotated[Session, Depends(get_db)]

# ── Тексты отказов контракта ───────────────────────────────────────────────────
# Дословно из таблицы контракта (#57): harness показывает их человеку, поэтому тексты
# не сочиняются на месте и меняются только вместе с контрактом.
PROJECT_REF_REQUIRED = "Укажите проект смены"
SHIFT_KEY_REQUIRED = "Укажите ключ смены"
SHIFT_TIME_INVALID = "Смена должна иметь начало и конец"
REASON_INVALID = "Причина закрытия смены указывается как window или manual"
SESSION_IDENTITY_REQUIRED = "Сессия без роли или id"
NEGATIVE_COST = "Отрицательный расход"
TOO_MANY_SESSIONS = "Слишком много сессий в смене"
SHIFT_NOT_FOUND = "Смена не найдена"
SHIFT_WRITE_RACE = "Смену не удалось записать: одновременная отправка"

# Защиты от сломанного отправителя, а не отказы для человека: их в таблице контракта
# нет, и приходят они только от машины. Без них пришлось бы отвечать `500`: значение
# сверх колонки ломает вставку на PostgreSQL, а строка вместо числа — сравнение.
SESSION_NUMBERS_INVALID = "Расход по сессии указывается целым неотрицательным числом"
FIELD_TOO_LONG = "Значение поля «{field}» длиннее {limit} символов"
# Сумма сверх разрядности колонки: `Numeric(14,6)` держит восемь знаков до точки, а
# `1e30` ломает уже `Decimal.quantize` — оба случая иначе стали бы `500`.
COST_TOO_LARGE = "Расход по сессии больше допустимого"

# Верхняя граница денег — ровно то, что влезает в `Numeric(14,6)`.
MAX_COST = Decimal("99999999.999999")

# Размеры колонок моделей: проверяются до вставки, иначе PostgreSQL ответил бы `500`.
PROJECT_REF_MAX = 64
PROJECT_TITLE_MAX = 200
SHIFT_KEY_MAX = 64
ROLE_MAX = 64
SESSION_MAX = 100
SOURCE_MAX = 50
ISSUE_TITLE_MAX = 300

# Причины закрытия смены — те же две, что различает harness (`FINISH`).
REASONS = ("window", "manual")

# Сколько сессий принимает одна смена. Потолок нужен, чтобы одно тело не превращалось
# в многомегабайтную вставку; смена на 500 сессий — это уже не смена, а месяц.
MAX_SESSIONS = 500


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который harness показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


@dataclass(frozen=True)
class _SessionDraft:
    """Разобранная сессия смены: значения уже приведены к типам колонок."""

    role: str
    session: str
    source: str | None
    issue_number: int | None
    issue_title: str | None
    turns: int
    tokens_in: int
    tokens_out: int
    tokens_cache_read: int
    tokens_cache_write: int


@dataclass(frozen=True)
class _ShiftDraft:
    """Разобранная смена: всё, что нужно для строки `usage_shifts` и её сессий.

    Цены смены сюда не входят: их знает проект, а не тело смены. Снимок цен берётся из
    проекта в момент записи (см. `store_shift`).
    """

    project_ref: str
    project_title: str
    shift_key: str
    started_at: datetime
    ended_at: datetime
    reason: str
    sessions: list[_SessionDraft] = field(default_factory=list)


def _text(value: Any) -> str | None:
    """Строка после обрезки пробелов; `None`, если значения нет или оно не строка."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _bounded(value: str, limit: int, name: str) -> str:
    """Строка короче колонки. Длиннее — отказ отправителю, а не `500` от базы."""
    if len(value) > limit:
        raise _reject(FIELD_TOO_LONG.format(field=name, limit=limit))
    return value


def _count(value: Any, negative: str = NEGATIVE_COST) -> int:
    """Счётчик (токены, ходы): целое неотрицательное число или отказ.

    JSON не различает `12` и `12.0` — отправитель вправе прислать второе, а `12.5`
    уже не счётчик. Отрицательные токены — отказ контракта «Отрицательный расход»;
    для ходов, которых в таблице контракта нет, отрицательное значение — та же защита,
    что строка вместо числа.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _reject(SESSION_NUMBERS_INVALID)
    if value < 0:
        raise _reject(negative)
    if isinstance(value, float) and not value.is_integer():
        raise _reject(SESSION_NUMBERS_INVALID)
    return int(value)


def _moment(value: Any) -> datetime | None:
    """Момент времени из ISO-строки; наивное время считается UTC."""
    text = _text(value)
    if text is None:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _rates_snapshot(project: Project | None) -> dict[str, float]:
    """Снимок цен проекта для колонки `usage_shifts.rates`: по какой цене считалась смена.

    Проекта в вебе нет — снимок пустой: цены не было, и выдумывать нули в четыре поля
    значило бы утверждать, что смена считалась по нулевому прайсу. Пустой объект читается
    как «цены не было» (схема детализации даёт на него нули).
    """
    if project is None:
        return {}
    return {
        "inputUsdPerM": float(project.price_input),
        "cacheReadUsdPerM": float(project.price_cache_read),
        "cacheWriteUsdPerM": float(project.price_cache_write),
        "outputUsdPerM": float(project.price_output),
    }


def _session_amount(item: _SessionDraft, prices: Mapping[str, object] | None) -> Decimal:
    """Сумма одной сессии по ценам проекта: `None` — проекта нет, значит сумма ноль.

    Формула и округление — из `app.money.amount_for`, здесь только выбор цен: своей
    реализации «токены × цена / 1 000 000» в ручке нет, иначе она разошлась бы с ручными
    записями того же журнала.
    """
    if prices is None:
        return Decimal(0)
    return amount_for(
        {
            "tokens_input": item.tokens_in,
            "tokens_output": item.tokens_out,
            "tokens_cache_read": item.tokens_cache_read,
            "tokens_cache_write": item.tokens_cache_write,
        },
        prices,
    )


def _guard_cost(amount: Decimal) -> Decimal:
    """Сумма в разрядности колонки `Numeric(14,6)`: больше — отказ отправителю, а не `500`.

    Тело смены больше не приносит сумму, поэтому проверять её разрядность стало делом
    сервера: миллиард токенов по цене с десятью знаками до точки даёт больше, чем колонка
    держит, и PostgreSQL ответил бы `numeric field overflow` на теле, которое прошло все
    проверки формы.
    """
    if amount > MAX_COST:
        raise _reject(COST_TOO_LARGE)
    return amount


def _session(value: Any) -> _SessionDraft:
    """Разобрать сессию смены или отказать `422` по закрытому набору отказов.

    `cost_usd` в сессии больше не читается: сумму считает сервер по ценам проекта.
    Неизвестные поля тела вообще не разбираются — так же принимаются и `rates`, и
    `totals`: это старый формат, и `422` на нём терял бы расход из очереди отдела.
    """
    if not isinstance(value, dict):
        raise _reject(SESSION_IDENTITY_REQUIRED)
    role = _text(value.get("role"))
    session = _text(value.get("session"))
    if role is None or session is None:
        raise _reject(SESSION_IDENTITY_REQUIRED)

    tokens = value.get("tokens")
    tokens = tokens if isinstance(tokens, dict) else {}
    # Нет ключа — ноль: токены это счётчики, и «не пришло» значит «не израсходовано».
    counts = {
        "tokens_in": _count(tokens.get("in", 0)),
        "tokens_out": _count(tokens.get("out", 0)),
        "tokens_cache_read": _count(tokens.get("cacheRead", 0)),
        "tokens_cache_write": _count(tokens.get("cacheWrite", 0)),
    }

    turns = _count(value.get("turns", 0), negative=SESSION_NUMBERS_INVALID)

    issue_number = value.get("issue_number")
    if isinstance(issue_number, bool) or not isinstance(issue_number, int):
        issue_number = None
    issue_title = _text(value.get("issue_title"))
    source = _text(value.get("source"))

    return _SessionDraft(
        role=_bounded(role, ROLE_MAX, "role"),
        session=_bounded(session, SESSION_MAX, "session"),
        source=_bounded(source, SOURCE_MAX, "source") if source else None,
        issue_number=issue_number,
        issue_title=_bounded(issue_title, ISSUE_TITLE_MAX, "issue_title") if issue_title else None,
        turns=turns,
        **counts,
    )


def _validated(payload: Any) -> _ShiftDraft:
    """Разобрать документ смены; порядок проверок — из докстринга модуля."""
    if not isinstance(payload, dict):
        raise _reject(PROJECT_REF_REQUIRED)

    project_ref = _text(payload.get("project_ref"))
    if project_ref is None:
        raise _reject(PROJECT_REF_REQUIRED)
    project_ref = _bounded(project_ref, PROJECT_REF_MAX, "project_ref")
    # Название проекта — подпись для человека, а не ключ: пустое заменяется id.
    project_title = _bounded(
        _text(payload.get("project_title")) or project_ref,
        PROJECT_TITLE_MAX,
        "project_title",
    )

    shift_key = _text(payload.get("shift_key"))
    if shift_key is None:
        raise _reject(SHIFT_KEY_REQUIRED)
    shift_key = _bounded(shift_key, SHIFT_KEY_MAX, "shift_key")

    started_at = _moment(payload.get("started_at"))
    ended_at = _moment(payload.get("ended_at"))
    # Один отказ на оба случая — «нет конца», «не разобрано» и «конец раньше начала»:
    # в таблице контракта это одна строка, и различать их человеку незачем.
    if started_at is None or ended_at is None or ended_at < started_at:
        raise _reject(SHIFT_TIME_INVALID)

    reason = _text(payload.get("reason"))
    if reason not in REASONS:
        raise _reject(REASON_INVALID)

    raw_sessions = payload.get("sessions")
    if raw_sessions is None:
        raw_sessions = []
    if not isinstance(raw_sessions, list):
        raise _reject(TOO_MANY_SESSIONS)
    if len(raw_sessions) > MAX_SESSIONS:
        raise _reject(TOO_MANY_SESSIONS)
    sessions = [_session(item) for item in raw_sessions]

    return _ShiftDraft(
        project_ref=project_ref,
        project_title=project_title,
        shift_key=shift_key,
        started_at=started_at,
        ended_at=ended_at,
        reason=reason,
        sessions=sessions,
    )


def _shift_numbers(shift: UsageShift) -> dict[str, Any]:
    """Числа смены для ответа `POST`: то, что журнал насчитал по принятым сессиям."""
    return {
        "shift_id": shift.id,
        "sessions_count": shift.sessions_count,
        "cost_usd": shift.cost_usd,
    }


def _already_stored(shift: UsageShift, skipped: int) -> JSONResponse:
    """Повтор смены: `200` вместо `201` — новых строк журнал не завёл.

    `201` зарезервирован за первой записью смены: по нему harness отличает «смена
    легла» от «смена уже была», и на `200` он считает отправку состоявшейся.
    """
    body = UsageShiftStored(
        **_shift_numbers(shift),
        accepted=0,
        skipped=skipped,
        changed=False,
    )
    return JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump(mode="json"))


def _tokens(row: UsageShift | UsageSession) -> dict[str, int]:
    """Токены строки журнала в форме контракта `{in, out, cacheRead, cacheWrite}`."""
    return {
        "in": row.tokens_in,
        "out": row.tokens_out,
        "cacheRead": row.tokens_cache_read,
        "cacheWrite": row.tokens_cache_write,
    }


def _shift_row(shift: UsageShift) -> dict[str, Any]:
    """Смена для списка: без сессий и снимка цен, но с итогами по ним."""
    return {
        "id": shift.id,
        "shift_key": shift.shift_key,
        "started_at": shift.started_at,
        "ended_at": shift.ended_at,
        "reason": shift.reason,
        "sessions_count": shift.sessions_count,
        "tokens": _tokens(shift),
        "cost_usd": shift.cost_usd,
    }


def _session_row(session: UsageSession) -> dict[str, Any]:
    """Сессия для детализации смены."""
    return {
        "role": session.role,
        "session": session.session,
        "source": session.source,
        "issue_number": session.issue_number,
        "issue_title": session.issue_title,
        "turns": session.turns,
        "tokens": _tokens(session),
        "cost_usd": session.cost_usd,
    }


def _find_shift(db: Session, project_ref: str, shift_key: str) -> UsageShift | None:
    """Смена по паре `(project_ref, shift_key)` — ключу идемпотентности журнала."""
    return db.scalars(
        select(UsageShift).where(
            UsageShift.project_ref == project_ref,
            UsageShift.shift_key == shift_key,
        )
    ).one_or_none()


def _known_sessions(db: Session, project_ref: str) -> set[str]:
    """Id сессий, уже вошедших в суммы проекта, — что нельзя посчитать второй раз."""
    return set(
        db.scalars(
            select(UsageSession.session).where(UsageSession.project_ref == project_ref)
        ).all()
    )


@machine_router.post(
    "/shifts",
    response_model=UsageShiftStored,
    status_code=status.HTTP_201_CREATED,
    summary="Приём смены от harness",
    responses={
        status.HTTP_200_OK: {
            "model": UsageShiftStored,
            "description": (
                "Смена `(project_ref, shift_key)` уже в журнале: `changed: false`, "
                "числа — текущие числа смены, новых сессий не принято."
            ),
        },
        status.HTTP_401_UNAUTHORIZED: {"description": "Токен надстройки не принят."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": "Документ смены не прошёл проверку формы; текст отказа — в `detail`.",
        },
    },
)
def store_shift(
    db: DbSession,
    payload: Annotated[Any, Body()],
) -> Any:
    """`201` — смена заведена; `200` с `changed: false` — она уже была.

    Сумма смены считается здесь, по ценам проекта в момент записи; в `usage_shifts.rates`
    кладётся их снимок, поэтому смена прайса не переписывает прошлые деньги. Сессия, уже
    вошедшая в суммы проекта (в том числе «продолженный диалог» из прошлой смены),
    пропускается: `skipped` в ответе. Суммы смены считаются по **принятым** сессиям,
    поэтому повторная отправка той же смены не прибавляет денег проекту.
    """
    draft = _validated(payload)

    existing = _find_shift(db, draft.project_ref, draft.shift_key)
    if existing is not None:
        return _already_stored(existing, len(draft.sessions))

    known = _known_sessions(db, draft.project_ref)
    accepted = []
    skipped = 0
    for item in draft.sessions:
        # Повтор внутри одного тела считается так же, как повтор между сменами.
        if item.session in known:
            skipped += 1
            continue
        known.add(item.session)
        accepted.append(item)

    # Цены смены — цены проекта в момент записи. Проекта нет — смену принимаем с нулевой
    # суммой: отказ выбросил бы её из очереди отдела и потерял бы расход навсегда.
    project = find_project_by_ref(db, draft.project_ref)
    prices = prices_of(project) if project is not None else None
    amounts = [(item, _guard_cost(_session_amount(item, prices))) for item in accepted]
    total_cost = _guard_cost(sum((amount for _, amount in amounts), Decimal(0)))

    shift = UsageShift(
        project_ref=draft.project_ref,
        project_title=draft.project_title,
        shift_key=draft.shift_key,
        started_at=draft.started_at,
        ended_at=draft.ended_at,
        reason=draft.reason,
        sessions_count=len(accepted),
        tokens_in=sum(item.tokens_in for item in accepted),
        tokens_out=sum(item.tokens_out for item in accepted),
        tokens_cache_read=sum(item.tokens_cache_read for item in accepted),
        tokens_cache_write=sum(item.tokens_cache_write for item in accepted),
        cost_usd=total_cost,
        rates=_rates_snapshot(project),
    )
    db.add(shift)
    try:
        # `flush` внутри `try`: уникальный индекс `(project_ref, shift_key)` срабатывает
        # уже здесь, а не на `commit`, и вторая одновременная отправка получает штатный
        # ответ вместо `500`. Сессиям нужен `shift.id`, поэтому вставка смены идёт первой.
        db.flush()
        for item, amount in amounts:
            db.add(
                UsageSession(
                    shift_id=shift.id,
                    project_ref=draft.project_ref,
                    issue_number=item.issue_number,
                    issue_title=item.issue_title,
                    role=item.role,
                    session=item.session,
                    source=item.source,
                    turns=item.turns,
                    tokens_in=item.tokens_in,
                    tokens_out=item.tokens_out,
                    tokens_cache_read=item.tokens_cache_read,
                    tokens_cache_write=item.tokens_cache_write,
                    cost_usd=amount,
                )
            )
        if project is not None and total_cost:
            # Итог проекта прибавляется в той же транзакции, что и смена: иначе «смена
            # легла, а денег в журнале нет». Приращение в SQL, а не чтением-записью:
            # две одновременные смены иначе перезаписали бы увеличение друг друга.
            db.execute(
                update(Project)
                .where(Project.id == project.id)
                .values(total_cost=Project.total_cost + total_cost)
            )
        db.commit()
    except IntegrityError as error:
        # Параллельная отправка обогнала нас: индекс не пустил вторую строку. Если это
        # та же смена — отвечаем как на повторный `POST`; если конфликт по сессии —
        # смене записаться некуда, и это `409` «одновременная отправка».
        db.rollback()
        existing = _find_shift(db, draft.project_ref, draft.shift_key)
        if existing is None:
            raise HTTPException(status.HTTP_409_CONFLICT, SHIFT_WRITE_RACE) from error
        return _already_stored(existing, len(draft.sessions))
    db.refresh(shift)
    return UsageShiftStored(
        **_shift_numbers(shift),
        accepted=len(accepted),
        skipped=skipped,
        changed=True,
    )


@router.get(
    "/projects/{project_ref}/usage",
    response_model=UsageProjectUsage,
    summary="Смены проекта и суммы по нему",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Смен нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def project_usage(project_ref: str, db: DbSession) -> dict[str, Any]:
    """Смены проекта от новых к старым и итоги по ним.

    `404` — у проекта нет ни одной смены. Это не «проекта нет в реестре»: журнал живёт
    отдельно от реестра, и проект без смен просто ещё ничего не потратил.
    """
    shifts = db.scalars(
        select(UsageShift)
        .where(UsageShift.project_ref == project_ref)
        .order_by(UsageShift.ended_at.desc(), UsageShift.id.desc())
    ).all()
    if not shifts:
        raise HTTPException(status.HTTP_404_NOT_FOUND, PROJECT_NOT_FOUND)
    return {
        "project_ref": project_ref,
        # Имя проекта меняется, а смены остаются: подписью служит последняя.
        "project_title": shifts[0].project_title,
        "totals": {
            "shifts": len(shifts),
            "sessions": sum(shift.sessions_count for shift in shifts),
            "tokens": {
                "in": sum(shift.tokens_in for shift in shifts),
                "out": sum(shift.tokens_out for shift in shifts),
                "cacheRead": sum(shift.tokens_cache_read for shift in shifts),
                "cacheWrite": sum(shift.tokens_cache_write for shift in shifts),
            },
            "cost_usd": sum((shift.cost_usd for shift in shifts), Decimal(0)),
        },
        "shifts": [_shift_row(shift) for shift in shifts],
    }


@router.get(
    "/usage/shifts/{shift_id}",
    response_model=UsageShiftDetail,
    summary="Одна смена с детализацией по сессиям",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Смены нет: «{SHIFT_NOT_FOUND}»."},
    },
)
def shift_detail(shift_id: int, db: DbSession) -> dict[str, Any]:
    """Смена целиком: снимок цен проекта и сессии по порядку записи."""
    shift = db.get(UsageShift, shift_id)
    if shift is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SHIFT_NOT_FOUND)
    row = _shift_row(shift)
    row.update(
        {
            "project_ref": shift.project_ref,
            "project_title": shift.project_title,
            "rates": shift.rates,
            "sessions": [_session_row(session) for session in shift.sessions],
        }
    )
    return row


@router.get(
    "/usage/projects",
    response_model=list[UsageProjectTotal],
    summary="Проекты со суммами расхода",
)
def usage_projects(db: DbSession) -> Sequence[dict[str, Any]]:
    """Строка на проект: смены, сессии, токены, деньги и время последней смены.

    Считается в питоне, а не в SQL: строк журнала столько же, сколько смен у отдела,
    а группировка в SQL разошлась бы между PostgreSQL и SQLite в тестах.
    """
    shifts = db.scalars(
        select(UsageShift).order_by(UsageShift.ended_at.desc(), UsageShift.id.desc())
    ).all()
    # Порядок первого появления и есть порядок ответа: смены уже от новых к старым,
    # поэтому проект встаёт на место своей последней смены.
    projects: dict[str, dict[str, Any]] = {}
    for shift in shifts:
        row = projects.get(shift.project_ref)
        if row is None:
            projects[shift.project_ref] = {
                "project_ref": shift.project_ref,
                "project_title": shift.project_title,
                "shifts": 1,
                "sessions": shift.sessions_count,
                "tokens": _tokens(shift),
                "cost_usd": shift.cost_usd,
                "last_shift_at": shift.ended_at,
            }
            continue
        row["shifts"] += 1
        row["sessions"] += shift.sessions_count
        tokens = _tokens(shift)
        for key in ("in", "out", "cacheRead", "cacheWrite"):
            row["tokens"][key] += tokens[key]
        row["cost_usd"] += shift.cost_usd
        # `last_shift_at` первой строки проекта уже самый поздний: смены отсортированы
        # по `ended_at desc`, и сравнивать его с каждой следующей незачем.
    # Ответ по деньгам убыванию: сверху то, что потратило больше всего.
    return sorted(projects.values(), key=lambda row: (-row["cost_usd"], row["project_ref"]))
