"""Скилл роли: код и заголовок, описание для каталога и разделы в JSON-колонке.

Скилл принадлежит роли и повторяет её устройство: код неизменяем, удаление мягкое,
код удалённого скилла не переиспользуется. `sections` — **упорядоченный** массив
`{"title": str, "body": str}`: порядок массива и есть порядок разделов в файле
`SKILL.md`, который раскладывает harness. Нормализовать разделы во вторую таблицу
человек не стал: разделы правятся целиком, а порядок задаётся кнопками «Выше»/«Ниже»,
и ради этого держать `position` в отдельной таблице — лишний слой.

Пустой `body` разрешён: раздел-заголовок без текста — нормальная заготовка. Пустой
`description` — нет: без него модель не видит скилл в каталоге инструмента `skill`,
поэтому обязательность держит ручка (`app.api.roles`), а не колонка.

Мягко удалённая строка остаётся в таблице: код занят навсегда, а частичный уникальный
индекс смотрит только на живые строки. Уникальность среди живых — по `(role_id,
lower(code))`: один и тот же код у разных ролей не конфликт.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = text("deleted_at IS NULL")

# Тип колонки разделов: на стенде (PostgreSQL) — `JSONB`, в тестах (SQLite) — `JSON`.
# Проверка формы живёт в Python, поэтому поведение диалектов совпадает.
SECTIONS_JSON = JSON().with_variant(JSONB(), "postgresql")


class RoleSkill(Base):
    """Скилл роли: разделы хранятся массивом и заменяются целиком."""

    __tablename__ = "role_skills"
    __table_args__ = (
        Index("ix_role_skills_role_id", "role_id"),
        Index(
            "uq_role_skills_role_code_alive",
            "role_id",
            func.lower(text("code")),
            unique=True,
            postgresql_where=ALIVE_CONDITION,
            sqlite_where=ALIVE_CONDITION,
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    role_id: Mapped[int] = mapped_column(Integer, ForeignKey("roles.id"), nullable=False)
    # Код — имя каталога скилла и frontmatter `name`: задаётся при создании и не меняется.
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    # Заголовок `#` в файле `SKILL.md`.
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # `description` frontmatter: по нему модель решает, когда грузить скилл.
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # Разделы `##` по порядку показа. Значение присваивается целиком, поэтому
    # `MutableList` не нужен: правка на месте прошла бы мимо `updated_at`.
    sections: Mapped[list[dict[str, Any]]] = mapped_column(
        SECTIONS_JSON,
        nullable=False,
        default=list,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    # Признак soft delete: `NULL` — скилл живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
