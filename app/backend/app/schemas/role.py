"""Схемы раздела «Роли»: тело ответа и тела запросов ролей.

Роли правятся из веба, поэтому у схемы два тела запроса. Ограничения и тексты отказов
живут **не** здесь, а в валидаторах `app.api.roles`: схема описывает только состав
полей, а отказ `422` одинаков для любой ручки и звучит ровно как в контракте.

`code` неизменяем: он задаётся при создании и попадает в путь каталога пресета DSH.
Если клиент прислал `code` в `PATCH`, ручка отвечает отказом, а не молча его выбрасывает.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class RoleItem(BaseModel):
    """Роль в `GET /api/roles` и в ответах `POST`/`PATCH`.

    `skill_count` считается на чтении, а не хранится: колонка-счётчик разошлась бы с
    таблицей `role_skills` при первой же мягко удалённой строке.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str
    description: str
    skill_count: int
    updated_at: datetime


class RoleCreate(BaseModel):
    """Тело `POST /api/roles`: `code` обязателен, `description` — нет."""

    code: str | None = None
    title: str | None = None
    description: str | None = None


class RoleUpdate(BaseModel):
    """Тело `PATCH /api/roles/{id}`: любое непустое подмножество `title`, `description`.

    `code` в схеме есть ровно для того, чтобы присланное значение получало понятный
    отказ «Код роли не меняется», а не тихо терялось.
    """

    code: str | None = None
    title: str | None = None
    description: str | None = None
