"""Схемы журнала расходов: тело запроса, запись и список с итогом.

Ограничения и форматы проверяются **не** здесь, а валидаторами из `app.api.expenses`:
так текст отказа ровно тот, что записан в контракте, и одинаков для всех случаев.
Поэтому тело запроса описано свободными типами, а не `int`/`str`: `422` схемы отдаётся
до ручки, и с жёстким типом нечисловое количество получило бы массив pydantic вместо
текста контракта, а мягко удалённый проект — `422` вместо `404`. Ручка разбирает
значение сама и отвечает по контракту.

Деньги в ответе — строки: `amount` ровно с двумя знаками (`"0.41"`), `total` — тоже
ровно с двумя (`"0.51"`). Клиент не считает копейки сам и не округляет: сумму считает
только сервер, а фронт переставляет строку в вид `0,41 ₽`.
"""

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.money import format_money


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
        return format_money(value)


class ExpenseCreate(BaseModel):
    """Тело `POST /api/projects/{project_id}/expenses`: все пять полей обязательны.

    Суммы в теле нет: её считает сервер по ценам проекта. `spent_on` приходит строкой
    `ГГГГ-ММ-ДД` (поле `<input type="date">` на фронте), количества — целыми числами.

    Типы намеренно свободные (`int | float | str | None`), а не `int` и `str`: проверку
    делает ручка, после того как убедилась, что проект жив. Жёсткий тип отдал бы
    `12.5` и `"1 500"` стандартным `422` схемы с массивом в `detail`, а в мягко удалённый
    проект — `422` вместо `404`. Поэтому же у полей есть умолчание `None`: пропущенное
    поле доходит до ручки и получает её текст, а не отказ pydantic.
    """

    model_config = ConfigDict(
        # Схема для фронта: поля обязательны по контракту, и OpenAPI говорит это же.
        # Pydantic при этом пропущенное поле пропускает — чтобы оно получило текст
        # ручки, а не массив ошибок валидации до проверки живого проекта.
        json_schema_extra={
            "required": [
                "spent_on",
                "tokens_input",
                "tokens_output",
                "tokens_cache_read",
                "tokens_cache_write",
            ]
        },
    )

    spent_on: str | int | float | None = None
    tokens_input: int | float | str | None = None
    tokens_output: int | float | str | None = None
    tokens_cache_read: int | float | str | None = None
    tokens_cache_write: int | float | str | None = None


class ExpenseListResponse(BaseModel):
    """Ответ `GET .../expenses`: итог проекта и записи этого проекта.

    `total` — хранимая стоимость проекта (`projects.total_cost`), а не сумма по
    прочитанным строкам: она равна сумме уже округлённых сумм, поэтому сходится с
    `amount` всех записей. Пустой журнал — `{"total": "0.00", "items": []}`.
    """

    total: str
    items: list[ExpenseResponse]
