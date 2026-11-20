"""Схемы скиллов роли: разделы как упорядоченный массив и тела запросов.

`SkillSection` — единица правки на экране: заголовок и markdown-текст. Разделы едут
массивом в том порядке, в котором их показывают, и порядок массива — это порядок `##`
в файле `SKILL.md`. Пустой `body` разрешён.

`SkillUpdate.sections` намеренно без типа: присланное «не массив» должно получать отказ
с текстом контракта («Разделы должны быть массивом»), а не пересказ pydantic. Форму
массива проверяет `app.api.roles`.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class SkillSection(BaseModel):
    """Раздел скилла: заголовок `##` и его текст."""

    title: str
    body: str = ""


class SkillResponse(BaseModel):
    """Скилл роли в `GET /api/roles/{id}/skills` и в ответах `POST`/`PATCH`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str
    description: str
    sections: list[SkillSection]
    created_at: datetime
    updated_at: datetime


class SkillCreate(BaseModel):
    """Тело `POST /api/roles/{id}/skills`: `code`, `title`, `description`, `sections`."""

    code: str | None = None
    title: str | None = None
    description: str | None = None
    sections: Any = None


class SkillUpdate(BaseModel):
    """Тело `PATCH /api/skills/{id}`: `sections` заменяет массив целиком.

    `code` в схеме есть ровно для того, чтобы присланное значение получало понятный
    отказ «Код скилла не меняется».
    """

    code: str | None = None
    title: str | None = None
    description: str | None = None
    sections: Any = None
