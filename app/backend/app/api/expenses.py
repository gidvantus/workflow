"""Ручки журнала расходов проекта: объединённый список с итогом и запись за день.

Журнал один на два источника факта. Человек вводит запись формой (`POST`), смену пишет
отдел сам (`POST /api/usage/shifts`, см. `app.api.usage`), а читаются обе половины одной
ручкой: вкладка «Расходы» показывает их одной ведомостью, и второго экрана у денег нет.

Путь вложен в проект (`/api/projects/{project_id}/expenses`), поэтому обе ручки сначала
проверяют, что проект жив: несуществующий или мягко удалённый проект — это `404` с тем
же текстом, что у остальных вложенных ручек. Проверка берётся из `app.api.projects`, а не
переписывается здесь.

Сумму считает **только сервер**, и считает её одна функция (`app.money.amount_for`):
количества, умноженные на цены проекта за 1 000 000 токенов, делённые на миллион и
округлённые до шести знаков `ROUND_HALF_UP` один раз на строку. Итог проекта — сумма уже
округлённых сумм обеих половин, поэтому сумма строк на экране сходится с итогом.

Итог проекта прибавляется SQL-инкрементом в той же транзакции, что и вставка: два
одновременных `POST` не теряют сумму, а чтение-изменение-запись в Python потеряло бы.
Пересчёт строки и удаление (#88) итог не прибавляют, а **пересобирают суммой строк**
(`app.project_totals.store_project_total`): после удаления или пересчёта инкремент
оставил бы в колонке прежнее число. Обе ручки идут одной транзакцией и коммитят сами.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.
"""

import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.api.projects import (
    PROJECT_NOT_FOUND,
    _get_alive_project,
    prices_of,
)
from app.api.usage import (
    MAX_COST,
    SHIFT_NOT_FOUND,
    rates_snapshot,
)
from app.db import get_db
from app.models.expense import ProjectExpense
from app.models.project import Project
from app.models.usage_session import UsageSession
from app.models.usage_shift import UsageShift
from app.money import TOKEN_PRICE_FIELDS, amount_for
from app.project_refs import shifts_of_project
from app.project_totals import store_project_total
from app.schemas.expense import (
    MANUAL_KIND,
    SHIFT_KIND,
    ExpenseCreate,
    ExpenseDeleted,
    ExpenseListResponse,
    ExpenseRecalculated,
    JournalEntry,
    JournalTokensInput,
)
from app.schemas.usage import usage_tokens

router = APIRouter(prefix="/api/projects/{project_id}/expenses", tags=["expenses"])

# Сессия на запрос: одна и та же зависимость у обеих ручек.
DbSession = Annotated[Session, Depends(get_db)]

# Дата приходит строкой `ГГГГ-ММ-ДД`: формат проверяется шаблоном, календарная
# существующая дата — разбором (`2026-02-30` шаблон пропускает, разбор — нет).
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Количество — целое без знака. Схема запроса пропускает свободные типы, поэтому
# строку вида `"1500000"` разбирает ручка, а `"1 500"` и `"abc"` — тот же отказ.
TOKENS_PATTERN = re.compile(r"^\d+$")

# Потолок одного количества: `BIGINT` больше, но 10^12 токенов за день — уже заведомо
# ошибка ввода, а не расход.
TOKENS_MAX = 1_000_000_000_000

# Знаков в потолке: строка цифр длиннее — уже за диапазоном. Разбирать её незачем, и
# нельзя: Python 3.12 отказывается разбирать строку длиннее 4300 цифр (`ValueError`
# из-за `sys.set_int_max_str_digits`), поэтому длина проверяется до `int()` — иначе
# тело с длинной строкой цифр давало бы необработанный `500` вместо отказа контракта.
TOKENS_MAX_DIGITS = len(str(TOKENS_MAX))

# Поля контракта и колонки, в которых живут те же количества: ключ `in` — слово Python,
# атрибутом к нему не обратиться, поэтому пара «ключ контракта → колонка» выписана здесь.
CONTRACT_TOKENS: tuple[tuple[str, str], ...] = (
    ("in", "tokens_input"),
    ("out", "tokens_output"),
    ("cacheRead", "tokens_cache_read"),
    ("cacheWrite", "tokens_cache_write"),
)

