"""Смена проекта в журнале расхода: строка таблицы `usage_shifts`.

Журнал расхода — вторая половина учёта токенов. Первая живёт в harness: книга привязок
`dev-department-usage.json` знает, какая сессия какому тикету принадлежит, а `usageCard`
считает по стенограммам ходы и токены. Веб ничего не пересчитывает — он **хранит готовую
смену**: интервал, причину закрытия, тарифы расчёта и суммы. Цена считается на стороне
harness уже проверенной формулой (`costOf` в `plugins/usage-ledger.mjs`), поэтому смена
несёт рядом с деньгами и сами тарифы: смена тарифа не переписывает прошлые суммы, и по
строке видно, по какой цене она считалась.

Своих денег у смены нет: `cost_usd` — сумма по принятым сессиям этой смены. Проект
складывает смены, смена складывает сессии, а сессия входит в суммы проекта ровно один
раз (это держит уникальный индекс `usage_sessions`).

`project_ref` — id проекта из реестра отдела, **без внешнего ключа**: реестр живёт
файлом и в вебе может не иметь строки проекта вовсе (проект завели в вебе после первых
смен). Внешний ключ запретил бы журнал такому проекту, а удаление проекта в вебе
уносило бы историю расходов, которая деньгам не принадлежит. `project_title` лежит
рядом строкой: имя проекта меняется, а смена остаётся той, какой была.

Причины закрытия — те же две, что различает harness (`FINISH` в
`plugins/dev-department.mjs`): `window` (окно работы закрылось само) и `manual`
(смену закрыл человек инструментом `dev_department_summary`). Строка `reason` — это
ключ, а не подпись: подписи для человека собирает тот, кто показывает.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.usage_session import UsageSession

# Тарифы расчёта: `{"inputUsdPerM", "cacheReadUsdPerM", "cacheWriteUsdPerM",
# "outputUsdPerM"}` — та же форма, что `usageRates` в `dev-department.json`. На
# PostgreSQL — `JSONB`, в тестах (SQLite) — `JSON`: проверка формы живёт в питоне,
# и поведение диалектов совпадает.
RATES_JSON = JSON().with_variant(JSONB(), "postgresql")


class UsageShift(Base):
    """Одна смена проекта: интервал, тарифы и суммы по принятым сессиям.

    Уникальность пары `(project_ref, shift_key)` — идемпотентность журнала: повторная
    отправка той же смены новой строки не заводит (частичного условия у индекса нет,
    потому что удаления смен не существует ни мягкого, ни физического).
    """

    __tablename__ = "usage_shifts"
    __table_args__ = (
        Index("ix_usage_shifts_project_ref", "project_ref"),
        Index("uq_usage_shifts_project_shift", "project_ref", "shift_key", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Проект из реестра отдела. Ключа на `projects` нет намеренно — см. докстринг модуля.
    project_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    project_title: Mapped[str] = mapped_column(String(200), nullable=False)
    # Ключ смены из `shiftKey(windows, date)`: дата начала смены в местном времени.
    shift_key: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # `window` — окно закрылось, `manual` — смену закрыл человек.
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    # Сколько сессий вошло в суммы этой смены (не сумма по проекту).
    sessions_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_cache_read: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_cache_write: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # Деньги в USD с шестью знаками: тариф за миллион токенов даёт доли цента.
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(14, 6),
        nullable=False,
        default=Decimal("0"),
    )
    # Тарифы, по которым считалась эта смена: пересчёта прошлых смен при их смене нет.
    rates: Mapped[dict[str, Any]] = mapped_column(RATES_JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    # Сессии смены: каскада нет, потому что смены не удаляются вовсе.
    #
    # Загрузка ленивая, а не `selectin`: списки смен (`GET /api/projects/{ref}/usage`
    # и `GET /api/usage/projects`) детализацию не отдают, а `selectin` тянул бы
    # сессии всех смен проекта на каждое открытие страницы — тысячи строк, которые
    # тут же выбрасываются. Детализации (`GET /api/usage/shifts/{id}`) хватает
    # одной ленивой загрузки внутри запроса.
    sessions: Mapped[list[UsageSession]] = relationship(
        back_populates="shift",
        order_by="UsageSession.id",
    )
