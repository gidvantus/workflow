"""Справочник агентов: строка таблицы `agents`.

Агент — исполнитель ступени конвейера. Ступень не хранит агента: агент выбирается на
**теге** проекта (документ процесса, `tags[].agent`), а ступень берёт его из своих
входящих тегов. Поэтому таблицы связи «отдел — агент» нет: отдел ссылается на агента
только кодом внутри тега.

`code` — стабильный человеческий слаг (`opencode`, `verify-ci`, `dsh`): по нему
приходит машинный heartbeat `PUT /api/agents/{code}/status`, поэтому код не меняется.
Код мягко удалённого агента занят навсегда — уникальный индекс `uq_agents_code` не
частичный и видит удалённые строки, как у `roles`.

`runtime` — среда исполнения агента (`dsh`, `opencode`, `http`). В этой задаче второй
рантайм диспетчер не запускает: поле только называется и показывается на экране.
`last_state`/`last_issue`/`last_seen_at` — последний heartbeat; `NULL` в `last_state`
значит «агент ещё не сообщал».
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Среды исполнения агента: `dsh` — сам диспетчер, `opencode` и `http` — гости.
AGENT_RUNTIMES: tuple[str, ...] = ("dsh", "opencode", "http")
DEFAULT_AGENT_RUNTIME = "http"

# Состояния heartbeat: `busy` — агент работает над тикетом, `idle` — свободен.
AGENT_STATES: tuple[str, ...] = ("idle", "busy")

# Код самого диспетчера: он ставит себе heartbeat перед каждым ходом. Тег, отданный
# этому агенту, владельцем ступени не считается — ступень остаётся за `dsh`.
DISPATCHER_AGENT_CODE = "dsh"


class Agent(Base):
    """Агент справочника: код для тега и heartbeat, название — для человека."""

    __tablename__ = "agents"
    __table_args__ = (Index("uq_agents_code", "code", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    runtime: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=DEFAULT_AGENT_RUNTIME,
        server_default=DEFAULT_AGENT_RUNTIME,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    # Последний heartbeat: `NULL` в `last_state` — агент ещё не выходил на связь.
    last_state: Mapped[str | None] = mapped_column(String(20), nullable=True, default=None)
    last_issue: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    # Признак soft delete: `NULL` — агент живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
