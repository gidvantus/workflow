"""Сессия роли в журнале расхода: строка таблицы `usage_sessions`.

Сессия — самая мелкая единица журнала: роль, id диалога, тикет, число ходов, токены и
цена в USD. Она принадлежит смене (`shift_id`) и проекту (`project_ref` — денормализация
ради суммы по проекту без соединения с `usage_shifts`).

**Одна сессия входит в суммы проекта один раз.** Это держит уникальный индекс
`(project_ref, session)`. Причина — «продолженный диалог»: смена может взять сессию,
начатую в прошлой смене (`carried` в карточке `usageCard`), и та же сессия приезжает в
веб второй раз, уже с накопленными токенами. Вторую запись журнал пропускает целиком, и
сессия остаётся за той сменой, которая записала её первой. Это осознанное расхождение с
текстом Telegram-сводки: там цифра дня, здесь — суммы проекта без двойного счёта.

`issue_number` и `issue_title` — nullable: сессия бывает без тикета (работа постановки),
и это нормальное состояние, а не «данных нет». `source` тоже nullable: источник записи
(`issue-created`, роль пресета) известен не всегда.
"""

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    # Обратная сторона связи нужна только типам: импорт на ходу был бы циклическим
    # (`app.models.usage_shift` импортирует эту модель ради `relationship`).
    from app.models.usage_shift import UsageShift


class UsageSession(Base):
    """Сессия роли внутри смены: токены, ходы и цена.

    Уникальность `(project_ref, session)` — правило «одна сессия один раз» на уровне
    базы, а не ручки: две одновременные отправки одной смены не должны посчитать
    сессию дважды.
    """

    __tablename__ = "usage_sessions"
    __table_args__ = (
        Index("ix_usage_sessions_shift_id", "shift_id"),
        Index("ix_usage_sessions_project_ref", "project_ref"),
        Index("uq_usage_sessions_project_session", "project_ref", "session", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shift_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("usage_shifts.id"),
        nullable=False,
    )
    project_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    # Сессия может быть без тикета: работа постановки идёт до появления номера.
    issue_number: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    issue_title: Mapped[str | None] = mapped_column(String(300), nullable=True, default=None)
    role: Mapped[str] = mapped_column(String(64), nullable=False)
    # Id диалога: он же ключ уникальности в паре с проектом.
    session: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str | None] = mapped_column(String(50), nullable=True, default=None)
    turns: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_cache_read: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_cache_write: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(14, 6),
        nullable=False,
        default=Decimal("0"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    shift: Mapped["UsageShift"] = relationship(back_populates="sessions")
