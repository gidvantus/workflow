"""Ручки раздела «Роли»: справочник ролей и скиллы ролей.

Раздел живёт в двух наборах путей и по одной причине: роль читается и создаётся по
пути `/api/roles` (скиллы вложены в роль), а правка и удаление скилла — по id скилла
(`/api/skills/{id}`), потому что скилл адресуем сам по себе, а не только парой
«роль — скилл».

**Роль.** `code` задаётся при создании и не меняется: это имя каталога пресета DSH.
`title` и `description` правятся. Удаление мягкое: `DELETE` ставит `deleted_at`, строка
остаётся, код занят навсегда. Роль, стоящая в живом отделе, не удаляется — `409`, иначе
отдел потерял бы роль молча.

**Скилл.** `code` — имя каталога скилла и frontmatter `name`, оно тоже неизменяемо.
`sections` — упорядоченный массив `{"title", "body"}`; `PATCH` заменяет массив целиком,
потому что порядок разделов задаётся кнопками «Выше»/«Ниже» на экране, а не операцией
над одним элементом. Пустой `body` разрешён, пустой `title` — нет.

**Отказы.** Ограничения длины и формата держат валидаторы этого модуля, а не схемы:
текст `422` одинаков для всех ручек и звучит ровно как в контракте. Порядок проверок
фиксирован — обязательность, длина, формат, — чтобы на теле с двумя ошибками ответ был
предсказуемым.
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.department import Department, department_roles
from app.models.role import Role
from app.models.role_skill import RoleSkill
from app.schemas.role import RoleCreate, RoleItem, RoleUpdate
from app.schemas.skill import SkillCreate, SkillResponse, SkillUpdate

router = APIRouter(prefix="/api/roles", tags=["roles"])
# Правка и удаление скилла живут по id скилла: контракт адресует их отдельным путём.
skills_router = APIRouter(prefix="/api/skills", tags=["skills"])

DbSession = Annotated[Session, Depends(get_db)]

# Слаг: латиница, цифры и дефис; первый символ — не дефис. Регистр не принимается:
# код роли — имя каталога пресета, а каталоги в пакете и в ~/.dsh различаются регистром.
CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# Пределы полей. Раздел до 200 символов, текст раздела до 20 000, разделов не больше 50 —
# это правило обеих половин: сервер отказывает `422`, фронт не даёт перейти предел.
ROLE_CODE_MAX_LENGTH = 50
ROLE_TITLE_MAX_LENGTH = 100
ROLE_DESCRIPTION_MAX_LENGTH = 2000
SKILL_CODE_MAX_LENGTH = 64
SKILL_TITLE_MAX_LENGTH = 200
SKILL_DESCRIPTION_MAX_LENGTH = 1000
SECTION_TITLE_MAX_LENGTH = 200
SECTION_BODY_MAX_LENGTH = 20000
SECTIONS_MAX = 50

# Тексты отказов — часть контракта: человек и фронт видят их дословно.
ROLE_CODE_REQUIRED = "Укажите код роли"
ROLE_CODE_FORMAT = "Код роли указывается латиницей, цифрами и дефисом"
ROLE_CODE_TOO_LONG = "Код роли длиннее 50 символов"
ROLE_CODE_IMMUTABLE = "Код роли не меняется"
ROLE_TITLE_REQUIRED = "Укажите название роли"
ROLE_TITLE_TOO_LONG = "Название роли длиннее 100 символов"
ROLE_DESCRIPTION_TOO_LONG = "Описание роли длиннее 2000 символов"
ROLE_NOT_FOUND = "Роль не найдена"
ROLE_CODE_TAKEN = "Роль с таким кодом уже есть"
ROLE_IN_DEPARTMENTS = "Роль стоит в отделах: сначала уберите её из них"
ROLE_WRITE_RACE = "Роль не удалось сохранить: одновременная правка"

SKILL_CODE_REQUIRED = "Укажите код скилла"
SKILL_CODE_FORMAT = "Код скилла указывается латиницей, цифрами и дефисом"
SKILL_CODE_TOO_LONG = "Код скилла длиннее 64 символов"
SKILL_CODE_IMMUTABLE = "Код скилла не меняется"
SKILL_TITLE_REQUIRED = "Укажите название скилла"
SKILL_TITLE_TOO_LONG = "Название скилла длиннее 200 символов"
SKILL_DESCRIPTION_REQUIRED = "Укажите описание скилла"
SKILL_DESCRIPTION_TOO_LONG = "Описание скилла длиннее 1000 символов"
SKILL_NOT_FOUND = "Скилл не найден"
SKILL_CODE_TAKEN = "Скилл с таким кодом у роли уже есть"

SECTIONS_NOT_ARRAY = "Разделы должны быть массивом"
SECTIONS_TOO_MANY = "Разделов больше 50"
SECTION_TITLE_REQUIRED = "Название раздела не задано"
SECTION_TITLE_TOO_LONG = "Название раздела длиннее 200 символов"
SECTION_BODY_TOO_LONG = "Текст раздела длиннее 20000 символов"
SECTION_BODY_NOT_TEXT = "Текст раздела должен быть строкой"

NO_FIELDS_TO_UPDATE = "Нет полей для изменения"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _now() -> datetime:
    """Текущее время в UTC: `updated_at` двигается явно, а не по воле диалекта."""
    return datetime.now(UTC)


def _text(raw: Any) -> str:
    """Строковое поле из тела: `None` и не строка читаются как пустая строка."""
    return raw.strip() if isinstance(raw, str) else ""


def _code(raw: Any, *, required: str, too_long: str, format_: str, limit: int) -> str:
    """Слаг кода: обязателен, укладывается в предел, состоит из разрешённых символов."""
    value = _text(raw)
    if not value:
        raise _reject(required)
    if len(value) > limit:
        raise _reject(too_long)
    if not CODE_PATTERN.match(value):
        raise _reject(format_)
    return value


def _required_text(raw: Any, *, required: str, too_long: str, limit: int) -> str:
    """Обязательное название: непустое после обрезки и не длиннее предела."""
    value = _text(raw)
    if not value:
        raise _reject(required)
    if len(value) > limit:
        raise _reject(too_long)
    return value


def _optional_text(raw: Any, *, too_long: str, limit: int) -> str:
    """Необязательное описание: пустое допустимо, но в базу попадает пустая строка.

    `NULL` и `""` значат одно и то же — «описания нет», поэтому второй формы в колонке
    не появляется: `description` у роли `NOT NULL`.
    """
    value = _text(raw)
    if len(value) > limit:
        raise _reject(too_long)
    return value


def _required_description(raw: Any) -> str:
    """Описание скилла обязательно: без него модель не видит скилл в каталоге."""
    value = _text(raw)
    if not value:
        raise _reject(SKILL_DESCRIPTION_REQUIRED)
    if len(value) > SKILL_DESCRIPTION_MAX_LENGTH:
        raise _reject(SKILL_DESCRIPTION_TOO_LONG)
    return value


def validate_sections(raw: Any) -> list[dict[str, str]]:
    """Проверить и нормализовать разделы скилла.

    Принимается только массив: объект, строка или `null` — отказ «Разделы должны быть
    массивом», иначе «сохранил, а разделы пропали». Пустой массив допустим.
    Заголовок обязателен и обрезается по краям; текст сохраняется как прислан, потому
    что markdown чувствителен к переводам строк и пробелам внутри блока кода, но только
    строкой: объект или число в `body` — отказ «Текст раздела должен быть строкой».
    """
    if not isinstance(raw, list):
        raise _reject(SECTIONS_NOT_ARRAY)
    if len(raw) > SECTIONS_MAX:
        raise _reject(SECTIONS_TOO_MANY)
    sections: list[dict[str, str]] = []
    for item in raw:
        section = item if isinstance(item, dict) else {}
        title = _required_text(
            section.get("title"),
            required=SECTION_TITLE_REQUIRED,
            too_long=SECTION_TITLE_TOO_LONG,
            limit=SECTION_TITLE_MAX_LENGTH,
        )
        body = section.get("body")
        if body is None:
            body_text = ""
        elif isinstance(body, str):
            body_text = body
        else:
            # Не строка — отказ, а не приведение: `str({"a": 1})` уехал бы в `SKILL.md`
            # как текст скилла, и модель прочитала бы мусор вместо раздела. `null` уже
            # разобран выше как пустой текст. Тело раздела приходит только строкой —
            # markdown-поле фронта и машинный импорт шлют строку.
            raise _reject(SECTION_BODY_NOT_TEXT)
        if len(body_text) > SECTION_BODY_MAX_LENGTH:
            raise _reject(SECTION_BODY_TOO_LONG)
        sections.append({"title": title, "body": body_text})
    return sections


def _alive_role(db: Session, role_id: int) -> Role:
    """Живая роль по id. Удалённая — `404`: воскрешения через `PATCH` не бывает."""
    role = db.get(Role, role_id)
    if role is None or role.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROLE_NOT_FOUND)
    return role


def _alive_skill(db: Session, skill_id: int) -> RoleSkill:
    """Живой скилл по id. Удалённый — `404`, как и удалённая роль."""
    skill = db.get(RoleSkill, skill_id)
    if skill is None or skill.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SKILL_NOT_FOUND)
    return skill


def _role_code_taken(db: Session, code: str, exclude_id: int | None = None) -> bool:
    """Занят ли код роли. Мягко удалённые строки тоже считаются: код не переиспользуют."""
    statement = select(Role.id).where(func.lower(Role.code) == code)
    if exclude_id is not None:
        statement = statement.where(Role.id != exclude_id)
    return db.scalar(statement) is not None


def _skill_code_taken(
    db: Session,
    role_id: int,
    code: str,
    exclude_id: int | None = None,
) -> bool:
    """Занят ли код скилла у этой роли (мягко удалённые строки тоже считаются)."""
    statement = select(RoleSkill.id).where(
        RoleSkill.role_id == role_id,
        func.lower(RoleSkill.code) == code,
    )
    if exclude_id is not None:
        statement = statement.where(RoleSkill.id != exclude_id)
    return db.scalar(statement) is not None


def _skill_count(db: Session, role_id: int) -> int:
    """Число живых скиллов роли: считается на чтении, отдельной колонки нет."""
    count = db.scalar(
        select(func.count())
        .select_from(RoleSkill)
        .where(RoleSkill.role_id == role_id, RoleSkill.deleted_at.is_(None))
    )
    return int(count or 0)


def _role_item(db: Session, role: Role) -> RoleItem:
    """Строка ответа роли: поля строки базы плюс посчитанное число скиллов."""
    return RoleItem(
        id=role.id,
        code=role.code,
        title=role.title,
        description=role.description,
        skill_count=_skill_count(db, role.id),
        updated_at=role.updated_at,
    )


def _commit(db: Session, race_detail: str) -> None:
    """Зафиксировать запись; гонку по уникальному индексу превращаем в отказ `409`."""
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, race_detail) from error


@router.get("", response_model=list[RoleItem], summary="Список живых ролей")
def list_roles(db: DbSession) -> list[RoleItem]:
    """Живые роли в порядке `id` (он же порядок сида и добавления из веба)."""
    roles: Sequence[Role] = db.scalars(
        select(Role).where(Role.deleted_at.is_(None)).order_by(Role.id)
    ).all()
    counts = dict(
        db.execute(
            select(RoleSkill.role_id, func.count())
            .where(RoleSkill.deleted_at.is_(None))
            .group_by(RoleSkill.role_id)
        ).all()
    )
    return [
        RoleItem(
            id=role.id,
            code=role.code,
            title=role.title,
            description=role.description,
            skill_count=int(counts.get(role.id, 0)),
            updated_at=role.updated_at,
        )
        for role in roles
    ]


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=RoleItem,
    summary="Создать роль",
)
def create_role(payload: RoleCreate, db: DbSession) -> RoleItem:
    """Новая роль: код задаётся здесь и дальше не меняется."""
    code = _code(
        payload.code,
        required=ROLE_CODE_REQUIRED,
        too_long=ROLE_CODE_TOO_LONG,
        format_=ROLE_CODE_FORMAT,
        limit=ROLE_CODE_MAX_LENGTH,
    )
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
    if _role_code_taken(db, code):
        raise HTTPException(status.HTTP_409_CONFLICT, ROLE_CODE_TAKEN)

    role = Role(code=code, title=title, description=description, updated_at=_now())
    db.add(role)
    _commit(db, ROLE_CODE_TAKEN)
    db.refresh(role)
    return _role_item(db, role)


@router.patch("/{role_id}", response_model=RoleItem, summary="Править роль")
def update_role(role_id: int, payload: RoleUpdate, db: DbSession) -> RoleItem:
    """`title` и `description`; `code` неизменяем, пустое тело — отказ."""
    role = _alive_role(db, role_id)
    fields = payload.model_fields_set
    if "code" in fields:
        raise _reject(ROLE_CODE_IMMUTABLE)
    if not fields:
        raise _reject(NO_FIELDS_TO_UPDATE)
    if "title" in fields:
        role.title = _required_text(
            payload.title,
            required=ROLE_TITLE_REQUIRED,
            too_long=ROLE_TITLE_TOO_LONG,
            limit=ROLE_TITLE_MAX_LENGTH,
        )
    if "description" in fields:
        role.description = _optional_text(
            payload.description,
            too_long=ROLE_DESCRIPTION_TOO_LONG,
            limit=ROLE_DESCRIPTION_MAX_LENGTH,
        )
    role.updated_at = _now()
    _commit(db, ROLE_WRITE_RACE)
    db.refresh(role)
    return _role_item(db, role)


@router.delete(
    "/{role_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягко удалить роль",
)
def delete_role(role_id: int, db: DbSession) -> None:
    """Мягкое удаление: строка и её скиллы остаются, код занят навсегда.

    Роль, стоящая в **живом** отделе, не удаляется: `409`. Отделы, которые уже мягко
    удалены, не мешают — связь с ними остаётся, но восстановления роли в интерфейсе нет.
    """
    role = _alive_role(db, role_id)
    in_departments = db.scalar(
        select(func.count())
        .select_from(department_roles)
        .join(Department, Department.id == department_roles.c.department_id)
        .where(
            department_roles.c.role_id == role.id,
            Department.deleted_at.is_(None),
        )
    )
    if in_departments:
        raise HTTPException(status.HTTP_409_CONFLICT, ROLE_IN_DEPARTMENTS)
    role.deleted_at = _now()
    role.updated_at = _now()
    _commit(db, ROLE_WRITE_RACE)


@router.get(
    "/{role_id}/skills",
    response_model=list[SkillResponse],
    summary="Скиллы роли",
)
def list_skills(role_id: int, db: DbSession) -> Sequence[RoleSkill]:
    """Живые скиллы роли в порядке `id`; удалённая роль — `404`."""
    role = _alive_role(db, role_id)
    return db.scalars(
        select(RoleSkill)
        .where(RoleSkill.role_id == role.id, RoleSkill.deleted_at.is_(None))
        .order_by(RoleSkill.id)
    ).all()


@router.post(
    "/{role_id}/skills",
    status_code=status.HTTP_201_CREATED,
    response_model=SkillResponse,
    summary="Добавить скилл роли",
)
def create_skill(role_id: int, payload: SkillCreate, db: DbSession) -> RoleSkill:
    """Новый скилл: код задаётся здесь и дальше не меняется."""
    role = _alive_role(db, role_id)
    code = _code(
        payload.code,
        required=SKILL_CODE_REQUIRED,
        too_long=SKILL_CODE_TOO_LONG,
        format_=SKILL_CODE_FORMAT,
        limit=SKILL_CODE_MAX_LENGTH,
    )
    title = _required_text(
        payload.title,
        required=SKILL_TITLE_REQUIRED,
        too_long=SKILL_TITLE_TOO_LONG,
        limit=SKILL_TITLE_MAX_LENGTH,
    )
    description = _required_description(payload.description)
    sections = validate_sections(payload.sections)
    if _skill_code_taken(db, role.id, code):
        raise HTTPException(status.HTTP_409_CONFLICT, SKILL_CODE_TAKEN)

    skill = RoleSkill(
        role_id=role.id,
        code=code,
        title=title,
        description=description,
        sections=sections,
        updated_at=_now(),
    )
    db.add(skill)
    _commit(db, SKILL_CODE_TAKEN)
    db.refresh(skill)
    return skill


@skills_router.patch("/{skill_id}", response_model=SkillResponse, summary="Править скилл")
def update_skill(skill_id: int, payload: SkillUpdate, db: DbSession) -> RoleSkill:
    """`title`, `description`, `sections`; `sections` заменяет массив целиком."""
    skill = _alive_skill(db, skill_id)
    fields = payload.model_fields_set
    if "code" in fields:
        raise _reject(SKILL_CODE_IMMUTABLE)
    if not fields:
        raise _reject(NO_FIELDS_TO_UPDATE)
    if "title" in fields:
        skill.title = _required_text(
            payload.title,
            required=SKILL_TITLE_REQUIRED,
            too_long=SKILL_TITLE_TOO_LONG,
            limit=SKILL_TITLE_MAX_LENGTH,
        )
    if "description" in fields:
        skill.description = _required_description(payload.description)
    if "sections" in fields:
        skill.sections = validate_sections(payload.sections)
    skill.updated_at = _now()
    _commit(db, SKILL_CODE_TAKEN)
    db.refresh(skill)
    return skill


@skills_router.delete(
    "/{skill_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягко удалить скилл",
)
def delete_skill(skill_id: int, db: DbSession) -> None:
    """Мягкое удаление: строка остаётся, код занят навсегда."""
    skill = _alive_skill(db, skill_id)
    skill.deleted_at = _now()
    skill.updated_at = _now()
    _commit(db, SKILL_CODE_TAKEN)
