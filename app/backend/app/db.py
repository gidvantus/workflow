"""Подключение к базе данных, фабрика сессий и проверка её доступности."""

from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

# Потолок ожидания подключения: недоступная база не должна держать `/api/health`
# дольше двух секунд — иначе ручка здоровья сама становится источником отказов.
CONNECT_TIMEOUT_SECONDS = 2


engine = create_engine(
    get_settings().database_url,
    pool_pre_ping=True,
    connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
)


class Base(DeclarativeBase):
    """Базовый класс моделей: по нему alembic собирает метаданные таблиц."""


# `expire_on_commit=False`: после `commit()` ручка отдаёт объект без лишнего запроса,
# а `autoflush=False` — чтобы ручка управляла сбросом изменений сама, а не на каждом select.
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """Сессия на один запрос: закрывается в `finally`, даже если ручка упала."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def check_db() -> bool:
    """Проверка базы запросом `SELECT 1`.

    Недоступность базы — это `False`, а не исключение: ручка здоровья обязана ответить
    503 по контракту, а не упасть в 500.
    """
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return False
    return True
