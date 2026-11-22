"""Модель записи журнала расходов проекта: строка таблицы `project_expenses`.

Запись принадлежит проекту: у неё всегда есть `project_id`. Сумма `amount` — снимок,
посчитанный сервером в момент записи по ценам проекта, а не вычисляемое поле: смена цен
уже записанные суммы не пересчитывает.

Журнал только дополняется: правки и удаления записей в приложении нет, поэтому у строки
нет ни `updated_at`, ни `deleted_at`. Строки переживают мягкое удаление проекта — ручки
журнала по удалённому проекту отвечают `404`, но сами записи остаются в таблице.
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, Numeric, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ProjectExpense(Base):
    """Расход проекта за день: четыре количества токенов и посчитанная сумма.

    `spent_on` — календарный день без времени, `created_at` — момент записи. Порядок
    журнала — `spent_on DESC, id DESC`: свежий день сверху, внутри дня — последняя
    запись сверху.
    """

    __tablename__ = "project_expenses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id"),
        nullable=False,
        index=True,
    )
    spent_on: Mapped[date] = mapped_column(Date, nullable=False)
    tokens_input: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tokens_output: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tokens_cache_read: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tokens_cache_write: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Деньги: `Numeric(20, 6)` — доллары США с шестью знаками, как и у смены: сумма
    # ручной записи и сумма смены печатаются в одной ведомости одним форматом, и
    # округление до копейки потеряло бы расход мелкой записи. Точность с запасом:
    # разрешённые контрактом цена (10 знаков до разделителя) и количество (10^12) дают
    # сумму до 4·10^16, то есть `Numeric(14, 6)` её не держит и PostgreSQL ответил бы
    # `numeric field overflow` на валидном вводе.
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
