"""Ручки отделов: список живых строк, создание, правка и мягкое удаление.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.

Время работы — одна пара «с/по». `end_time` меньше `start_time` — это переход через
полночь (13:00 → 04:00), штатный случай: запрещать его нельзя и «исправлять» тоже.
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.department import Department
from app.models.role import Role
from app.schemas.department import DepartmentCreate, DepartmentResponse, DepartmentUpdate

router = APIRouter(prefix="/api/departments", tags=["departments"])

# Сессия на запрос: одна и та же зависимость у всех четырёх ручек.
DbSession = Annotated[Session, Depends(get_db)]

NAME_MAX_LENGTH = 200

# Время принимается строго как `ЧЧ:ММ`: `9:00` — это уже отказ, а не «починим сами».
CLOCK_PATTERN = re.compile(r"^\d{2}:\d{2}$")
CLOCK_FORMAT = "%H:%M"

NAME_REQUIRED = "Укажите название отдела"
NAME_TOO_LONG = "Название отдела длиннее 200 символов"
CLOCK_INVALID = "Время работы указывается как ЧЧ:ММ, например 09:00"
CLOCK_EQUAL = "Начало и конец рабочего времени совпадают"
ROLES_REQUIRED = "Выберите хотя бы одну роль"
ROLE_UNKNOWN = "Выбрана роль, которой нет в списке ролей"
NO_FIELDS_TO_UPDATE = "Нет полей для изменения"
NAME_TAKEN = "Отдел с таким названием уже есть"
DEPARTMENT_NOT_FOUND = "Отдел не найден"


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


def validate_time(value: str) -> time:
    """Время строго `ЧЧ:ММ`: формат проверяет шаблон, диапазон — `strptime`.

    `strptime` ловит то, что шаблон пропускает: `25:00`, `12:60` — они не превращаются
    в `ValueError` шаблона и обязаны получить тот же отказ, что и `9:00`.
    """
    if not CLOCK_PATTERN.match(value):
        raise _reject(CLOCK_INVALID)
    try:
        return datetime.strptime(value, CLOCK_FORMAT).time()
    except ValueError as error:
        raise _reject(CLOCK_INVALID) from error


def validate_times(start: str, end: str) -> tuple[time, time]:
    """Пара «с/по»: оба значения по формату и не равны друг другу.

    `end < start` здесь разрешено — это переход через полночь.
    """
    start_time = validate_time(start)
    end_time = validate_time(end)
    if start_time == end_time:
        raise _reject(CLOCK_EQUAL)
    return start_time, end_time


def validate_role_ids(db: Session, role_ids: list[int]) -> list[Role]:
    """Набор ролей: непустой, без повторов, каждая роль есть в справочнике.

    Повтор схлопывается молча — это не ошибка ввода. Порядок ответа задаёт `id` роли,
    а не порядок в присланном списке.
    """
    unique_ids = list(dict.fromkeys(role_ids))
    if not unique_ids:
        raise _reject(ROLES_REQUIRED)
    roles = db.scalars(select(Role).where(Role.id.in_(unique_ids)).order_by(Role.id)).all()
    if len(roles) != len(unique_ids):
        raise _reject(ROLE_UNKNOWN)
    return list(roles)


def _clock(value: time) -> str:
    """Обратное преобразование: время из базы в строку `ЧЧ:ММ` для повторной проверки."""
    return value.strftime(CLOCK_FORMAT)


def _name_is_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    """Занято ли название среди живых строк: сравнение без учёта регистра.

    Имя удалённого отдела свободно — частичный индекс смотрит только на строки
    с `deleted_at IS NULL`.

    Сравнение делается в Python, а не `lower()` в SQL: в SQLite `lower()` опускает
    только латиницу, и проверка «Разработка» / «разработка» на стенде (PostgreSQL)
    и в тестах (SQLite) разошлась бы. Отделов десятки, полный список живых имён
    дешевле диалектной разницы; уникальность на гонке держит частичный индекс.
    """
    statement = select(Department.name).where(Department.deleted_at.is_(None))
    if exclude_id is not None:
        statement = statement.where(Department.id != exclude_id)
    taken = {candidate.casefold() for candidate in db.scalars(statement)}
    return name.casefold() in taken


def _get_alive_department(db: Session, department_id: int) -> Department:
    """Живой отдел по id. Удалённый — это `404`: воскрешения через `PATCH` не бывает."""
    department = db.get(Department, department_id)
    if department is None or department.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DEPARTMENT_NOT_FOUND)
    return department


def _commit_or_conflict(db: Session) -> None:
    """Фиксация изменений; гонку по имени ловит индекс и превращается в тот же `409`."""
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN) from error


@router.get(
    "",
    response_model=list[DepartmentResponse],
    summary="Список живых отделов",
)
def list_departments(db: DbSession) -> Sequence[Department]:
    """Только живые строки, порядок — по `id` возрастанию."""
    return db.scalars(
        select(Department).where(Department.deleted_at.is_(None)).order_by(Department.id)
    ).all()


@router.post(
    "",
    response_model=DepartmentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создание отдела",
    responses={
        status.HTTP_409_CONFLICT: {"description": f"Имя занято: «{NAME_TAKEN}»."},
    },
)
def create_department(payload: DepartmentCreate, db: DbSession) -> Department:
    """`201` с созданным отделом; `409` — имя занято живым отделом."""
    name = validate_name(payload.name)
    start_time, end_time = validate_times(payload.start_time, payload.end_time)
    roles = validate_role_ids(db, payload.role_ids)
    if _name_is_taken(db, name):
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN)

    department = Department(
        name=name,
        start_time=start_time,
        end_time=end_time,
        roles=roles,
    )
    db.add(department)
    _commit_or_conflict(db)
    db.refresh(department)
    return department


@router.patch(
    "/{department_id}",
    response_model=DepartmentResponse,
    summary="Правка отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
        status.HTTP_409_CONFLICT: {"description": f"Имя занято: «{NAME_TAKEN}»."},
        status.HTTP_422_UNPROCESSABLE_CONTENT: {
            "description": f"Пустое тело: «{NO_FIELDS_TO_UPDATE}».",
        },
    },
)
def update_department(
    department_id: int,
    payload: DepartmentUpdate,
    db: DbSession,
) -> Department:
    """`200` с обновлённым отделом; `422` на пустое тело, `404` для удалённого.

    Сначала проверяются все присланные поля, и только потом они присваиваются:
    отказ не должен оставлять в сессии половину правки. `role_ids` заменяет набор
    ролей целиком, а не дополняет его.
    """
    department = _get_alive_department(db, department_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise _reject(NO_FIELDS_TO_UPDATE)

    name: str | None = None
    start_time: time | None = None
    end_time: time | None = None
    roles: list[Role] | None = None

    if "name" in changes:
        name = validate_name(changes["name"] or "")
    if "start_time" in changes or "end_time" in changes:
        # Неприсланное поле берётся из базы: проверяется итоговая пара, а не половина.
        raw_start = (
            changes["start_time"] if "start_time" in changes else _clock(department.start_time)
        )
        raw_end = changes["end_time"] if "end_time" in changes else _clock(department.end_time)
        start_time, end_time = validate_times(raw_start or "", raw_end or "")
    if "role_ids" in changes:
        roles = validate_role_ids(db, changes["role_ids"] or [])
    if name is not None and _name_is_taken(db, name, exclude_id=department.id):
        raise HTTPException(status.HTTP_409_CONFLICT, NAME_TAKEN)

    if name is not None:
        department.name = name
    if start_time is not None:
        department.start_time = start_time
    if end_time is not None:
        department.end_time = end_time
    if roles is not None:
        department.roles = roles
        # Роли лежат в `department_roles`, а строка `departments` при такой правке не
        # меняется: без явного `updated_at` `onupdate=func.now()` не сработает, и
        # колонка «Обновлён» покажет дату до правки, хотя отдел уже изменили.
        department.updated_at = datetime.now(UTC)

    _commit_or_conflict(db)
    db.refresh(department)
    return department


@router.delete(
    "/{department_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягкое удаление отдела",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Отдела нет: «{DEPARTMENT_NOT_FOUND}»."},
    },
)
def delete_department(department_id: int, db: DbSession) -> Response:
    """`204` без тела: строка остаётся в таблице с `deleted_at`, из списка исчезает.

    Строки `department_roles` при этом не удаляются: физического удаления в приложении
    нет. Повторный `DELETE` — `404`.
    """
    department = _get_alive_department(db, department_id)
    department.deleted_at = datetime.now(UTC)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
