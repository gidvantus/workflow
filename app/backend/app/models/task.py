"""Модель задачи проекта: строка таблицы `tasks`.

Задача не существует сама по себе: у неё всегда есть проект (`project_id`). Удаление
проекта мягкое и задач не удаляет, поэтому строки `tasks` переживают удаление своего
проекта и в списках не показываются — ручки задач отвечают по проекту `404`.

Колонки `deleted_at` у задачи нет: удаления задач в приложении не существует, ни
мягкого, ни физического.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Task(Base):
    """Задача проекта: название, описание и стоимость в рублях с копейками.

    `cost` допускает `NULL` — это «стоимость не указана», а не «ноль»: ноль значит
    «бесплатно», и смешивать эти два случая нельзя. Повтор названия внутри проекта
    разрешён: уникального индекса у задачи нет.
    """

    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default=text("''"),
    )
    # Деньги: `Numeric(12, 2)` — рубли и копейки. `NULL` — стоимость не указана.
    cost: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 2),
        nullable=True,
        default=None,
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
