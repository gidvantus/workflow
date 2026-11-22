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

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.
"""

import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.projects import (
    PROJECT_NOT_FOUND,
    _get_alive_project,
    prices_of,
    project_ref,
)
from app.db import get_db
from app.models.expense import ProjectExpense
from app.models.project import Project
from app.models.usage_shift import UsageShift
from app.money import TOKEN_PRICE_FIELDS, amount_for
from app.schemas.expense import (
    MANUAL_KIND,
    SHIFT_KIND,
    ExpenseCreate,
    ExpenseListResponse,
    JournalEntry,
    JournalTokensInput,
)
from app.schemas.usage import UsageTokens

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


def _tokens(
    tokens_in: int,
    tokens_out: int,
    cache_read: int,
    cache_write: int,
) -> UsageTokens:
    """Блок количеств строки журнала — той же формы, что у документа смены."""
    return UsageTokens.model_validate(
        {
            "in": tokens_in,
            "out": tokens_out,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
        }
    )


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
        tokens=_tokens(
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
        tokens=_tokens(
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

    Смены ищутся по тому же ключу, что и в реестре отдела (`project_ref`: `code`, иначе
    `str(id)`), а не по внешнему ключу: журнал смен живёт без него, потому что реестр
    существует и без строки проекта в вебе.

    Итог — `projects.total_cost`, в который прибавляют обе половины, а не сумма
    прочитанных строк: пустой журнал отдаёт `{"total": "0.000000", "items": []}`.
    """
    project = _get_alive_project(db, project_id)
    expenses: list[ProjectExpense] = list(
        db.scalars(select(ProjectExpense).where(ProjectExpense.project_id == project_id)).all()
    )
    shifts: list[UsageShift] = list(
        db.scalars(select(UsageShift).where(UsageShift.project_ref == project_ref(project))).all()
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