SPENT_ON_INVALID = "Дата указывается как ГГГГ-ММ-ДД, например 2026-11-05"
TOKENS_INVALID = "Количество токенов указывается целым неотрицательным числом"
NO_TOKENS = "Укажите хотя бы одно количество токенов"
NO_PRICES = "Цены проекта не заполнены"
ROW_NOT_FOUND = "Запись не найдена"
COST_OVERFLOW = "Сумма строки слишком велика для журнала — проверьте цены проекта"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def validate_spent_on(value: object) -> date:
    """Дата расхода: вернуть `date` или отказать `422` текстом про формат.

    Принимается строго строка `ГГГГ-ММ-ДД`: `05.11.2026`, `2026-11-5` и не строка
    (`20261105`, `null`) — тот же отказ, что и несуществующее `2026-02-30`.
    """
    if not isinstance(value, str):
        raise _reject(SPENT_ON_INVALID)
    text = value.strip()
    if not DATE_PATTERN.match(text):
        raise _reject(SPENT_ON_INVALID)
    try:
        return date.fromisoformat(text)
    except ValueError as error:
        raise _reject(SPENT_ON_INVALID) from error


def validate_tokens(value: object) -> int:
    """Количество токенов: `0 ≤ n ≤ 10^12`, иначе отказ `422` текстом про формат.

    Схема запроса пропускает свободные типы, поэтому разбор здесь: целое число,
    дробное только с нулевой дробной частью (иначе это не количество) и строка из цифр
    не длиннее потолка. Всё остальное — `12.5`, `"1 500"`, `"abc"`, `null` — отказ
    контракта; булево отказывает тоже здесь: в объединении типов схемы `bool` стоит
    первым, поэтому `true` доходит сюда как `bool`, а не превращается в `1`.
    """
    if isinstance(value, bool) or value is None:
        raise _reject(TOKENS_INVALID)
    if isinstance(value, float):
        if not value.is_integer():
            raise _reject(TOKENS_INVALID)
        number = int(value)
    elif isinstance(value, int):
        number = value
    elif isinstance(value, str):
        text = value.strip()
        if not TOKENS_PATTERN.match(text) or len(text) > TOKENS_MAX_DIGITS:
            raise _reject(TOKENS_INVALID)
        number = int(text)
    else:
        raise _reject(TOKENS_INVALID)
    if number < 0 or number > TOKENS_MAX:
        raise _reject(TOKENS_INVALID)
    return number


def validate_token_counts(tokens: JournalTokensInput | None) -> dict[str, int]:
    """Четыре количества записи по именам колонок или отказ `422`.

    Все четыре количества обязательны: пропущенное поле — отказ текстом про количество,
    а не ноль по умолчанию. Пустое поле формы уходит нулём с фронта, и это разные вещи:
    ноль — «за этот вид токенов не платили», пропуск — «тело собрано не по контракту».

    Пустой блок количеств — тот же случай, что и отсутствие блока: в нём нет ни одного
    поля, то есть человек не указал ни одного количества, и текст отказа — «Укажите хотя
    бы одно количество токенов», а не текст про формат числа. Половина заполненного блока
    — наоборот, отказ контракта: остальные три поля пропущены, и это уже не «пустая форма».
    """
    if tokens is None:
        raise _reject(NO_TOKENS)
    given = tokens.as_mapping()
    if all(value is None for value in given.values()):
        raise _reject(NO_TOKENS)
    return {
        token_field: validate_tokens(given[contract_key])
        for contract_key, token_field in CONTRACT_TOKENS
    }


def _prices_are_empty(project: Project) -> bool:
    """Все четыре цены нулевые: писать расход не по чему — это отказ, а не нулевая запись."""
    return all(
        Decimal(str(getattr(project, price_field))) == 0 for _, price_field in TOKEN_PRICE_FIELDS
    )


def _expense_counts(expense: ProjectExpense) -> dict[str, int]:
    """Количества ручной записи по именам колонок — вход `app.money.amount_for`.

    Ключи — колонки формулы денег (`tokens_input`…), а не поля контракта (`in`…): так
    переименование ключа ответа не меняет расчёт.
    """
    return {
        "tokens_input": expense.tokens_input,
        "tokens_output": expense.tokens_output,
        "tokens_cache_read": expense.tokens_cache_read,
        "tokens_cache_write": expense.tokens_cache_write,
    }


