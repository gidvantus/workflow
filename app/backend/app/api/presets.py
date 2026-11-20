"""Машинные ручки обмена с harness: что веб отдаёт на раскладку в пресеты DSH.

Harness (плагин отдела) спрашивает `GET /api/presets`, забирает документы изменившихся
ролей и раскладывает из них `preset.yml` и `SKILL.md`. Поэтому здесь нет экранов и нет
послаблений: три ручки, общий токен надстройки в заголовке `X-Registry-Token` — тот же,
что у реестра проектов, и те же тексты отказов, что у правки из браузера.

**Ревизия считается на чтении.** Дат в ней нет: ревизия роли — первые 12 hex символов
SHA-256 от канонического JSON документа роли, ревизия набора — то же от строк
`код:ревизия`, отсортированных по коду. Отсюда два свойства, на которые опирается
harness: повторное сохранение того же документа ревизию не двигает (`changed: false`), а
изменение любого поля двигает и её, и ревизию набора.

**Документ роли** — единственная форма, из которой рендерятся файлы пресета: `code`,
`title`, `description`, `skills[]` с `sections[]` в порядке показа. Скиллы в документе
идут по коду, а не по `id`: порядок в теле `PUT` — достояние вызывающего, и совпадение
документа считается по содержимому, а не по перечислению. Список скиллов в ручках
браузера (`GET /api/roles/{id}/skills`) остаётся по `id`.

**Авторитетность веба.** Роль, которая есть в вебе, живёт по документу из веба: скилл,
которого в документе нет, при `PUT` мягко удаляется. Роли, которой в вебе нет, harness не
трогает вовсе — поэтому пустая база не стирает пакетные скиллы.
"""

import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.registry import require_registry_token
from app.api.roles import (
    ROLE_DESCRIPTION_MAX_LENGTH,
    ROLE_DESCRIPTION_TOO_LONG,
    ROLE_NOT_FOUND,
    ROLE_TITLE_MAX_LENGTH,
    ROLE_TITLE_REQUIRED,
    ROLE_TITLE_TOO_LONG,
    SKILL_CODE_FORMAT,
    SKILL_CODE_MAX_LENGTH,
    SKILL_CODE_REQUIRED,
    SKILL_CODE_TAKEN,
    SKILL_CODE_TOO_LONG,
    SKILL_TITLE_MAX_LENGTH,
    SKILL_TITLE_REQUIRED,
    SKILL_TITLE_TOO_LONG,
    _code,
    _optional_text,
    _reject,
    _required_description,
    _required_text,
    validate_sections,
)
from app.db import get_db
from app.models.role import Role
from app.models.role_skill import RoleSkill
from app.schemas.presets import (
    PresetManifest,
    PresetPutRequest,
    PresetRoleDocument,
    PresetRoleRef,
    PresetStoredResponse,
)

# Токен проверяется на весь роутер: у машинных ручек нет ни одной открытой.
router = APIRouter(
    prefix="/api/presets",
    tags=["presets"],
    dependencies=[Depends(require_registry_token)],
)

DbSession = Annotated[Session, Depends(get_db)]

# Длина ревизии: 12 hex символов — достаточно, чтобы различить правки, и коротко, чтобы
# ревизия читалась в отчёте плагина.
REVISION_LENGTH = 12

# Отказ машинной ручки, которого нет в таблице браузерных: `skills` приходит только от
# инструмента импорта, и «массив скиллов не пришёл» — это ошибка вызывающего.
SKILLS_NOT_ARRAY = "Скиллы должны быть массивом"
PRESET_WRITE_RACE = "Документ роли не удалось сохранить: одновременная правка"


