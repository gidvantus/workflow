"""Ручки журнала расходов проекта: список с итогом и запись за день.

Путь вложен в проект (`/api/projects/{project_id}/expenses`), поэтому обе ручки сначала
проверяют, что проект жив: несуществующий или мягко удалённый проект — это `404` с тем
же текстом, что у остальных вложенных ручек. Проверка берётся из `app.api.projects`, а не
переписывается здесь.

Сумму считает **только сервер**: в теле запроса её нет. `amount` = количества, умноженные
на цены проекта за 1 000 000 токенов, делённые на миллион и округлённые до копеек
`ROUND_HALF_UP` **один раз** на запись. Итог проекта — сумма уже округлённых сумм, поэтому
сумма строк на экране сходится с итогом копейка в копейку.

Итог проекта прибавляется SQL-инкрементом в той же транзакции, что и вставка записи:
два одновременных `POST` не теряют сумму, а чтение-изменение-запись в Python потеряло бы.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.
"""

import re
from collections.abc import Sequence
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.projects import PROJECT_NOT_FOUND, _get_alive_project
from app.db import get_db
from app.models.expense import ProjectExpense
from app.models.project import Project
from app.schemas.expense import ExpenseCreate, ExpenseListResponse, ExpenseResponse

router = APIRouter(prefix="/api/projects/{project_id}/expenses", tags=["expenses"])

# Сессия на запрос: одна и та же зависимость у обеих ручек.
DbSession = Annotated[Session, Depends(get_db)]

# Дата приходит строкой `ГГГГ-ММ-ДД`: формат проверяется шаблоном, календарная
# существующая дата — разбором (`2026-02-30` шаблон пропускает, разбор — нет).
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Потолок одного количества: `BIGINT` больше, но 10^12 токенов за день — уже заведомо
# ошибка ввода, а не расход.
TOKENS_MAX = 1_000_000_000_000

# Цены проекта — рубли за 1 000 000 токенов.
MILLION_TOKENS = Decimal(1_000_000)

# Деньги в базе лежат ровно с двумя знаками; округление — половина вверх.
AMOUNT_QUANTUM = Decimal("0.01")

# Четыре количества и их цены: порядок один и тот же в запросе, модели и ответе.
TOKEN_PRICE_FIELDS = (
    ("tokens_input", "price_input"),
    ("tokens_output", "price_output"),
    ("tokens_cache_read", "price_cache_read"),
    ("tokens_cache_write", "price_cache_write"),
)

SPENT_ON_INVALID = "Дата указывается как ГГГГ-ММ-ДД, например 2026-11-05"
TOKENS_INVALID = "Количество токенов указывается целым неотрицательным числом"
NO_TOKENS = "Укажите хотя бы одно количество токенов"
NO_PRICES = "Цены проекта не заполнены"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def validate_spent_on(value: str) -> date:
    """Дата расхода: вернуть `date` или отказать `422` текстом про формат.

    Принимается строго `ГГГГ-ММ-ДД`: `05.11.2026` и `2026-11-5` — тот же отказ, что и
    несуществующее `2026-02-30`.
    """
    text = value.strip()
    if not DATE_PATTERN.match(text):
        raise _reject(SPENT_ON_INVALID)
    try:
        return date.fromisoformat(text)
    except ValueError as error:
        raise _reject(SPENT_ON_INVALID) from error


def validate_tokens(value: int) -> int:
    """Количество токенов: `0 ≤ n ≤ 10^12`, иначе отказ `422` текстом про формат."""
    if value < 0 or value > TOKENS_MAX:
        raise _reject(TOKENS_INVALID)
    return value


def format_money(value: Decimal) -> str:
    """`Decimal("0.4")` из базы → `"0.40"`: деньги наружу уходят строкой с копейками."""
    return f"{Decimal(str(value)):.2f}"


def calculate_amount(project: Project, tokens: dict[str, int]) -> Decimal:
    """Сумма записи: количества × цены проекта / 1 000 000, округление один раз.

    Всё считается в `Decimal`: у цен шесть знаков после точки, и `float` дал бы на
    границе копейки другой результат. Итог проекта при этом не округляется повторно —
    он складывается из уже округлённых сумм записей.
    """
    total = Decimal(0)
    for token_field, price_field in TOKEN_PRICE_FIELDS:
        price = Decimal(str(getattr(project, price_field)))
        total += Decimal(tokens[token_field]) * price
    return (total / MILLION_TOKENS).quantize(AMOUNT_QUANTUM, rounding=ROUND_HALF_UP)


def _prices_are_empty(project: Project) -> bool:
    """Все четыре цены нулевые: писать расход не по чему — это отказ, а не нулевая запись."""
    return all(
        Decimal(str(getattr(project, price_field))) == 0 for _, price_field in TOKEN_PRICE_FIELDS
    )


@router.get(
    "",
    response_model=ExpenseListResponse,
    summary="Журнал расходов проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def list_expenses(project_id: int, db: DbSession) -> ExpenseListResponse:
    """Записи только этого проекта и хранимый итог проекта.

    Порядок — `spent_on DESC, id DESC`: свежий день сверху, внутри дня последняя запись
    сверху. Итог — `projects.total_cost`, а не сумма прочитанных строк: пустой журнал
    отдаёт `{"total": "0.00", "items": []}`.
    """
    project = _get_alive_project(db, project_id)
    items: Sequence[ProjectExpense] = db.scalars(
        select(ProjectExpense)
        .where(ProjectExpense.project_id == project_id)
        .order_by(ProjectExpense.spent_on.desc(), ProjectExpense.id.desc())
    ).all()
    return ExpenseListResponse(
        total=format_money(project.total_cost),
        items=[ExpenseResponse.model_validate(item) for item in items],
    )


@router.post(
    "",
    response_model=ExpenseResponse,
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
def create_expense(project_id: int, payload: ExpenseCreate, db: DbSession) -> ProjectExpense:
    """`201` с созданной записью; сумма и инкремент итога — на сервере.

    Порядок проверок — контракт: сначала `404` (проекта нет или он мягко удалён), потом
    формат даты, количества, «хотя бы одно количество больше нуля» и только затем «у
    проекта нет цен»: сообщение «Цены проекта не заполнены» пользователь видит уже после
    того, как заполнил количества, а не вместо этой проверки.
    """
    project = _get_alive_project(db, project_id)
    spent_on = validate_spent_on(payload.spent_on)
    tokens = {
        token_field: validate_tokens(getattr(payload, token_field))
        for token_field, _ in TOKEN_PRICE_FIELDS
    }
    if all(value == 0 for value in tokens.values()):
        raise _reject(NO_TOKENS)
    if _prices_are_empty(project):
        raise _reject(NO_PRICES)

    expense = ProjectExpense(
        project_id=project.id,
        spent_on=spent_on,
        amount=calculate_amount(project, tokens),
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
    return expense