def _session_counts(session: UsageSession) -> dict[str, int]:
    """Количества сессии смены по именам колонок формулы денег.

    У сессии колонки названы короче (`tokens_in`), чем у ручной записи (`tokens_input`):
    пара «колонка → ключ формулы» выписана здесь, чтобы `amount_for` получал один и тот
    же словарь от обеих половин журнала.
    """
    return {
        "tokens_input": session.tokens_in,
        "tokens_output": session.tokens_out,
        "tokens_cache_read": session.tokens_cache_read,
        "tokens_cache_write": session.tokens_cache_write,
    }


def _find_expense(db: Session, project: Project, row_id: int) -> ProjectExpense:
    """Ручная запись этого проекта или `404 «Запись не найдена»`.

    Чужая запись — тот же текст, что и несуществующая: по id чужой строки нельзя узнать,
    что она вообще есть, — иначе журнал одного проекта рассказывал бы о другом.
    """
    expense = db.get(ProjectExpense, row_id)
    if expense is None or expense.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROW_NOT_FOUND)
    return expense


def _find_shift(db: Session, project: Project, row_id: int) -> UsageShift:
    """Смена этого проекта или `404 «Смена не найдена»`.

    Ищется условием журнала (`shifts_of_project`), а не по одному ключу: смена,
    записанная под прежним ключом проекта, остаётся сменой этого проекта. Чужая смена —
    тоже «Смена не найдена», а не «Запись не найдена»: у половины свой текст.
    """
    shift = db.scalars(
        select(UsageShift).where(
            UsageShift.id == row_id,
            shifts_of_project(project),
        )
    ).first()
    if shift is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SHIFT_NOT_FOUND)
    return shift


def _utc(moment: datetime) -> datetime:
    """Момент в UTC.

    В PostgreSQL время приходит с часовым поясом, в SQLite (тесты) — наивным. Сравнивать
    такие значения между собой нельзя: `TypeError` на первом же сравнении. Наивное время
    считается UTC — так его и пишет база.
    """
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _manual_entry(expense: ProjectExpense) -> JournalEntry:
    """Строка журнала ручной записи: без интервала и числа сессий."""
    return JournalEntry(
        kind=MANUAL_KIND,
        id=expense.id,
        spent_on=expense.spent_on,
        tokens=usage_tokens(
            expense.tokens_input,
            expense.tokens_output,
            expense.tokens_cache_read,
            expense.tokens_cache_write,
        ),
        amount=expense.amount,
    )


def _shift_entry(shift: UsageShift) -> JournalEntry:
    """Строка журнала смены: день — дата `ended_at` в UTC, плюс интервал и сессии."""
    ended_at = _utc(shift.ended_at)
    return JournalEntry(
        kind=SHIFT_KIND,
        id=shift.id,
        spent_on=ended_at.date(),
        tokens=usage_tokens(
            shift.tokens_in,
            shift.tokens_out,
            shift.tokens_cache_read,
            shift.tokens_cache_write,
        ),
        amount=shift.cost_usd,
        started_at=_utc(shift.started_at),
        ended_at=ended_at,
        reason=shift.reason,
        sessions_count=shift.sessions_count,
    )


def _merged(
    expenses: list[ProjectExpense],
    shifts: list[UsageShift],
) -> list[JournalEntry]:
    """Обе половины одним списком в порядке `spent_on DESC, sort_at DESC, id DESC`.

    `sort_at` — момент, по которому строка встаёт внутри дня: у ручной записи `created_at`
    (время ввода), у смены `ended_at` (время закрытия). Сортировка здесь, а не в SQL:
    строки лежат в двух таблицах, а их общий порядок задан полями, которых в базе нет
    рядом, — объединение запросов дало бы второй экземпляр правил порядка.
    """
    rows: list[tuple[date, datetime, int, JournalEntry]] = []
    for expense in expenses:
        entry = _manual_entry(expense)
        rows.append((entry.spent_on, _utc(expense.created_at), expense.id, entry))
    for shift in shifts:
        entry = _shift_entry(shift)
        rows.append((entry.spent_on, _utc(shift.ended_at), shift.id, entry))
    rows.sort(key=lambda row: (row[0], row[1], row[2]), reverse=True)
    return [row[3] for row in rows]


