"""Схемы журнала расходов: тело запроса, запись и список с итогом.

Ограничения и форматы проверяются **не** здесь, а валидаторами из `app.api.expenses`:
так текст отказа ровно тот, что записан в контракте, и одинаков для всех случаев.

Деньги в ответе — строки: `amount` ровно с двумя знаками (`"0.41"`), `total` — тоже
ровно с двумя (`"0.51"`). Клиент не считает копейки сам и не округляет: сумму считает
только сервер, а фронт переставляет строку в вид `0,41 ₽`.
"""

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator


class ExpenseResponse(BaseModel):
    """Запись журнала в ответах `GET` и `POST` ручек проекта."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    spent_on: date
    tokens_input: int
    tokens_output: int
    tokens_cache_read: int
    tokens_cache_write: int
    # Сумма записи — снимок на момент записи, строка ровно с двумя знаками.
    amount: str
    created_at: datetime

    @field_validator("amount", mode="before")
    @classmethod
    def _format_amount(cls, value: object) -> str:
        """`Decimal("0.4")` из базы → `"0.40"`; сумма у записи есть всегда."""
        return f"{Decimal(str(value)):.2f}"


class ExpenseCreate(BaseModel):
    """Тело `POST /api/projects/{project_id}/expenses`: все пять полей обязательны.

    Суммы в теле нет: её считает сервер по ценам проекта. `spent_on` приходит строкой
    `ГГГГ-ММ-ДД` (поле `<input type="date">` на фронте), количества — целыми числами.
    Проверку формата, диапазона и «хотя бы одно количество» делает ручка.
    """

    spent_on: str
    tokens_input: int
    tokens_output: int
    tokens_cache_read: int
    tokens_cache_write: int


class ExpenseListResponse(BaseModel):
    """Ответ `GET .../expenses`: итог проекта и записи этого проекта.

    `total` — хранимая стоимость проекта (`projects.total_cost`), а не сумма по
    прочитанным строкам: она равна сумме уже округлённых сумм, поэтому сходится с
    `amount` всех записей. Пустой журнал — `{"total": "0.00", "items": []}`.
    """

    total: str
    items: list[ExpenseResponse]