def _document(role: Role, skills: Sequence[RoleSkill]) -> dict[str, Any]:
    """Документ роли: ровно то, из чего harness рендерит файлы пресета.

    Скиллы идут по коду, а не по `id`: тот же документ приходит в `PUT` в любом порядке,
    и «повторная заливка ничего не изменила» должно быть видно по ревизии. Порядок файлов
    в пакете тоже по коду, так что раскладка совпадает с порядком документа.
    """
    return {
        "code": role.code,
        "title": role.title,
        "description": role.description,
        "skills": [
            {
                "code": skill.code,
                "title": skill.title,
                "description": skill.description,
                "sections": [
                    {"title": section.get("title", ""), "body": section.get("body", "")}
                    for section in skill.sections or []
                ],
            }
            for skill in sorted(skills, key=lambda item: item.code)
        ],
    }


def _canonical(payload: Any) -> str:
    """Канонический JSON: один и тот же документ даёт одну и ту же строку байт в байт."""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def document_revision(document: dict[str, Any]) -> str:
    """Ревизия документа роли: 12 hex от SHA-256 канонического JSON."""
    digest = hashlib.sha256(_canonical(document).encode("utf-8")).hexdigest()
    return digest[:REVISION_LENGTH]


def manifest_revision(roles: Sequence[PresetRoleRef]) -> str:
    """Ревизия набора: 12 hex от строк `код:ревизия`, отсортированных по коду.

    Ревизия роли сюда не входит, входит только её значение: набор меняется тогда и
    только тогда, когда меняется одна из ролей или состав живых ролей.
    """
    payload = "\n".join(
        f"{role.code}:{role.revision}" for role in sorted(roles, key=lambda ref: ref.code)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:REVISION_LENGTH]


def _skills_by_role(db: Session) -> dict[int, list[RoleSkill]]:
    """Живые скиллы всех ролей одним запросом: порядок — по `id`, как в списке скиллов."""
    skills = db.scalars(
        select(RoleSkill)
        .where(RoleSkill.deleted_at.is_(None))
        .order_by(RoleSkill.role_id, RoleSkill.id)
    ).all()
    grouped: dict[int, list[RoleSkill]] = {}
    for skill in skills:
        grouped.setdefault(skill.role_id, []).append(skill)
    return grouped


def _alive_role_by_code(db: Session, code: str) -> Role:
    """Живая роль по коду: код — это ключ документа, `id` машинной ручке не нужен."""
    role = db.scalar(
        select(Role).where(func.lower(Role.code) == code.lower(), Role.deleted_at.is_(None))
    )
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROLE_NOT_FOUND)
    return role


def _normalize_document(role_code: str, payload: PresetPutRequest) -> dict[str, Any]:
    """Проверить присланный документ теми же валидаторами, что и правку из браузера.

    `code` берётся из пути: он же имя каталога пресета, и расхождение с телом ничего не
    меняет. Скиллы проверяются по порядку и с теми же текстами отказов, что `POST
    /api/roles/{id}/skills`; повтор кода внутри документа — `409`, как и повтор в базе.
    """
    title = _required_text(
        payload.title,
        required=ROLE_TITLE_REQUIRED,
        too_long=ROLE_TITLE_TOO_LONG,
        limit=ROLE_TITLE_MAX_LENGTH,
    )
    description = _optional_text(
        payload.description,
        too_long=ROLE_DESCRIPTION_TOO_LONG,
        limit=ROLE_DESCRIPTION_MAX_LENGTH,
    )
    raw_skills = payload.skills
    if not isinstance(raw_skills, list):
        raise _reject(SKILLS_NOT_ARRAY)
    skills: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_skills:
        skill = item if isinstance(item, dict) else {}
        code = _code(
            skill.get("code"),
            required=SKILL_CODE_REQUIRED,
            too_long=SKILL_CODE_TOO_LONG,
            format_=SKILL_CODE_FORMAT,
            limit=SKILL_CODE_MAX_LENGTH,
        )
        if code in seen:
            raise HTTPException(status.HTTP_409_CONFLICT, SKILL_CODE_TAKEN)
        seen.add(code)
        skills.append(
            {
                "code": code,
                "title": _required_text(
                    skill.get("title"),
                    required=SKILL_TITLE_REQUIRED,
                    too_long=SKILL_TITLE_TOO_LONG,
                    limit=SKILL_TITLE_MAX_LENGTH,
                ),
                "description": _required_description(skill.get("description")),
                "sections": validate_sections(skill.get("sections")),
            }
        )
    return {
        "code": role_code,
        "title": title,
        "description": description,
        # Порядок скиллов в документе — по коду, как и в `_document`: ревизия не должна
        # зависеть от того, как вызывающий перечислил скиллы в теле.
        "skills": sorted(skills, key=lambda item: item["code"]),
    }


