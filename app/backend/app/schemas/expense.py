"""Схемы объединённого журнала расходов: тело записи, строка журнала и список с итогом.

Журнал один на два источника факта. Ручную запись человек вводит формой, смену пишет
отдел сам (`POST /api/usage/shifts`).

Суммы в теле нет ни у одной половины: её считает сервер по ценам проекта. Ручная запись
приходит теми же четырьмя количествами, что и смена, — `{"spent_on": …, "tokens": {…}}`,
и отличается от смены только тем, что у неё нет интервала и числа сессий.

Ограничения и форматы проверяются **не** здесь, а валидаторами из `app.api.expenses`:
так текст отказа ровно тот, что записан в контракте, и одинаков для всех случаев.
Поэтому значения полей описаны свободными типами, а не `int`/`str`: `422` схемы
отдаётся до ручки, и с жёстким типом нечисловое количество получило бы массив pydantic
вместо текста контракта, а мягко удалённый проект — `422` вместо `404`. Ручка разбирает
значение сама и отвечает по контракту.

Деньги в ответе — строки ровно с шестью знаками: формат и формулу держит `app.money`,
и своей копии у журнала нет. Клиент не считает сам и не округляет.
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.money import format_cost
from app.schemas.usage import UsageTokens

# Ключ источника строки журнала: его читает фронт, чтобы отличить половину.
MANUAL_KIND: Literal["manual"] = "manual"
SHIFT_KIND: Literal["shift"] = "shift"


class JournalEntry(BaseModel):
    """Строка объединённого журнала проекта.

    Поля интервала, причины и числа сессий есть только у смены: у ручной записи их нет
    вовсе, а не `null` в ответе (`response_model_exclude_none` в ручках). Так фронту не
    нужно угадывать, чем половины различаются: он смотрит на `kind` и на наличие
    `started_at`.
    """

    kind: Literal["manual", "shift"]
    id: int
    # День расхода: у ручной записи его назвал человек, у смены это дата `ended_at` в UTC.
    spent_on: date
    tokens: UsageTokens
    # Сумма строки — снимок на момент записи, строка ровно с шестью знаками.
    amount: str
    # У смены: интервал, причина закрытия и число сессий, вошедших в её сумму.
    started_at: datetime | None = None
    ended_at: datetime | None = None
    reason: str | None = None
    sessions_count: int | None = None

    @field_validator("amount", mode="before")
    @classmethod
    def _format_amount(cls, value: object) -> str:
        """`Decimal("0.4")` из базы → `"0.400000"`; сумма у строки есть всегда."""
        return format_cost(value)


class JournalTokensInput(BaseModel):
    """Четыре количества в теле ручной записи: все обязательны по контракту.

    Типы свободные (`bool | int | float | str | None`), а не `int`: проверку и текст
    отказа даёт ручка. `bool` стоит в объединении **первым**: без него pydantic
    приводит `true` к `1`, запись создаётся с ненулевым количеством, и отказ контракта
    («целое неотрицательное число») не срабатывает.
    """

    model_config = ConfigDict(populate_by_name=True)

    in_: bool | int | float | str | None = Field(default=None, alias="in")
    out: bool | int | float | str | None = None
    cacheRead: bool | int | float | str | None = None
    cacheWrite: bool | int | float | str | None = None

    def as_mapping(self) -> dict[str, Any]:
        """Поля по именам контракта: `{"in": …, "out": …, "cacheRead": …, "cacheWrite": …}`.

        Ключ `in` — слово из Python, и обращаться к нему атрибутом нельзя; ответ и
        проверка идут по словарю, а не через `getattr`.
        """
        return {
            "in": self.in_,
            "out": self.out,
            "cacheRead": self.cacheRead,
            "cacheWrite": self.cacheWrite,
        }


class ExpenseCreate(BaseModel):
    """Тело `POST /api/projects/{project_id}/expenses`: день и четыре количества.

    Суммы в теле нет: её считает сервер по ценам проекта. `spent_on` приходит строкой
    `ГГГГ-ММ-ДД` (поле `<input type="date">` на фронте), количества — целыми числами
    внутри `tokens`.

    Поля необязательны в pydantic и обязательны по контракту (`json_schema_extra`):
    пропущенное поле должно получить текст ручки, а не массив ошибок валидации, и
    мягко удалённый проект — `404`, а не `422`.
    """

    model_config = ConfigDict(
        json_schema_extra={"required": ["spent_on", "tokens"]},
    )

    spent_on: str | int | float | None = None
    tokens: JournalTokensInput | None = None


class ExpenseListResponse(BaseModel):
    """Ответ `GET .../expenses`: итог проекта и обе половины журнала одним списком.

    `total` — хранимая стоимость проекта (`projects.total_cost`), а не сумма прочитанных
    строк: смену прибавляет ручка приёма смены, ручную запись — ручка записи, и обе
    прибавляют уже округлённые суммы. Пустой журнал — `{"total": "0.000000", "items": []}`.

    Порядок строк задаёт сервер (`spent_on DESC, sort_at DESC, id DESC`): фронт его не
    пересортировывает.
    """

    total: str
    items: list[JournalEntry]

    @field_validator("total", mode="before")
    @classmethod
    def _format_total(cls, value: object) -> str:
        return format_cost(value)
