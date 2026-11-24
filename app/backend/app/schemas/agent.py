"""Формы ручек `/api/agents`: ответ списка, тело создания и правки, heartbeat.

Проверки полей (обязательность, формат кода, среда, состояние) живут в ручке, а не в
pydantic: тексты отказов — часть контракта и показываются на экране дословно, поэтому
порядок проверок фиксирован (`app/api/agents.py`). Здесь только форма данных.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AgentStatus(BaseModel):
    """Последний heartbeat агента; `state: null` — агент ещё не сообщал."""

    state: str | None
    issue_number: int | None
    seen_at: datetime | None


class AgentItem(BaseModel):
    """Строка `GET /api/agents`: поля справочника и heartbeat."""

    id: int
    code: str
    title: str
    runtime: str
    enabled: bool
    status: AgentStatus


class AgentCreate(BaseModel):
    """Тело `POST /api/agents`: все поля необязательны для собственных текстов отказа."""

    code: Any = None
    title: Any = None
    runtime: Any = None
    enabled: Any = None


class AgentUpdate(BaseModel):
    """Тело `PATCH /api/agents/{id}`: `code` неизменяем и отклоняется отдельным текстом."""

    code: Any = None
    title: Any = None
    runtime: Any = None
    enabled: Any = None


class AgentStatusUpdate(BaseModel):
    """Тело `PUT /api/agents/{code}/status`: машинный heartbeat."""

    state: Any = None
    issue_number: Any = None


class AgentStatusResponse(BaseModel):
    """Ответ heartbeat: код, состояние, тикет и время записи."""

    code: str
    state: str
    issue_number: int | None
    seen_at: datetime
