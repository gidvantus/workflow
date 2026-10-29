"""Схемы отдела и роли: тело ответа и тела запросов.

Ограничения длины и формата полей заданы **не** здесь, а валидаторами из
`app.api.departments`: так текст отказа ровно тот, что записан в контракте, и одинаков
для `POST` и `PATCH`.

Время в ответе — строка `"ЧЧ:ММ"` (`"13:00"`), а не `"13:00:00"`: `<input type="time">`
на фронте получает значение из этого поля без собственного форматирования, и секунды
сделали бы его невалидным.
"""

from datetime import datetime, time

from pydantic import BaseModel, ConfigDict, field_serializer


class RoleResponse(BaseModel):
    """Роль справочника в `GET /api/roles` и внутри ответа отдела."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str


class DepartmentResponse(BaseModel):
    """Живой отдел в ответах `GET`, `POST` и `PATCH`.

    `deleted_at` наружу не отдаётся: клиент и так видит только живые строки.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    start_time: time
    end_time: time
    roles: list[RoleResponse]
    created_at: datetime
    updated_at: datetime

    @field_serializer("start_time", "end_time")
    def serialize_clock(self, value: time) -> str:
        """В JSON — только часы и минуты: `"13:00"`, без секунд и микросекунд."""
        return value.strftime("%H:%M")


class DepartmentCreate(BaseModel):
    """Тело `POST /api/departments`: все четыре поля обязательны, `role_ids` непустой."""

    name: str
    start_time: str
    end_time: str
    role_ids: list[int]


class DepartmentUpdate(BaseModel):
    """Тело `PATCH /api/departments/{id}`: любое непустое подмножество полей.

    Поле, которого нет в теле, не меняется; `role_ids` заменяет набор ролей целиком.
    Пустое тело — отказ `422`, его проверяет ручка, а не схема.
    """

    name: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    role_ids: list[int] | None = None
