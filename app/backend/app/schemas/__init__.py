"""Схемы запросов и ответов — контракт, который читает фронтенд."""

from app.schemas.department import (
    DepartmentCreate,
    DepartmentKindRef,
    DepartmentKindResponse,
    DepartmentResponse,
    DepartmentUpdate,
    RoleResponse,
)
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.schemas.task import TaskCreate, TaskResponse

__all__ = [
    "DepartmentCreate",
    "DepartmentKindRef",
    "DepartmentKindResponse",
    "DepartmentResponse",
    "DepartmentUpdate",
    "ProjectCreate",
    "ProjectResponse",
    "ProjectUpdate",
    "RoleResponse",
    "TaskCreate",
    "TaskResponse",
]
