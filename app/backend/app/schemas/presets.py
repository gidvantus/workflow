"""Схемы машинного обмена с harness: манифест, документ роли и ответ сохранения.

Ревизия — первые 12 hex символов SHA-256, и это **единственный** способ узнать, что
документ изменился: даты в неё не входят, поэтому повторное сохранение того же документа
ревизию не двигает. Документ роли — тот же, что отдаёт `GET /api/presets/{code}`: harness
рендерит из него `SKILL.md` и `preset.yml`, поэтому состав ключей здесь и в файлах
`plugins/presets.mjs` обязан совпадать.

Тела запросов намеренно свободные: отказы по тексту контракта выдаёт ручка
`app.api.presets`, а не pydantic, иначе машина получила бы пересказ ошибки схемы вместо
понятной причины.
"""

from typing import Any

from pydantic import BaseModel

from app.schemas.skill import SkillSection


class PresetRoleRef(BaseModel):
    """Строка манифеста: код роли, название, ревизия и число живых скиллов."""

    code: str
    title: str
    revision: str
    skill_count: int


class PresetManifest(BaseModel):
    """`GET /api/presets`: ревизия всего набора и строки живых ролей."""

    revision: str
    roles: list[PresetRoleRef]


class PresetSkill(BaseModel):
    """Скилл внутри документа роли: ровно то, из чего рендерится `SKILL.md`."""

    code: str
    title: str
    description: str
    sections: list[SkillSection]


class PresetRoleDocument(BaseModel):
    """`GET /api/presets/{code}`: документ роли вместе с его ревизией."""

    code: str
    title: str
    description: str
    revision: str
    skills: list[PresetSkill]


class PresetPutRequest(BaseModel):
    """Тело `PUT /api/presets/{code}`: документ роли без ревизии.

    Ревизию считает сервер, а `code` берётся из пути. Присланные значения проверяются
    теми же валидаторами, что и правка из браузера: у машинной ручки нет послаблений.
    """

    code: str | None = None
    title: Any = None
    description: Any = None
    skills: Any = None


class PresetStoredResponse(BaseModel):
    """Ответ `PUT /api/presets/{code}`: ревизия после сохранения и признак изменения.

    `changed: false` — документ совпал с текущим, ничего не записано и `updated_at`
    не сдвинулся. Harness по этому полю отличает «уже разложено» от «приехало новое».
    """

    role: str
    revision: str
    changed: bool
