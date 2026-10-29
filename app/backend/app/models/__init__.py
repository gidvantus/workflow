"""Доменные модели приложения. Импорт модели нужен alembic и тестам."""

from app.models.project import Project

__all__ = ["Project"]
