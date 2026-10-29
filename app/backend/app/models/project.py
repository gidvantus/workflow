"""Модель проекта: строка таблицы `projects` с признаком мягкого удаления."""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = text("deleted_at IS NULL")


class Project(Base):
    """Проект в списке экрана «Проекты».

    Удаление мягкое: `DELETE` ставит `deleted_at`, строка остаётся в таблице и в списке
    больше не показывается. Восстановления через интерфейс нет.
    """

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default=text("''"),
    )
    repo_url: Mapped[str] = mapped_column(String(500), nullable=False)
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
    # Признак soft delete: `NULL` — проект живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )


# Уникальность названия среди живых строк держит индекс, а не только проверка в ручке:
# два одновременных `POST` без него создали бы дубль. Условие поддержано и в PostgreSQL,
# и в SQLite, поэтому тесты на SQLite в памяти не расходятся со стендом.
Index(
    "uq_projects_name_alive",
    func.lower(Project.name),
    unique=True,
    postgresql_where=ALIVE_CONDITION,
    sqlite_where=ALIVE_CONDITION,
)
