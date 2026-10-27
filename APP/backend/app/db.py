"""Подключение к базе данных и проверка её доступности."""

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.config import get_settings

# Потолок ожидания подключения: недоступная база не должна держать `/api/health`
# дольше двух секунд — иначе ручка здоровья сама становится источником отказов.
CONNECT_TIMEOUT_SECONDS = 2


engine = create_engine(
    get_settings().database_url,
    pool_pre_ping=True,
    connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
)


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
