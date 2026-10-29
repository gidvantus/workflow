"""Схемы запросов и ответов — контракт, который читает фронтенд."""

from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

__all__ = ["ProjectCreate", "ProjectResponse", "ProjectUpdate"]