def _apply_document(db: Session, role: Role, document: dict[str, Any]) -> None:
    """Записать документ: скиллы из документа создать и обновить, остальные мягко удалить.

    Строка с тем же кодом, что и у мягко удалённого скилла, возвращается к жизни, а не
    заводится второй: код скилла у роли один на всю историю, и вторая строка сломала бы
    «код занят навсегда».
    """
    now = datetime.now(UTC)
    role.title = document["title"]
    role.description = document["description"]
    role.updated_at = now

    existing = {
        skill.code: skill
        for skill in db.scalars(select(RoleSkill).where(RoleSkill.role_id == role.id)).all()
    }
    wanted = {skill["code"]: skill for skill in document["skills"]}
    for code, skill in existing.items():
        incoming = wanted.get(code)
        if incoming is None:
            if skill.deleted_at is None:
                skill.deleted_at = now
                skill.updated_at = now
            continue
        skill.deleted_at = None
        skill.title = incoming["title"]
        skill.description = incoming["description"]
        skill.sections = incoming["sections"]
        skill.updated_at = now
    for code, incoming in wanted.items():
        if code in existing:
            continue
        db.add(
            RoleSkill(
                role_id=role.id,
                code=incoming["code"],
                title=incoming["title"],
                description=incoming["description"],
                sections=incoming["sections"],
                updated_at=now,
            )
        )


@router.get("", response_model=PresetManifest, summary="Манифест живых ролей для harness")
def read_manifest(db: DbSession) -> PresetManifest:
    """Ревизия набора и строки живых ролей: по ней harness решает, что забирать."""
    roles: Sequence[Role] = db.scalars(
        select(Role).where(Role.deleted_at.is_(None)).order_by(Role.id)
    ).all()
    grouped = _skills_by_role(db)
    refs = [
        PresetRoleRef(
            code=role.code,
            title=role.title,
            revision=document_revision(_document(role, grouped.get(role.id, []))),
            skill_count=len(grouped.get(role.id, [])),
        )
        for role in roles
    ]
    return PresetManifest(revision=manifest_revision(refs), roles=refs)


@router.get(
    "/{code}",
    response_model=PresetRoleDocument,
    summary="Документ роли для harness",
)
def read_role_document(code: str, db: DbSession) -> PresetRoleDocument:
    """Документ живой роли; удалённая роль — `404`, как и неизвестный код."""
    role = _alive_role_by_code(db, code)
    document = _document(role, _skills_by_role(db).get(role.id, []))
    return PresetRoleDocument(revision=document_revision(document), **document)


@router.put("/{code}", response_model=PresetStoredResponse, summary="Сохранить документ роли")
def store_role_document(
    code: str,
    payload: PresetPutRequest,
    db: DbSession,
) -> PresetStoredResponse:
    """Сохранить документ: без изменений — `changed: false` и ни одной записи.

    Ревизия ответа — ревизия **результата**, то есть документа после применения. На
    повторной заливке того же документа она совпадает с текущей, `changed` равен `false`,
    и `updated_at` не двигается: harness по этому признаку не переписывает файлы.
    """
    role = _alive_role_by_code(db, code)
    document = _normalize_document(role.code, payload)
    revision = document_revision(document)
    current = _document(role, _skills_by_role(db).get(role.id, []))
    if revision == document_revision(current):
        return PresetStoredResponse(role=role.code, revision=revision, changed=False)
    _apply_document(db, role, document)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, PRESET_WRITE_RACE) from error
    return PresetStoredResponse(role=role.code, revision=revision, changed=True)