@router.get(
    "",
    response_model=ExpenseListResponse,
    response_model_exclude_none=True,
    summary="Журнал расходов проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def list_expenses(project_id: int, db: DbSession) -> ExpenseListResponse:
    """Обе половины журнала одного проекта и хранимый итог проекта.

    Смены ищутся по всем ключам проекта, какие у него были (`project_ref_keys`): пока
    кода нет, реестр зовёт его `str(id)`, а с появлением кода — кодом, и смены, записанные
    под прежним ключом, остаются в этом журнале. По одному текущему ключу итог проекта
    (в который деньги тех смен уже прибавлены) перестал бы сходиться с суммой строк.
    Внешнего ключа у смен нет: реестр отдела существует и без строки проекта в вебе.

    Итог — `projects.total_cost`, в который прибавляют обе половины, а не сумма
    прочитанных строк: пустой журнал отдаёт `{"total": "0.000000", "items": []}`.
    """
    project = _get_alive_project(db, project_id)
    expenses: list[ProjectExpense] = list(
        db.scalars(select(ProjectExpense).where(ProjectExpense.project_id == project_id)).all()
    )
    shifts: list[UsageShift] = list(
        db.scalars(select(UsageShift).where(shifts_of_project(project))).all()
    )
    return ExpenseListResponse(
        total=project.total_cost,
        items=_merged(expenses, shifts),
    )


@router.post(
    "",
    response_model=JournalEntry,
    response_model_exclude_none=True,
    status_code=status.HTTP_201_CREATED,
    summary="Запись расхода за день",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": (
                f"Дата не по формату: «{SPENT_ON_INVALID}»; количество не целое или вне "
                f"диапазона: «{TOKENS_INVALID}»; все количества нулевые: «{NO_TOKENS}»; "
                f"у проекта нет цен: «{NO_PRICES}»."
            ),
        },
    },
)
def create_expense(project_id: int, payload: ExpenseCreate, db: DbSession) -> JournalEntry:
    """`201` со строкой журнала; сумма и инкремент итога — на сервере.

    Порядок проверок — контракт: сначала `404` (проекта нет или он мягко удалён), потом
    формат даты, количества, «хотя бы одно количество больше нуля» и только затем «у
    проекта нет цен»: сообщение «Цены проекта не заполнены» пользователь видит уже после
    того, как заполнил количества, а не вместо этой проверки.
    """
    project = _get_alive_project(db, project_id)
    spent_on = validate_spent_on(payload.spent_on)
    tokens = validate_token_counts(payload.tokens)
    if all(value == 0 for value in tokens.values()):
        raise _reject(NO_TOKENS)
    if _prices_are_empty(project):
        raise _reject(NO_PRICES)

    expense = ProjectExpense(
        project_id=project.id,
        spent_on=spent_on,
        amount=amount_for(tokens, prices_of(project)),
        **tokens,
    )
    db.add(expense)
    # Итог прибавляется в SQL, а не чтением-изменением-записью в Python: два
    # одновременных `POST` иначе перезаписали бы увеличение друг друга.
    db.execute(
        update(Project)
        .where(Project.id == project.id)
        .values(total_cost=Project.total_cost + expense.amount)
    )
    db.commit()
    db.refresh(expense)
    return _manual_entry(expense)


