"""Схемы проекта: тело ответа и тела запросов.

Ограничения длины и формата полей заданы **не** здесь, а валидаторами из
`app.api.projects`: так текст отказа ровно тот, что записан в контракте, и одинаков
для `POST` и `PATCH`.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ProjectResponse(BaseModel):
    """Живой проект в ответах `GET`, `POST` и `PATCH`.

    `deleted_at` наружу не отдаётся: клиент и так видит только живые строки.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    repo_url: str
    created_at: datetime
    updated_at: datetime


class ProjectCreate(BaseModel):
    """Тело `POST /api/projects`: `name` и `repo_url` обязательны, `description` — нет."""

    name: str
    repo_url: str
    description: str = ""


class ProjectUpdate(BaseModel):
    """Тело `PATCH /api/projects/{id}`: любое непустое подмножество полей.

    Поле, которого нет в теле, не меняется. Пустое тело — отказ `422`,
    его проверяет ручка, а не схема.
    """

    name: str | None = None
    description: str | None = None
    repo_url: str | None = None
