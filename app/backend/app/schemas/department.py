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

    `project_id` типизирован `int | None`, а не `int`: отдел, заведённый до привязки к
    проекту, достаётся плоскими `PATCH`/`DELETE`, и жёсткий `int` уронил бы ответ на
    валидации `500` вместо честного `project_id: null` в списке живых отделов проекта.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int | None
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
    """Тело `POST /api/projects/{project_id}/departments`: все четыре поля обязательны.

    `project_id` в теле нет: проект задаётся путём, а не полем формы.
    """

    name: str
    start_time: str
    end_time: str
    role_ids: list[int]


class DepartmentUpdate(BaseModel):
    """Тело `PATCH /api/departments/{id}`: любое непустое подмножество полей.

    Поле, которого нет в теле, не меняется; `role_ids` заменяет набор ролей целиком.
    Пустое тело — отказ `422`, его проверяет ручка, а не схема.

    `project_id` присутствует ровно для того, чтобы присланное значение **не** роняло
    запрос: переноса отдела между проектами нет, поле игнорируется и строку не двигает.
    Отказ `422` на пустое тело при этом остаётся: тело из одного `project_id` меняет
    ничего, и ручка отдаёт отдел как есть, не трогая ни одного поля.
    """

    name: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    role_ids: list[int] | None = None
    project_id: int | None = None
