"""Схемы запросов и ответов — контракт, который читает фронтенд."""

from app.schemas.department import (
    DepartmentCreate,
    DepartmentResponse,
    DepartmentUpdate,
    RoleResponse,
)
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

__all__ = [
    "DepartmentCreate",
    "DepartmentResponse",
    "DepartmentUpdate",
    "ProjectCreate",
    "ProjectResponse",
    "ProjectUpdate",
    "RoleResponse",
]
