"""Схемы журнала расхода смен: тело ответа ручек и форма документа смены.

Контракт этого раздела делится на две половины, и это видно по схемам:

- **документ смены** (`POST /api/usage/shifts`) приходит от harness свободным телом:
  форму знает `plugins/usage-web.mjs`, и вторая её копия в pydantic разошлась бы с
  первой. Проверка формы — валидаторы `app.api.usage`, которые отказывают `422` с
  текстом из контракта. Схемы запроса здесь нет намеренно;
- **ответы** (смены проекта, одна смена, проекты со суммами) читает фронт, поэтому они
  описаны моделями и попадают в OpenAPI: по ним фронт рисует таблицу, не догадываясь о
  форме.

Деньги отдаются строкой ровно с шестью знаками (`"0.420000"`), как и `cost` задачи —
но с шестью, а не двумя: тариф за миллион токенов даёт доли цента, и округлять их
до копейки значило бы терять расход мелкой сессии. `Decimal` приводится к строке
валидатором до проверки типа: `f"{None:.6f}"` падает, поэтому проверка на `None` в нём
обязательна.
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

# Знаков после точки у денег журнала. Шесть, а не два: одна сессия в четверть миллиона
# входных токенов по тарифу $3 за миллион стоит $0.75, а сессия в сотню токенов —
# $0.0003, и это разные деньги, а не «ноль».
MONEY_PLACES = 6
MONEY_QUANTUM = Decimal("0.000001")


def format_money(value: object) -> str:
    """Деньги журнала строкой: `Decimal("0.42")` → `"0.420000"`.

    Приведение к `Decimal` идёт через `str`, а не через `float`: `float` уже потерял
    точность до вызова, и `Decimal(0.1)` вернул бы `0.1000000000000000055...`.
    """
    return f"{Decimal(str(value)):.{MONEY_PLACES}f}"


class UsageTokens(BaseModel):
    """Токены по видам.

    `in` — ключ контракта, а не PEP 8: имена полей здесь диктует документа смены,
    которую собирает harness (`tokens: {in, out, cacheRead, cacheWrite}`), и
    переименовывать их значило бы менять контракт ради стиля.
    """

    in_: int = Field(alias="in")
    out: int
    cacheRead: int
    cacheWrite: int


class UsageRates(BaseModel):
    """Тарифы расчёта, по которым считалась смена (та же форма, что `usageRates`)."""

    inputUsdPerM: float
    cacheReadUsdPerM: float
    cacheWriteUsdPerM: float
    outputUsdPerM: float


class UsageShiftStored(BaseModel):
    """Ответ `POST /api/usage/shifts`: что журнал сделал с присланной сменой.

    `changed: false` — не ошибка и не отказ: смена `(project_ref, shift_key)` уже в
    журнале, и второе тело её не переписало. Числа в ответе в этом случае — текущие
    числа смены из базы, а `accepted` равен нулю: новых сессий не принято.
    """

    shift_id: int
    accepted: int
    skipped: int
    sessions_count: int
    cost_usd: str
    changed: bool

    @field_validator("cost_usd", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str:
        return format_money(value)


class UsageSessionRow(BaseModel):
    """Сессия роли в ответах журнала."""

    role: str
    session: str
    source: str | None
    issue_number: int | None
    issue_title: str | None
    turns: int
    tokens: UsageTokens
    cost_usd: str

    @field_validator("cost_usd", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str:
        return format_money(value)


class UsageShiftRow(BaseModel):
    """Смена в списке смен проекта: без сессий, но с итогами по ним."""

    id: int
    shift_key: str
    started_at: datetime
    ended_at: datetime
    reason: str
    sessions_count: int
    tokens: UsageTokens
    cost_usd: str

    @field_validator("cost_usd", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str:
        return format_money(value)


class UsageShiftDetail(UsageShiftRow):
    """Одна смена целиком: тарифы расчёта и детализация по сессиям."""

    project_ref: str
    project_title: str
    rates: UsageRates
    sessions: list[UsageSessionRow]


class UsageProjectTotals(BaseModel):
    """Итоги проекта по журналу: смены, сессии и деньги."""

    shifts: int
    sessions: int
    tokens: UsageTokens
    cost_usd: str

    @field_validator("cost_usd", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str:
        return format_money(value)


class UsageProjectUsage(BaseModel):
    """Ответ `GET /api/projects/{project_ref}/usage`."""

    project_ref: str
    project_title: str
    totals: UsageProjectTotals
    shifts: list[UsageShiftRow]


class UsageProjectTotal(BaseModel):
    """Строка списка проектов со суммами: ответ `GET /api/usage/projects`."""

    project_ref: str
    project_title: str
    shifts: int
    sessions: int
    tokens: UsageTokens
    cost_usd: str
    last_shift_at: datetime

    @field_validator("cost_usd", mode="before")
    @classmethod
    def _format_cost(cls, value: object) -> str:
        return format_money(value)
