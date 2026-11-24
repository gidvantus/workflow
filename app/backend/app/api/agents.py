"""Ручки раздела «Агенты»: справочник агентов и машинный heartbeat.

Агент — исполнитель ступени конвейера. Ступень агента не выбирает: агент стоит на
**теге** проекта (`tags[].agent` документа процесса), а ступень берёт его из своих
входящих тегов. Поэтому здесь только справочник: `GET`, `POST`, `PATCH`, `DELETE` и
`PUT /api/agents/{code}/status` для heartbeat.

**Код.** `code` задаётся при создании и не меняется: по нему приходит heartbeat, и
смена кода молча отвязала бы работающего агента от тегов. Удаление мягкое: строка
остаётся, код занят навсегда (`uq_agents_code` не частичный).

**Heartbeat машинный.** `PUT /api/agents/{code}/status` требует заголовок
`X-Registry-Token`, как остальные машинные ручки: её вызывает диспетчер, а не человек.
Запись двигает `last_state`, `last_issue` и `last_seen_at`; `GET /api/agents` и документ
реестра отдают именно её.

**Тексты отказов** — часть контракта: экран показывает `detail` дословно, поэтому
формулировки собраны константами и нигде больше не сочиняются. Порядок проверок
фиксирован — код, формат, занятость, — чтобы на теле с двумя ошибками ответ был
предсказуемым.
"""

import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.registry import require_registry_token
from app.db import get_db
from app.models.agent import (
    AGENT_RUNTIMES,
    AGENT_STATES,
    DEFAULT_AGENT_RUNTIME,
    Agent,
)
from app.schemas.agent import (
    AgentCreate,
    AgentItem,
    AgentStatus,
    AgentStatusResponse,
    AgentStatusUpdate,
    AgentUpdate,
)

router = APIRouter(prefix="/api/agents", tags=["agents"])

DbSession = Annotated[Session, Depends(get_db)]

# Слаг кода агента: латиница, цифры и дефис; первый символ — не дефис. Регистр не
# принимается: код стоит в тегах и приходит в heartbeat, и два регистра одного кода
# развели бы одного агента на двоих.
CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")

CODE_MAX_LENGTH = 50
TITLE_MAX_LENGTH = 100

# Тексты отказов — часть контракта: человек и фронт видят их дословно.
CODE_REQUIRED = "Укажите код агента"
CODE_FORMAT = "Код агента: латиница, цифры и дефис"
CODE_TOO_LONG = "Код агента длиннее 50 символов"
CODE_TAKEN = "Код агента занят"
CODE_IMMUTABLE = "Код агента не меняется"
TITLE_REQUIRED = "Укажите название агента"
TITLE_TOO_LONG = "Название агента длиннее 100 символов"
RUNTIME_INVALID = "Среда агента указывается как dsh, opencode или http"
AGENT_NOT_FOUND = "Агент не найден"
STATE_INVALID = "Состояние агента указывается как idle или busy"
NO_FIELDS_TO_UPDATE = "Нет полей для изменения"


def _reject(detail: str) -> HTTPException:
    """Отказ проверки: `422` с текстом, который фронт показывает дословно."""
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _now() -> datetime:
    """Текущее время в UTC: `seen_at` и `updated_at` двигаются явно."""
    return datetime.now(UTC)


def _text(raw: Any) -> str:
    """Строковое поле из тела: `None` и не строка читаются как пустая строка."""
    return raw.strip() if isinstance(raw, str) else ""


def _code(raw: Any) -> str:
    """Код агента: обязателен, укладывается в предел и состоит из разрешённых символов."""
    value = _text(raw)
    if not value:
        raise _reject(CODE_REQUIRED)
    if len(value) > CODE_MAX_LENGTH:
        raise _reject(CODE_TOO_LONG)
    if not CODE_PATTERN.match(value):
        raise _reject(CODE_FORMAT)
    return value


def _title(raw: Any) -> str:
    """Название агента: непустое после обрезки и не длиннее предела."""
    value = _text(raw)
    if not value:
        raise _reject(TITLE_REQUIRED)
    if len(value) > TITLE_MAX_LENGTH:
        raise _reject(TITLE_TOO_LONG)
    return value


def _runtime(raw: Any) -> str:
    """Среда агента: одно из `dsh`/`opencode`/`http`, по умолчанию `http`."""
    if raw is None:
        return DEFAULT_AGENT_RUNTIME
    if not isinstance(raw, str) or raw not in AGENT_RUNTIMES:
        raise _reject(RUNTIME_INVALID)
    return raw


def _enabled(raw: Any) -> bool:
    """Флажок «включён»: отсутствие и `None` — `True`, не булево — отказ формы."""
    if raw is None:
        return True
    if not isinstance(raw, bool):
        raise _reject("Нужен объект агента с полями code, title, runtime, enabled")
    return raw