@router.post(
    "/{kind}/{row_id}/recalculate",
    response_model=ExpenseRecalculated,
    response_model_exclude_none=True,
    summary="Пересчёт строки журнала по текущим ценам проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {
            "description": (
                f"Проекта нет: «{PROJECT_NOT_FOUND}»; ручной записи, неизвестного вида "
                f"строки или чужой записи нет: «{ROW_NOT_FOUND}»; смены нет или она "
                f"чужого проекта: «{SHIFT_NOT_FOUND}»."
            ),
        },
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": (
                f"У проекта нет цен: «{NO_PRICES}»; сумма после пересчёта не влезает в "
                f"журнал: «{COST_OVERFLOW}»."
            ),
        },
    },
)
def recalculate_expense(
    project_id: int,
    kind: str,
    row_id: int,
    db: DbSession,
) -> ExpenseRecalculated:
    """Пересчитать сумму одной строки по текущим ценам проекта.

    Порядок проверок — контракт: `404` проекта, `404` строки, «цены не заполнены» и
    только затем переполнение колонки. Пересчитывается **только сумма**: количества,
    дата, интервал, причина и тикет — факты, а не деньги, и не меняются. У смены
    пересчитывается и `cost_usd` каждой сессии, и снимок цен `rates` — иначе в строке
    осталась бы старая цена рядом с новой суммой.

    Сумма каждой строки считается `app.money.amount_for` по ценам проекта, то есть той
    же формулой, что и при записи; итог проекта пересобирается суммой строк журнала, а
    не приращением. Повторный пересчёт при неизменных ценах ничего не меняет.
    """
    project = _get_alive_project(db, project_id)
    prices = prices_of(project)

    if kind == MANUAL_KIND:
        expense = _find_expense(db, project, row_id)
        if _prices_are_empty(project):
            raise _reject(NO_PRICES)
        amount = amount_for(_expense_counts(expense), prices)
        if amount > MAX_COST:
            raise _reject(COST_OVERFLOW)
        expense.amount = amount
        total = store_project_total(db, project)
        db.commit()
        db.refresh(expense)
        return ExpenseRecalculated(item=_manual_entry(expense), total=total)

    if kind == SHIFT_KIND:
        shift = _find_shift(db, project, row_id)
        if _prices_are_empty(project):
            raise _reject(NO_PRICES)
        # Сначала считаются все суммы, и только потом что-то меняется: отказ на любой
        # сессии не должен оставить в смене половину нового прайса.
        amounts: list[tuple[UsageSession, Decimal]] = []
        for session in shift.sessions:
            amount = amount_for(_session_counts(session), prices)
            if amount > MAX_COST:
                raise _reject(COST_OVERFLOW)
            amounts.append((session, amount))
        total_cost = sum((amount for _, amount in amounts), Decimal(0))
        if total_cost > MAX_COST:
            raise _reject(COST_OVERFLOW)
        for session, amount in amounts:
            session.cost_usd = amount
        shift.cost_usd = total_cost
        shift.rates = rates_snapshot(project)
        total = store_project_total(db, project)
        db.commit()
        db.refresh(shift)
        return ExpenseRecalculated(item=_shift_entry(shift), total=total)

    raise HTTPException(status.HTTP_404_NOT_FOUND, ROW_NOT_FOUND)


@router.delete(
    "/{kind}/{row_id}",
    response_model=ExpenseDeleted,
    summary="Удаление строки журнала",
    responses={
        status.HTTP_404_NOT_FOUND: {
            "description": (
                f"Проекта нет: «{PROJECT_NOT_FOUND}»; ручной записи, неизвестного вида "
                f"строки или чужой записи нет: «{ROW_NOT_FOUND}»; смены нет или она "
                f"чужого проекта: «{SHIFT_NOT_FOUND}»."
            ),
        },
    },
)
def delete_expense(project_id: int, kind: str, row_id: int, db: DbSession) -> ExpenseDeleted:
    """Удалить строку журнала и пересобрать итог проекта суммой оставшихся строк.

    У смены сначала явно удаляются её сессии, потом сама смена: каскада у внешнего ключа
    `shift_id` нет, и без этого порядка база отклонила бы удаление. Восстановления нет —
    ни мягкого удаления, ни tombstone; откат возможен только дампом базы.

    Цены и токены удалению не нужны: оно не пересчитывает строку, а убирает её.
    """
    project = _get_alive_project(db, project_id)

    if kind == MANUAL_KIND:
        db.delete(_find_expense(db, project, row_id))
    elif kind == SHIFT_KIND:
        shift = _find_shift(db, project, row_id)
        db.execute(delete(UsageSession).where(UsageSession.shift_id == shift.id))
        db.delete(shift)
    else:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROW_NOT_FOUND)

    total = store_project_total(db, project)
    db.commit()
    return ExpenseDeleted(total=total)
