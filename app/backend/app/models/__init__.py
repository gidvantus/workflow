"""Доменные модели приложения. Импорт моделей нужен alembic и тестам."""

from app.models.department import Department, department_roles
from app.models.department_kind import (
    DEFAULT_DEPARTMENT_KINDS,
    FIELD_KEYS_BY_CODE,
    DepartmentKind,
)
from app.models.project import Project
from app.models.registry import RegistryDocument
from app.models.role import DEFAULT_ROLES, Role
from app.models.task import Task

__all__ = [
    "DEFAULT_DEPARTMENT_KINDS",
    "DEFAULT_ROLES",
    "FIELD_KEYS_BY_CODE",
    "Department",
    "DepartmentKind",
    "Project",
    "RegistryDocument",
    "Role",
    "Task",
    "department_roles",
]
