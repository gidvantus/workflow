"""Точка входа FastAPI: приложение, ручка здоровья и ручки разделов приложения."""

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api import department_kinds, departments, presets, projects, registry, roles, tasks
from app.config import get_settings
from app.db import check_db

API_PREFIX = "/api"

# Текст отказа базы — часть контракта: фронт показывает его пользователю дословно.
DB_UNAVAILABLE_MESSAGE = "База данных недоступна"


class HealthOk(BaseModel):
    """Ответ, когда сервис и база отвечают."""

    status: str = "ok"
    db: str = "ok"
    version: str


class HealthDegraded(BaseModel):
    """Ответ, когда база недоступна. `message` — текст для пользователя."""

    status: str = "degraded"
    db: str = "fail"
    version: str
    message: str


def create_app() -> FastAPI:
    """Приложение без CORS: фронт ходит на свой же origin, `/api` проксирует nginx."""
    settings = get_settings()
    application = FastAPI(
        title="APP API",
        version=settings.version,
        description=(
            "API приложения: живость сервиса и базы, справочники ролей и видов отделов, "
            "проекты (список живых строк, создание, правка и мягкое удаление), отделы "
            "проекта (список отделов проекта и создание отдела по вложенному пути "
            "`/api/projects/{project_id}/departments`; создание выбирает вид отдела, а "
            "имя отдела — название вида; правка полей страницы отдела и мягкое удаление — "
            "по пути `/api/departments/{department_id}`; процесс отдела — таблица ступеней "
            "конвейера — читается и сохраняется по пути "
            "`/api/departments/{department_id}/process`, сохранение пересобирает реестр) и "
            "задачи проекта: список задач "
            "проекта и создание задачи. Правки и удаления задач в приложении нет. "
            "Раздел «Роли» ведёт справочник ролей и их скиллы: роли читаются и создаются "
            "по пути `/api/roles`, правятся и удаляются по `/api/roles/{role_id}`; скиллы "
            "роли читаются и создаются по `/api/roles/{role_id}/skills`, а правятся и "
            "удаляются по id скилла — `/api/skills/{skill_id}`. Удаление мягкое, код роли "
            "и скилла неизменяем. Для harness есть машинные ручки `/api/presets`: манифест "
            "живых ролей с ревизиями, документ роли и его сохранение; все три требуют "
            "заголовок `X-Registry-Token`. "
            "Реестр проектов отдела — отдельно: `GET /api/registry` отдаёт документ "
            "последней ревизии, `PUT /api/registry` сохраняет присланный документ новой "
            "ревизией, `POST /api/registry/rebuild` собирает его из проектов и отделов. "
            "Все три ручки требуют заголовок `X-Registry-Token`."
        ),
    )

    application.include_router(projects.router)
    application.include_router(departments.router)
    application.include_router(departments.items_router)
    application.include_router(roles.router)
    application.include_router(roles.skills_router)
    application.include_router(department_kinds.router)
    application.include_router(tasks.router)
    application.include_router(registry.router)
    application.include_router(presets.router)

    @application.get(
        f"{API_PREFIX}/health",
        summary="Живость API и доступность базы",
        response_model=HealthOk,
        responses={
            status.HTTP_503_SERVICE_UNAVAILABLE: {
                "model": HealthDegraded,
                "description": (
                    "База недоступна. Поле `message` фронт показывает пользователю дословно."
                ),
            },
        },
    )
    def health() -> JSONResponse:
        """200 — сервис и база живы, 503 — база недоступна.

        Тело собирается явно, а не сериализацией модели: порядок и состав полей —
        часть контракта, который читает фронт.
        """
        if check_db():
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content={"status": "ok", "db": "ok", "version": settings.version},
            )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "status": "degraded",
                "db": "fail",
                "version": settings.version,
                "message": DB_UNAVAILABLE_MESSAGE,
            },
        )

    return application


app = create_app()
