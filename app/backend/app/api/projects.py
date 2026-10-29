"""Ручки проектов: список живых строк, создание, правка и мягкое удаление.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.project import Project
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])

# Сессия на запрос: одна и та же зависимость у всех четырёх ручек.
DbSession = Annotated[Session, Depends(get_db)]

NAME_MAX_LENGTH = 200
REPO_URL_MAX_LENGTH = 500
DESCRIPTION_MAX_LENGTH = 2000

# Ссылка (`https://…`, `http://…`) или короткая запись `owner/repo`.
REPO_URL_PATTERN = re.compile(r"^(https?://\S+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$")

NAME_REQUIRED = "Укажите название проекта"
NAME_TOO_LONG = "Название длиннее 200 символов"
REPO_URL_REQUIRED = "Укажите адрес репозитория"
REPO_URL_INVALID = "Адрес репозитория должен быть ссылкой или вида owner/repo"
DESCRIPTION_TOO_LONG = "Описание длиннее 2000 символов"
NO_FIELDS_TO_UPDATE = "Нет полей для изменения"
NAME_TAKEN = "Проект с таким названием уже есть"
PROJECT_NOT_FOUND = "Проект не найден"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def validate_name(value: str) -> str:
    """Название: вернуть обрезанное значение или отказать `422`."""
    name = value.strip()
    if not name:
        raise _reject(NAME_REQUIRED)
    if len(name) > NAME_MAX_LENGTH:
        raise _reject(NAME_TOO_LONG)
    return name


def validate_repo_url(value: str) -> str:
    """Адрес репозитория: вернуть обрезанное значение или отказать `422`."""
    repo_url = value.strip()
    if not repo_url:
        raise _reject(REPO_URL_REQUIRED)
    # Переросшая длина — тот же отказ, что и кривой формат: набор текстов `422` в
    # контракте закрыт, отдельной формулировки про 500 символов в нём нет.
    if len(repo_url) > REPO_URL_MAX_LENGTH or not REPO_URL_PATTERN.match(repo_url):
        raise _reject(REPO_URL_INVALID)
    return repo_url


def validate_description(value: str) -> str:
    """Описание: пустое разрешено, длиннее 2000 символов — отказ `422`."""
    if len(value) > DESCRIPTION_MAX_LENGTH:
        raise _reject(DESCRIPTION_TOO_LONG)
    return value


def _name_is_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    """Занято ли название среди живых строк: сравнение без учёта регистра.

    Имя удалённого проекта свободно — частичный индекс смотрит только на строки
    с `deleted_at IS NULL`.
    """
    statement = select(Project.id).where(
        Project.deleted_at.is_(None),
        func.lower(Project.name) == name.lower(),
    )
    if exclude_id is not None:
        statement = statement.where(Project.id != exclude_id)
    return db.execute(statement).first() is not None


def _get_alive_project(db: Session, project_id: int) -> Project:
    """Живой проект по id. Удалённый — это `404`: воскрешения через `PATCH` не бывает."""
    project = db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, PROJECT_NOT_FOUND)
    return project


def _commit_or_conflict(db: Session) -> None:
    """Фиксация изменений; гонку по имени ловит индекс и превращается в тот же `409`."""
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN) from error


@router.get(
    "",
    response_model=list[ProjectResponse],
    summary="Список живых проектов",
)
def list_projects(db: DbSession) -> Sequence[Project]:
    """Только живые строки, порядок — по `id` возрастанию."""
    return db.scalars(
        select(Project).where(Project.deleted_at.is_(None)).order_by(Project.id)
    ).all()


@router.post(
    "",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создание проекта",
    responses={
        status.HTTP_409_CONFLICT: {"description": f"Имя занято: «{NAME_TAKEN}»."},
    },
)
def create_project(payload: ProjectCreate, db: DbSession) -> Project:
    """`201` с созданным проектом; `409` — имя занято живым проектом."""
    name = validate_name(payload.name)
    repo_url = validate_repo_url(payload.repo_url)
    description = validate_description(payload.description)
    if _name_is_taken(db, name):
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN)

    project = Project(name=name, description=description, repo_url=repo_url)
    db.add(project)
    _commit_or_conflict(db)
    db.refresh(project)
    return project


@router.patch(
    "/{project_id}",
    response_model=ProjectResponse,
    summary="Правка проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
        status.HTTP_409_CONFLICT: {"description": f"Имя занято: «{NAME_TAKEN}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": f"Пустое тело: «{NO_FIELDS_TO_UPDATE}».",
        },
    },
)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: DbSession,
) -> Project:
    """`200` с обновлённым проектом; `422` на пустое тело, `404` для удалённого.

    Сначала проверяются все присланные поля, и только потом они присваиваются:
    отказ не должен оставлять в сессии половину правки.
    """
    project = _get_alive_project(db, project_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise _reject(NO_FIELDS_TO_UPDATE)

    name: str | None = None
    repo_url: str | None = None
    description: str | None = None
    if "name" in changes:
        name = validate_name(changes["name"] or "")
        if _name_is_taken(db, name, exclude_id=project.id):
            raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN)
    if "repo_url" in changes:
        repo_url = validate_repo_url(changes["repo_url"] or "")
    if "description" in changes:
        description = validate_description(changes["description"] or "")

    if name is not None:
        project.name = name
    if repo_url is not None:
        project.repo_url = repo_url
    if description is not None:
        project.description = description

    _commit_or_conflict(db)
    db.refresh(project)
    return project


@router.delete(
    "/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягкое удаление проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def delete_project(project_id: int, db: DbSession) -> Response:
    """`204` без тела: строка остаётся в таблице с `deleted_at`, из списка исчезает.

    Физического удаления строк в приложении нет. Повторный `DELETE` — `404`.
    """
    project = _get_alive_project(db, project_id)
    project.deleted_at = datetime.now(UTC)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
