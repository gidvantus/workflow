"""Доменные модели приложения. Импорт моделей нужен alembic и тестам."""

from app.models.department import Department, department_roles
from app.models.project import Project
from app.models.role import DEFAULT_ROLES, Role

__all__ = ["DEFAULT_ROLES", "Department", "Project", "Role", "department_roles"]
