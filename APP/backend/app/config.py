"""Настройки сервиса. Всё, что является секретом, приходит только из окружения."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Конфигурация приложения, собранная из переменных окружения."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Строка подключения к PostgreSQL: в compose приходит из env_file стенда.
    database_url: str
    # Версия API отдаётся в ответе `/api/health`: фронт показывает её вместе со статусом.
    version: str = "0.1.0"


@lru_cache
def get_settings() -> Settings:
    """Настройки читаются один раз на процесс."""
    return Settings()
