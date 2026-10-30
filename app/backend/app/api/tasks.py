"""Ручки задач проекта: список задач проекта и создание задачи.

Задача принадлежит проекту, поэтому путь вложен в проект
(`/api/projects/{project_id}/tasks`) и обе ручки сначала проверяют, что проект жив:
несуществующий или мягко удалённый проект — это `404` с тем же текстом, что у ручек
проектов. Проверка берётся из `app.api.projects`, а не переписывается здесь: текст
`404` у обеих половин один и тот же.

Тексты отказов — часть контракта: фронт показывает их пользователю дословно и не
переписывает, поэтому они собраны здесь константами и нигде больше не сочиняются.

Стоимость — деньги в рублях с копейками. Указанное значение приходит строкой с
точкой или запятой, в базу ложится `Numeric(12, 2)`, в ответ — строка ровно с двумя
знаками. `0` и отрицательное число — отказ, а не «не указана»: `0` значит
«бесплатно», «неизвестно» — это `NULL`.
"""

import re
from collections.abc import Sequence
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.projects import PROJECT_NOT_FOUND, _get_alive_project
from app.db import get_db
from app.models.task import Task
from app.schemas.task import TaskCreate, TaskResponse

router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])

# Сессия на запрос: одна и та же зависимость у обеих ручек.
DbSession = Annotated[Session, Depends(get_db)]

NAME_MAX_LENGTH = 200
DESCRIPTION_MAX_LENGTH = 2000

# Шаблон проверяется после нормализации запятой в точку: до десяти знаков до
# разделителя и не больше двух после. `1250`, `1250.5` и `1250,50` проходят,
# `12.345` — нет.
COST_PATTERN = re.compile(r"^\d{1,10}(\.\d{1,2})?$")

# В базе стоимость лежит ровно с двумя знаками: `1250,5` превращается в `1250.50`.
COST_QUANTUM = Decimal("0.01")

NAME_REQUIRED = "Укажите название задачи"
NAME_TOO_LONG = "Название задачи длиннее 200 символов"
# Тот же текст, что у проекта: набор формулировок `422` в контракте закрыт.
DESCRIPTION_TOO_LONG = "Описание длиннее 2000 символов"
COST_INVALID = "Стоимость указывается числом, например 1250.00"
COST_NOT_POSITIVE = "Стоимость должна быть больше нуля"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def validate_name(value: str) -> str:
    """Название: вернуть обрезанное значение или отказать `422`.

    Повтор названия внутри проекта разрешён: уникального индекса у задачи нет.
    """
    name = value.strip()
    if not name:
        raise _reject(NAME_REQUIRED)
    if len(name) > NAME_MAX_LENGTH:
        raise _reject(NAME_TOO_LONG)
    return name


def validate_description(value: str) -> str:
    """Описание: пустое разрешено, длиннее 2000 символов — отказ `422`."""
    if len(value) > DESCRIPTION_MAX_LENGTH:
        raise _reject(DESCRIPTION_TOO_LONG)
    return value


def validate_cost(value: str | None) -> Decimal | None:
    """Стоимость: `None` — «не указана», иначе `Decimal` ровно с двумя знаками.

    Поле необязательное: отсутствие поля, `null` и строка из одних пробелов дают
    `None` и отказа не получают. Явно указанное значение проверяется форматом
    (точка или запятая как разделитель) и знаком — ноль и минус отвергаются.
    """
    if value is None:
        return None
    # Запятая — привычный в России разделитель копеек: `1250,50` тот же `1250.50`.
    text = value.strip().replace(",", ".")
    if not text:
        return None
    if not COST_PATTERN.match(text):
        raise _reject(COST_INVALID)
    amount = Decimal(text)
    if amount <= 0:
        raise _reject(COST_NOT_POSITIVE)
    return amount.quantize(COST_QUANTUM)


@router.get(
    "",
    response_model=list[TaskResponse],
    summary="Список задач проекта",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def list_tasks(project_id: int, db: DbSession) -> Sequence[Task]:
    """Задачи только этого проекта, порядок — по `id` возрастанию."""
    _get_alive_project(db, project_id)
    return db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.id)).all()


@router.post(
    "",
    response_model=TaskResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создание задачи",
    responses={
        status.HTTP_404_NOT_FOUND: {"description": f"Проекта нет: «{PROJECT_NOT_FOUND}»."},
    },
)
def create_task(project_id: int, payload: TaskCreate, db: DbSession) -> Task:
    """`201` с созданной задачей; `404` — проекта нет или он мягко удалён.

    Стоимость необязательна: без неё в базе `NULL`, в ответе `"cost": null`.
    """
    _get_alive_project(db, project_id)
    name = validate_name(payload.name)
    description = validate_description(payload.description)
    cost = validate_cost(payload.cost)

    task = Task(project_id=project_id, name=name, description=description, cost=cost)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task
