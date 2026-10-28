"""Точка входа FastAPI: приложение и ручка здоровья `/api/health`."""

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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
        description="Каркас приложения: пока только проверка живости сервиса и базы.",
    )

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
