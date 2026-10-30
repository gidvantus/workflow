"""Схемы задачи: тело ответа и тело запроса на создание.

Ограничения длины и формата полей заданы **не** здесь, а валидаторами из
`app.api.tasks`: так текст отказа ровно тот, что записан в контракте.

Стоимость в ответе — строка ровно с двумя знаками после точки (`"1250.00"`) или
`null`, когда стоимость не указана. Деньги не отдаются числом: клиент не должен
считать копейки сам, а `null` и `0` обязаны остаться различимыми. Поле объявлено
строкой, поэтому в OpenAPI у него один тип — `string | null`, — и фронт читает
контракт без догадок. Приведение `Decimal` из модели к строке делает
`_format_cost` до проверки типа: `f"{None:.2f}"` падает, поэтому проверка на `None`
в нём обязательна.
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator


class TaskResponse(BaseModel):
    """Задача в ответах `GET` и `POST` ручек `/api/projects/{project_id}/tasks`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    name: str
    description: str
    cost: str | None
    created_at: datetime
    updated_at: datetime

    @field_validator("cost", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str | None:
        """`Decimal("1250.5")` из базы → `"1250.50"`; нет стоимости — `None`."""
        if value is None:
            return None
        return f"{Decimal(str(value)):.2f}"


class TaskCreate(BaseModel):
    """Тело `POST /api/projects/{project_id}/tasks`: обязателен только `name`.

    `cost` необязательное: отсутствие поля, `null` и пустая строка означают одно и
    то же — «стоимость не указана», и ручка превращает всё это в `NULL`.
    """

    name: str
    description: str = ""
    cost: str | None = None
