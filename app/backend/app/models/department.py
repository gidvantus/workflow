"""Модель отдела: время работы, набор ролей и признак мягкого удаления.

Отдел ссылается на роли через таблицу связи `department_roles`. Мягко удалённый отдел
свои строки связи не теряет: физического удаления в приложении нет, поэтому набор ролей
удалённого отдела остаётся в базе как есть.

Переход через полночь (`end_time < start_time`, например 13:00 → 04:00) — штатный
случай: это одна пара «с/по», а не два окна внутри суток, и никакой проверки на
`end_time > start_time` здесь нет.
"""

from datetime import datetime, time

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Time,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.role import Role

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = text("deleted_at IS NULL")

# Связь многие-ко-многим: у отдела много ролей, роль может стоять в нескольких отделах.
department_roles = Table(
    "department_roles",
    Base.metadata,
    Column("department_id", ForeignKey("departments.id"), primary_key=True),
    Column("role_id", ForeignKey("roles.id"), primary_key=True),
)


class Department(Base):
    """Отдел в списке экрана «Отделы».

    Удаление мягкое: `DELETE` ставит `deleted_at`, строка остаётся в таблице и в списке
    больше не показывается. Восстановления через интерфейс нет.
    """

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Время работы одной парой «с/по»: конец раньше начала — переход через полночь.
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)
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
    # Признак soft delete: `NULL` — отдел живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
    # `selectin`: роли приезжают одним дополнительным запросом, а не по строке на отдел,
    # и порядок ответа задаёт `id`, а не порядок в таблице связи.
    roles: Mapped[list[Role]] = relationship(
        Role,
        secondary=department_roles,
        order_by=Role.id,
        lazy="selectin",
    )


# Уникальность названия среди живых строк держит индекс, а не только проверка в ручке:
# два одновременных `POST` без него создали бы дубль. Условие поддержано и в PostgreSQL,
# и в SQLite, поэтому тесты на SQLite в памяти не расходятся со стендом.
Index(
    "uq_departments_name_alive",
    func.lower(Department.name),
    unique=True,
    postgresql_where=ALIVE_CONDITION,
    sqlite_where=ALIVE_CONDITION,
)