def _alive_agent(db: Session, agent_id: int) -> Agent:
    """Живой агент по id. Удалённый — `404`: воскрешения через `PATCH` не бывает."""
    agent = db.get(Agent, agent_id)
    if agent is None or agent.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, AGENT_NOT_FOUND)
    return agent


def _alive_agent_by_code(db: Session, code: str) -> Agent:
    """Живой агент по коду: heartbeat адресуется кодом, а не id."""
    agent = db.scalar(select(Agent).where(Agent.code == code, Agent.deleted_at.is_(None)))
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, AGENT_NOT_FOUND)
    return agent


def _code_taken(db: Session, code: str) -> bool:
    """Занят ли код. Мягко удалённые строки тоже считаются: код не переиспользуют."""
    return db.scalar(select(Agent.id).where(func.lower(Agent.code) == code)) is not None


def _status(agent: Agent) -> AgentStatus:
    """Heartbeat агента в форме ответа: `NULL` состояния — «не сообщал»."""
    return AgentStatus(
        state=agent.last_state,
        issue_number=agent.last_issue,
        seen_at=agent.last_seen_at,
    )


def _item(agent: Agent) -> AgentItem:
    """Строка ответа: поля справочника и heartbeat."""
    return AgentItem(
        id=agent.id,
        code=agent.code,
        title=agent.title,
        runtime=agent.runtime,
        enabled=agent.enabled,
        status=_status(agent),
    )


@router.get("", response_model=list[AgentItem], summary="Список живых агентов")
def list_agents(db: DbSession) -> list[AgentItem]:
    """Живые агенты в порядке `id` (он же порядок создания из веба)."""
    agents: Sequence[Agent] = db.scalars(
        select(Agent).where(Agent.deleted_at.is_(None)).order_by(Agent.id)
    ).all()
    return [_item(agent) for agent in agents]


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=AgentItem,
    summary="Создать агента",
)
def create_agent(payload: AgentCreate, db: DbSession) -> AgentItem:
    """Новый агент: код задаётся здесь и дальше не меняется."""
    code = _code(payload.code)
    title = _title(payload.title)
    runtime = _runtime(payload.runtime)
    enabled = _enabled(payload.enabled)
    if _code_taken(db, code):
        raise HTTPException(status.HTTP_409_CONFLICT, CODE_TAKEN)

    agent = Agent(code=code, title=title, runtime=runtime, enabled=enabled, updated_at=_now())
    db.add(agent)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, CODE_TAKEN) from error
    db.refresh(agent)
    return _item(agent)


@router.patch("/{agent_id}", response_model=AgentItem, summary="Править агента")
def update_agent(agent_id: int, payload: AgentUpdate, db: DbSession) -> AgentItem:
    """`title`, `runtime`, `enabled`; `code` неизменяем, пустое тело — отказ."""
    agent = _alive_agent(db, agent_id)
    fields = payload.model_fields_set
    if "code" in fields:
        raise _reject(CODE_IMMUTABLE)
    if not fields:
        raise _reject(NO_FIELDS_TO_UPDATE)
    if "title" in fields:
        agent.title = _title(payload.title)
    if "runtime" in fields:
        agent.runtime = _runtime(payload.runtime)
    if "enabled" in fields:
        if not isinstance(payload.enabled, bool):
            raise _reject("Нужен объект агента с полями code, title, runtime, enabled")
        agent.enabled = payload.enabled
    agent.updated_at = _now()
    db.commit()
    db.refresh(agent)
    return _item(agent)


@router.delete(
    "/{agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Мягко удалить агента",
)
def delete_agent(agent_id: int, db: DbSession) -> Response:
    """Мягкое удаление: строка остаётся, код занят навсегда."""
    agent = _alive_agent(db, agent_id)
    agent.deleted_at = _now()
    agent.updated_at = _now()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{code}/status",
    response_model=AgentStatusResponse,
    summary="Heartbeat агента",
    dependencies=[Depends(require_registry_token)],
)
def put_agent_status(
    code: str,
    payload: AgentStatusUpdate,
    db: DbSession,
) -> dict[str, Any]:
    """`idle`/`busy` и номер тикета от агента; `404` — агента нет, `422` — кривое состояние.

    Тело разбирается вручную: `422` обязан вернуть текст контракта «Состояние агента
    указывается как idle или busy», а не машинную ошибку pydantic.
    """
    agent = _alive_agent_by_code(db, code)
    state = payload.state
    if not isinstance(state, str) or state not in AGENT_STATES:
        raise _reject(STATE_INVALID)
    issue_number = payload.issue_number
    if issue_number is not None and (
        isinstance(issue_number, bool) or not isinstance(issue_number, int)
    ):
        raise _reject(STATE_INVALID)
    seen_at = _now()
    agent.last_state = state
    agent.last_issue = issue_number
    agent.last_seen_at = seen_at
    agent.updated_at = seen_at
    db.commit()
    db.refresh(agent)
    return {
        "code": agent.code,
        "state": state,
        "issue_number": issue_number,
        "seen_at": seen_at,
    }
