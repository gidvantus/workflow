"""Схемы проекта: тело ответа и тела запросов.

Ограничения длины и формата полей заданы **не** здесь, а валидаторами из
`app.api.projects`: так текст отказа ровно тот, что записан в контракте, и одинаков
для `POST` и `PATCH`.

Деньги проекта — четыре цены за 1 000 000 токенов. В ответе каждая приходит строкой
ровно с шестью знаками (`"0.270000"`): клиент не форматирует цены сам и не угадывает
точность. `total_cost` в схемы проекта **не входит**: единственный источник итога —
`GET /api/projects/{project_id}/expenses`, чтобы итог нельзя было случайно взять из
ответа проекта в другой момент времени.
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator

_PRICE_FIELDS = ("price_input", "price_output", "price_cache_read", "price_cache_write")


class ProjectResponse(BaseModel):
    """Живой проект в ответах `GET`, `POST` и `PATCH`.

    `deleted_at` наружу не отдаётся: клиент и так видит только живые строки.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    repo_url: str
    # Слаг проекта: он же `id` проекта в документе реестра. `null` — код ещё не задан.
    code: str | None
    # Цены за 1 000 000 токенов: строка ровно с шестью знаками, ноль допустим.
    price_input: str
    price_output: str
    price_cache_read: str
    price_cache_write: str
    created_at: datetime
    updated_at: datetime

    @field_validator(*_PRICE_FIELDS, mode="before")
    @classmethod
    def _format_price(cls, value: object) -> str:
        """`Decimal("0.27")` из базы → `"0.270000"`; цена есть у любой строки."""
        return f"{Decimal(str(value)):.6f}"


class ProjectCreate(BaseModel):
    """Тело `POST /api/projects`: `name` и `repo_url` обязательны, остальное — по желанию.

    Пустой `code` (`""` или `null`) значит «код не задан»: его проверяет ручка, чтобы
    текст отказа был один и тот же у `POST` и `PATCH`. Цены необязательны: без них
    проект создаётся с четырьмя нулями, а проверяет присланные значения ручка.
    """

    name: str
    repo_url: str
    description: str = ""
    code: str | None = None
    price_input: str | None = None
    price_output: str | None = None
    price_cache_read: str | None = None
    price_cache_write: str | None = None


class ProjectUpdate(BaseModel):
    """Тело `PATCH /api/projects/{id}`: любое непустое подмножество полей.

    Поле, которого нет в теле, не меняется. Пустое тело — отказ `422`,
    его проверяет ручка, а не схема. `code` задаётся один раз: попытка сменить уже
    заданный код — отказ, стереть код тоже нельзя. Цены правятся по одной; `total_cost`
    этой ручкой не меняется, и присланное поле игнорируется — необъявленное поле
    pydantic отбрасывает.
    """

    name: str | None = None
    description: str | None = None
    repo_url: str | None = None
    code: str | None = None
    price_input: str | None = None
    price_output: str | None = None
    price_cache_read: str | None = None
    price_cache_write: str | None = None
