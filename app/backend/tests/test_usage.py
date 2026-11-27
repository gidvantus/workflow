"""Журнал расхода смен: приём смены от harness и суммы в разрезе проекта.

Это контракт с плагином отдела (`plugins/usage-web.mjs`): harness закрывает смену и
присылает по каждой сессии ходы и токены — **без денег**. Сумму считает сервер по ценам
проекта (`projects.price_*`, доллары США за 1 000 000 токенов) той же формулой, что и
ручные записи журнала (`app.money.amount_for`). Поэтому здесь проверяется не только «ручка
ответила», но и правила, ради которых журнал заведён:

- **одна формула денег**: цена сессии — количества × цены проекта / 1 000 000, шесть
  знаков, округление одно на сумму; смена прайса не переписывает прошлые смены (у каждой
  лежит снимок цен в `usage_shifts.rates`);
- **старое тело принимается**: `rates`, `cost_usd` в сессиях и `totals` игнорируются —
  в очереди отдела лежат смены в старом формате, и `422` на них терял бы расход;
- **проекта нет или цены нулевые** — смена принимается с нулевой суммой, а не отвергается;
- **итог проекта прибавляется** в той же транзакции, что и смена: журнал расходов
  (`/api/projects/{id}/expenses`) показывает её своей строкой и в `total`;
- **идемпотентность**: повторная отправка той же смены `(project_ref, shift_key)` даёт
  `200` с `changed: false`, новых строк не заводит и денег проекту не прибавляет;
- **одна сессия один раз**: «продолженный диалог» из прошлой смены приезжает второй раз,
  пропускается (`skipped`) и остаётся за той сменой, которая записала его первой;
- **закрытый набор отказов**: каждому случаю из контракта — свой текст в `detail`,
  проверяется дословно, потому что harness показывает его человеку;
- **деньги строкой с шестью знаками**: `"0.006900"`, а не `0.0069` и не `"0.0069"`;
- **токен надстройки**: без `X-Registry-Token` отвечает `401` только приём смены;
  чтение сумм токена не требует — это ручки браузера.

Разбор документа смены на стороне harness и очередь недоотправленного — половина
harness, её тест `plugins/tools/tests/usage-web.test.mjs`.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main
from app.api import usage as usage_api
from app.api.registry import TOKEN_REJECTED
from app.api.usage import (
    FIELD_TOO_LONG,
    NEGATIVE_COST,
    PROJECT_REF_REQUIRED,
    REASON_INVALID,
    SESSION_IDENTITY_REQUIRED,
    SESSION_NUMBERS_INVALID,
    SHIFT_KEY_REQUIRED,
    SHIFT_NOT_FOUND,
    SHIFT_TIME_INVALID,
    SHIFT_WRITE_RACE,
    TOO_MANY_SESSIONS,
)
from app.config import Settings, get_settings

SHIFTS_URL = "/api/usage/shifts"
PROJECTS_URL = "/api/usage/projects"

TOKEN = "stand-token"
AUTH = {"X-Registry-Token": TOKEN}

PROJECT = "workflow"
TITLE = "Workflow"
SHIFT_KEY = "2024-05-01"

# Прайс проекта — доллары США за 1 000 000 токенов: те же числа, что у Mac-модели
# приёмки (0,27 / 1,10 / 0,07 / 0,34 — это рубли старого прайса; здесь доллары).
PRICES: dict[str, str] = {
    "price_input": "3",
    "price_output": "15",
    "price_cache_read": "0.3",
    "price_cache_write": "3.75",
}

# Прайс соседнего проекта: заведомо дороже, чтобы «дороже всех» в списке было однозначно.
OTHER_PRICES: dict[str, str] = {
    "price_input": "300",
    "price_output": "15",
    "price_cache_read": "0.3",
    "price_cache_write": "3.75",
}

# Токены сессии по умолчанию. По `PRICES` они стоят
# (1000 × 3 + 200 × 15 + 3000 × 0,3) / 1 000 000 = 0,0069 → `"0.006900"`.
DAILY_TOKENS: dict[str, int] = {"in": 1000, "out": 200, "cacheRead": 3000, "cacheWrite": 0}
DAILY_COST = "0.006900"

# Стоимость сессии по умолчанию для прайса `OTHER_PRICES`:
# (1000 × 300 + 200 × 15 + 3000 × 0,3) / 1 000 000 = 0,3039 → `"0.303900"`.
OTHER_DAILY_COST = "0.303900"


def _create_project(
    client: TestClient,
    *,
    code: str = PROJECT,
    name: str = TITLE,
    prices: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Проект с кодом и ценами: смену сервер ценит по ценам проекта, а не по телу."""
    payload: dict[str, Any] = {
        "name": name,
        "repo_url": f"gidvantus/{code}",
        "code": code,
        **(PRICES if prices is None else prices),
    }
    response = client.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.fixture(name="api")
def api_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с заданным токеном надстройки: без него приём смены отвечает `401`."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite://", registry_token=TOKEN
    )
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


@pytest.fixture(name="project")
def project_fixture(api: TestClient) -> dict[str, Any]:
    """Проект `workflow` с ценами: смена находит его по `project_ref`."""
    return _create_project(api)


def session_body(
    *,
    role: str = "dev-backend",
    session: str = "sess-1",
    issue_number: int | None = 57,
    issue_title: str | None = "Журнал расхода смены",
    source: str | None = "issue-created",
    turns: int = 2,
    tokens: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Одна сессия смены в форме контракта: количества и ходы, без денег."""
    return {
        "role": role,
        "session": session,
        "issue_number": issue_number,
        "issue_title": issue_title,
        "source": source,
        "turns": turns,
        "tokens": DAILY_TOKENS if tokens is None else tokens,
    }


def shift_body(
    *,
    project_ref: str = PROJECT,
    project_title: str = TITLE,
    shift_key: str = SHIFT_KEY,
    sessions: list[dict[str, Any]] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """Документ смены: сессии по умолчанию; суммы и тарифов в теле нет."""
    body: dict[str, Any] = {
        "project_ref": project_ref,
        "project_title": project_title,
        "shift_key": shift_key,
        "started_at": "2024-05-01T10:00:00Z",
        "ended_at": "2024-05-01T18:00:00Z",
        "reason": "window",
        "sessions": [session_body()] if sessions is None else sessions,
    }
    body.update(overrides)
    return body


def post_shift(api: TestClient, body: dict[str, Any]) -> Any:
    """Отправить смену с токеном надстройки."""
    return api.post(SHIFTS_URL, json=body, headers=AUTH)


def journal(api: TestClient, project: dict[str, Any]) -> dict[str, Any]:
    """Журнал расходов проекта — вторая половина того же итога."""
    response = api.get(f"/api/projects/{project['id']}/expenses")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# ── токен надстройки ────────────────────────────────────────────────────────


def test_store_shift_requires_token(api: TestClient) -> None:
    """Без заголовка `X-Registry-Token` смена не принимается."""
    response = api.post(SHIFTS_URL, json=shift_body())

    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REJECTED


def test_store_shift_rejects_wrong_token(api: TestClient) -> None:
    """Чужой токен — тот же отказ, что и отсутствие заголовка."""
    response = api.post(
        SHIFTS_URL, json=shift_body(), headers={"X-Registry-Token": "not-the-token"}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REJECTED


def test_read_usage_needs_no_token(client: TestClient) -> None:
    """Чтение сумм — ручка браузера: токен надстройки ей не нужен."""
    response = client.get(f"/api/projects/{PROJECT}/usage")

    # Смен ещё нет — это `404`, а не `401`: ручка открыта, но журнал пуст.
    assert response.status_code == 404


# ── приём смены и цена по прайсу проекта ───────────────────────────────────


def test_store_shift_creates_it(api: TestClient, project: dict[str, Any]) -> None:
    """Первая отправка смены — `201`, все сессии приняты, сумма по ним и по прайсу."""
    body = shift_body(
        sessions=[
            session_body(session="sess-1"),
            session_body(role="code-review", session="sess-2"),
        ]
    )

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json() == {
        "shift_id": 1,
        "accepted": 2,
        "skipped": 0,
        "sessions_count": 2,
        # Две сессии по 0,0069: сумму посчитал сервер, в теле её не было.
        "cost_usd": "0.013800",
        "changed": True,
    }


def test_shift_is_priced_by_own_session_tokens(api: TestClient, project: dict[str, Any]) -> None:
    """Разные токены — разные деньги: сумма не берётся из тела и не равна единице."""
    body = shift_body(
        sessions=[
            session_body(
                session="sess-big",
                tokens={"in": 1_000_000, "out": 0, "cacheRead": 0, "cacheWrite": 0},
            ),
            session_body(
                session="sess-small",
                tokens={"in": 100, "out": 0, "cacheRead": 0, "cacheWrite": 0},
            ),
        ]
    )

    response = post_shift(api, body)

    assert response.status_code == 201
    # 1 000 000 × 3 / 1 000 000 = 3,00; 100 × 3 / 1 000 000 = 0,0003.
    assert response.json()["cost_usd"] == "3.000300"


def test_old_body_fields_are_ignored(api: TestClient, project: dict[str, Any]) -> None:
    """`rates`, `cost_usd` в сессиях и `totals` из старого формата не читаются и не мешают.

    В очереди отдела (`dev-department-usage-queue.json`) лежат смены, собранные до этой
    правки; отказ `422` на них `isRetryable` считает невременным и выбрасывает запись —
    расход пропадал бы молча. Поэтому старые поля принимаются и игнорируются.
    """
    old_session = {
        **session_body(session="sess-1"),
        "cost_usd": 99.0,
    }
    body = {
        **shift_body(sessions=[old_session]),
        "rates": {
            "inputUsdPerM": 1.0,
            "outputUsdPerM": 2.0,
            "cacheReadUsdPerM": 0.5,
            "cacheWriteUsdPerM": 3.0,
        },
        "totals": {"cost_usd": 99.0},
    }

    response = post_shift(api, body)

    assert response.status_code == 201, response.text
    # Ни присланная цена сессии, ни присланный итог не стали деньгами: считает сервер.
    assert response.json()["cost_usd"] == DAILY_COST


def test_shift_without_project_is_accepted_with_zero_cost(api: TestClient) -> None:
    """Проекта в вебе нет — смена принимается с нулевой суммой, а не отвергается.

    Отказ выбросил бы смену из очереди отдела и потерял бы расход навсегда: проект
    могли ещё не завести, а деньги проекта появятся, когда он появится.
    """
    response = post_shift(api, shift_body(project_ref="not-created-yet"))

    assert response.status_code == 201, response.text
    assert response.json()["cost_usd"] == "0.000000"
    assert response.json()["accepted"] == 1


def test_shift_with_zero_prices_is_accepted_with_zero_cost(api: TestClient) -> None:
    """Все четыре цены нулевые — нулевая сумма, и это тоже не отказ."""
    empty_prices = {
        "price_input": "0",
        "price_output": "0",
        "price_cache_read": "0",
        "price_cache_write": "0",
    }
    _create_project(api, prices=empty_prices)

    response = post_shift(api, shift_body())

    assert response.status_code == 201
    assert response.json()["cost_usd"] == "0.000000"


def test_shift_price_snapshot_is_project_prices(api: TestClient, project: dict[str, Any]) -> None:
    """Снимок цен смены — цены проекта в момент записи; смена прайса прошлых не меняет."""
    first = post_shift(api, shift_body()).json()

    patched = api.patch(
        f"/api/projects/{project['id']}", json={"price_input": "10", "price_output": "0"}
    )
    assert patched.status_code == 200, patched.text

    second = post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            started_at="2024-05-02T10:00:00Z",
            ended_at="2024-05-02T18:00:00Z",
            sessions=[session_body(session="sess-2")],
        ),
    ).json()

    # (1000 × 10 + 200 × 0 + 3000 × 0,3) / 1 000 000 = 0,0109.
    assert second["cost_usd"] == "0.010900"
    # Первая смена осталась посчитанной по прежнему прайсу.
    detail = api.get(f"/api/usage/shifts/{first['shift_id']}").json()
    assert detail["cost_usd"] == DAILY_COST
    assert detail["rates"] == {
        "inputUsdPerM": 3.0,
        "outputUsdPerM": 15.0,
        "cacheReadUsdPerM": 0.3,
        "cacheWriteUsdPerM": 3.75,
    }


def test_shift_is_added_to_project_total(api: TestClient, project: dict[str, Any]) -> None:
    """Смена прибавляется к итогу проекта в той же транзакции: журнал её показывает."""
    post_shift(api, shift_body())

    body = journal(api, project)

    assert body["total"] == DAILY_COST
    assert len(body["items"]) == 1
    row = body["items"][0]
    assert row["kind"] == "shift"
    assert row["amount"] == DAILY_COST
    assert row["spent_on"] == "2024-05-01"
    assert row["tokens"] == DAILY_TOKENS
    assert row["reason"] == "window"
    assert row["sessions_count"] == 1
    assert row["started_at"].startswith("2024-05-01T10:00:00")
    assert row["ended_at"].startswith("2024-05-01T18:00:00")


def test_store_shift_is_idempotent(api: TestClient, project: dict[str, Any]) -> None:
    """Повторная отправка той же смены — `200` с `changed: false` и теми же числами."""
    body = shift_body()

    first = post_shift(api, body)
    second = post_shift(api, body)

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json() == {
        "shift_id": first.json()["shift_id"],
        "accepted": 0,
        "skipped": 1,
        "sessions_count": 1,
        "cost_usd": DAILY_COST,
        "changed": False,
    }


def test_repeat_shift_does_not_add_money(api: TestClient, project: dict[str, Any]) -> None:
    """Повтор смены не прибавляет денег проекту: сумма считается по строкам журнала."""
    post_shift(api, shift_body())
    post_shift(api, shift_body())

    totals = api.get(f"/api/projects/{PROJECT}/usage").json()["totals"]

    assert totals["shifts"] == 1
    assert totals["sessions"] == 1
    assert totals["cost_usd"] == DAILY_COST
    assert journal(api, project)["total"] == DAILY_COST


def test_carried_session_counts_once(api: TestClient, project: dict[str, Any]) -> None:
    """Сессия, взятая сменой из прошлой смены, входит в суммы проекта один раз.

    Она остаётся за той сменой, которая записала её первой: так суммы проекта не
    удваиваются. Это осознанное расхождение с текстом Telegram-сводки, где цифра дня.
    """
    carried = session_body(session="sess-carried")
    post_shift(api, shift_body(shift_key="2024-05-01", sessions=[carried]))

    second = post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            sessions=[
                carried,
                session_body(session="sess-new"),
            ],
        ),
    )

    assert second.status_code == 201
    assert second.json()["accepted"] == 1
    assert second.json()["skipped"] == 1
    assert second.json()["sessions_count"] == 1
    assert second.json()["cost_usd"] == DAILY_COST

    totals = api.get(f"/api/projects/{PROJECT}/usage").json()["totals"]
    assert totals["shifts"] == 2
    assert totals["sessions"] == 2
    assert totals["cost_usd"] == "0.013800"
    assert journal(api, project)["total"] == "0.013800"


def test_session_repeated_inside_one_shift_counts_once(
    api: TestClient,
    project: dict[str, Any],
) -> None:
    """Повтор сессии внутри одного тела считается так же, как повтор между сменами."""
    body = shift_body(
        sessions=[
            session_body(session="sess-1"),
            session_body(session="sess-1", role="code-review"),
        ]
    )

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json()["accepted"] == 1
    assert response.json()["skipped"] == 1
    assert response.json()["cost_usd"] == DAILY_COST


def test_shift_without_sessions_is_accepted(api: TestClient, project: dict[str, Any]) -> None:
    """Пустая смена — валидная запись: смена была, расхода в ней не случилось."""
    body = shift_body(sessions=[])

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json()["sessions_count"] == 0
    assert response.json()["cost_usd"] == "0.000000"


def test_project_title_falls_back_to_ref(api: TestClient, project: dict[str, Any]) -> None:
    """Пустое название проекта берётся из его id: подпись, а не ключ."""
    body = shift_body(project_title="   ")

    post_shift(api, body)

    usage = api.get(f"/api/projects/{PROJECT}/usage").json()
    assert usage["project_title"] == PROJECT


def test_shift_sums_only_accepted_sessions(api: TestClient, project: dict[str, Any]) -> None:
    """Токены смены — сумма принятых сессий, а не всего присланного тела."""
    post_shift(api, shift_body(sessions=[session_body(session="sess-1")]))
    response = post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            sessions=[
                session_body(
                    session="sess-1",
                    tokens={"in": 10**6, "out": 0, "cacheRead": 0, "cacheWrite": 0},
                ),
                session_body(
                    session="sess-2",
                    tokens={"in": 100, "out": 20, "cacheRead": 30, "cacheWrite": 40},
                ),
            ],
        ),
    )

    assert response.status_code == 201
    detail = api.get(f"/api/usage/shifts/{response.json()['shift_id']}").json()
    assert detail["tokens"] == {"in": 100, "out": 20, "cacheRead": 30, "cacheWrite": 40}


# ── отказы контракта ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("overrides", "text"),
    [
        ({"project_ref": None}, PROJECT_REF_REQUIRED),
        ({"project_ref": "   "}, PROJECT_REF_REQUIRED),
        ({"shift_key": None}, SHIFT_KEY_REQUIRED),
        ({"started_at": None}, SHIFT_TIME_INVALID),
        ({"ended_at": "вчера"}, SHIFT_TIME_INVALID),
        (
            {"started_at": "2024-05-01T18:00:00Z", "ended_at": "2024-05-01T10:00:00Z"},
            SHIFT_TIME_INVALID,
        ),
        ({"reason": "переработка"}, REASON_INVALID),
        ({"reason": None}, REASON_INVALID),
    ],
    ids=[
        "нет-проекта",
        "пустой-проект",
        "нет-ключа-смены",
        "нет-начала",
        "конец-не-дата",
        "конец-раньше-начала",
        "неизвестная-причина",
        "нет-причины",
    ],
)
def test_shift_refusals(api: TestClient, overrides: dict[str, Any], text: str) -> None:
    """Каждый случай отказа из контракта отвечает своим текстом, дословно."""
    response = post_shift(api, shift_body(**overrides))

    assert response.status_code == 422
    assert response.json()["detail"] == text


@pytest.mark.parametrize(
    ("session", "text"),
    [
        ({"role": None}, SESSION_IDENTITY_REQUIRED),
        ({"session": None}, SESSION_IDENTITY_REQUIRED),
        ({"role": "  ", "session": " "}, SESSION_IDENTITY_REQUIRED),
        (
            {"tokens": {"in": -1, "out": 0, "cacheRead": 0, "cacheWrite": 0}},
            NEGATIVE_COST,
        ),
        (
            {"tokens": {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": -5}},
            NEGATIVE_COST,
        ),
        (
            {"tokens": {"in": "много", "out": 0, "cacheRead": 0, "cacheWrite": 0}},
            SESSION_NUMBERS_INVALID,
        ),
        ({"turns": -1}, SESSION_NUMBERS_INVALID),
        ({"turns": 1.5}, SESSION_NUMBERS_INVALID),
    ],
    ids=[
        "нет-роли",
        "нет-id-сессии",
        "пустые-роль-и-id",
        "токены-отрицательные",
        "токены-кэша-отрицательные",
        "токены-не-число",
        "ходы-отрицательные",
        "ходы-дробные",
    ],
)
def test_session_refusals(api: TestClient, session: dict[str, Any], text: str) -> None:
    """Сессия проверяется по одному полю, текст отказа — из контракта."""
    broken = {**session_body(), **session}
    body = shift_body(sessions=[broken])

    response = post_shift(api, body)

    assert response.status_code == 422
    assert response.json()["detail"] == text


def test_too_long_value_is_refused(api: TestClient) -> None:
    """Значение сверх колонки — `422`, а не `500` от PostgreSQL.

    Это защита от сломанного отправителя, а не отказ для человека: в таблицу
    контракта она не входит.
    """
    response = post_shift(api, shift_body(project_ref="п" * 65))

    assert response.status_code == 422
    assert response.json()["detail"] == FIELD_TOO_LONG.format(field="project_ref", limit=64)


def test_too_many_sessions(api: TestClient) -> None:
    """Больше 500 сессий в одной смене — отказ с просьбой разбить смену."""
    sessions = [session_body(session=f"sess-{i}", tokens={}) for i in range(501)]

    response = post_shift(api, shift_body(sessions=sessions))

    assert response.status_code == 422
    assert response.json()["detail"] == TOO_MANY_SESSIONS


def test_cost_beyond_column_is_skipped(api: TestClient) -> None:
    """Сессия дороже разрядности колонки пропускается, а не отвергает всю смену.

    Раньше сумма присылалась в теле, и её разрядность проверялась там же. Теперь сумму
    считает сервер: опечатка в цене проекта (`price_input` = 10^9) даёт сессию дороже
    `Numeric(14,6)`, и `422` здесь означал бы потерю расхода всей смены — очередь отдела
    считает `422` невременным отказом и выбрасывает запись. Поэтому такая сессия уходит
    в `skipped`, а остальные принимаются.
    """
    _create_project(api, prices={**PRICES, "price_input": "1000000000"})
    body = shift_body(
        sessions=[
            session_body(
                session="sess-huge",
                tokens={"in": 10**12, "out": 0, "cacheRead": 0, "cacheWrite": 0},
            ),
            session_body(session="sess-small", tokens=DAILY_TOKENS),
        ]
    )

    response = post_shift(api, body)

    assert response.status_code == 201, response.text
    body_json = response.json()
    assert body_json["accepted"] == 1
    assert body_json["skipped"] == 1
    assert body_json["sessions_count"] == 1
    # Деньги смены — по принятой сессии: (1000 × 10^9 + 200 × 15 + 3000 × 0,3) / 10^6.
    assert body_json["cost_usd"] == "1000000.003900"


def test_cost_beyond_column_skips_only_the_session(api: TestClient) -> None:
    """Токены пропущенной сессии не попадают в смену: количества сходятся с деньгами."""
    _create_project(api, prices={**PRICES, "price_input": "1000000000"})
    body = shift_body(
        sessions=[
            session_body(
                session="sess-huge",
                tokens={"in": 10**12, "out": 0, "cacheRead": 0, "cacheWrite": 0},
            )
        ]
    )

    stored = post_shift(api, body)

    assert stored.status_code == 201, stored.text
    assert stored.json()["sessions_count"] == 0
    assert stored.json()["cost_usd"] == "0.000000"
    detail = api.get(f"/api/projects/{PROJECT}/usage")
    assert detail.status_code == 200, detail.text
    assert detail.json()["totals"]["tokens"] == {
        "in": 0,
        "out": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
    }


def test_flush_conflict_is_not_a_500(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Конфликт уникального индекса на `flush` — штатный ответ, а не `500`.

    Так выглядит настоящая гонка двух одновременных `POST`: предварительная проверка
    пары `(project_ref, shift_key)` ещё ничего не нашла, а вставка уже наткнулась на
    строку соперника. Проверку подменяем на «ничего не найдено»: в тестах с одним
    клиентом соперника иначе не создать, а `flush` при этом срабатывает настоящий.
    """
    monkeypatch.setattr(usage_api, "_find_shift", lambda *args, **kwargs: None)

    assert post_shift(api, shift_body()).status_code == 201

    second = post_shift(api, shift_body())

    assert second.status_code == 409
    assert second.json()["detail"] == SHIFT_WRITE_RACE


def test_broken_body_is_refused(api: TestClient) -> None:
    """Тело не-объект — отказ по первому правилу, а не `500`."""
    response = api.post(SHIFTS_URL, json=[], headers=AUTH)

    assert response.status_code == 422
    assert response.json()["detail"] == PROJECT_REF_REQUIRED


# ── чтение: смены проекта ───────────────────────────────────────────────────


def test_project_usage_without_shifts(api: TestClient) -> None:
    """Проект без смен — `404`: журнал отдельный от реестра, смен у него нет."""
    response = api.get(f"/api/projects/{PROJECT}/usage")

    assert response.status_code == 404
    assert response.json()["detail"] == "Проект не найден"


def test_project_usage_lists_shifts_newest_first(api: TestClient, project: dict[str, Any]) -> None:
    """Смены идут от новых к старым, итоги — по всем."""
    post_shift(
        api,
        shift_body(shift_key="2024-05-01", sessions=[session_body(session="a")]),
    )
    post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            started_at="2024-05-02T10:00:00Z",
            ended_at="2024-05-02T18:00:00Z",
            sessions=[
                session_body(
                    session="b",
                    tokens={"in": 2_000_000, "out": 0, "cacheRead": 0, "cacheWrite": 0},
                )
            ],
        ),
    )

    response = api.get(f"/api/projects/{PROJECT}/usage")

    assert response.status_code == 200
    body = response.json()
    assert body["project_ref"] == PROJECT
    assert body["project_title"] == TITLE
    assert [shift["shift_key"] for shift in body["shifts"]] == ["2024-05-02", "2024-05-01"]
    assert body["totals"] == {
        "shifts": 2,
        "sessions": 2,
        "tokens": {"in": 2_001_000, "out": 200, "cacheRead": 3000, "cacheWrite": 0},
        # 0,0069 (первая смена) + 6,00 (вторая: 2 000 000 × 3 / 1 000 000).
        "cost_usd": "6.006900",
    }
    assert body["shifts"][0]["cost_usd"] == "6.000000"
    assert body["shifts"][0]["reason"] == "window"


def test_project_usage_keeps_projects_apart(api: TestClient) -> None:
    """Суммы одного проекта не смешиваются с суммами другого."""
    _create_project(api)
    _create_project(api, code="other", name="Другой", prices=OTHER_PRICES)

    post_shift(api, shift_body(sessions=[session_body(session="a")]))
    post_shift(
        api,
        shift_body(
            project_ref="other",
            project_title="Другой",
            sessions=[session_body(session="a")],
        ),
    )

    mine = api.get(f"/api/projects/{PROJECT}/usage").json()
    other = api.get("/api/projects/other/usage").json()

    assert mine["totals"]["cost_usd"] == DAILY_COST
    assert other["totals"]["cost_usd"] == OTHER_DAILY_COST
    # Один и тот же id сессии у разных проектов — разные сессии: уникальность по проекту.
    assert other["totals"]["sessions"] == 1


def test_shift_of_project_without_prices_costs_nothing(api: TestClient) -> None:
    """Проект есть, но цен нет: смена принимается, а её сумма — ноль."""
    project = _create_project(
        api,
        prices={
            "price_input": "0",
            "price_output": "0",
            "price_cache_read": "0",
            "price_cache_write": "0",
        },
    )

    post_shift(api, shift_body())

    assert journal(api, project)["total"] == "0.000000"


# ── чтение: одна смена ──────────────────────────────────────────────────────


def test_shift_detail(api: TestClient, project: dict[str, Any]) -> None:
    """Детализация смены: снимок цен и сессии по порядку записи."""
    created = post_shift(
        api,
        shift_body(
            sessions=[
                session_body(session="sess-1"),
                session_body(
                    role="code-review",
                    session="sess-2",
                    issue_number=None,
                    issue_title=None,
                    source=None,
                    tokens={"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0},
                ),
            ],
        ),
    ).json()

    response = api.get(f"/api/usage/shifts/{created['shift_id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["project_ref"] == PROJECT
    assert body["project_title"] == TITLE
    assert body["rates"] == {
        "inputUsdPerM": 3.0,
        "outputUsdPerM": 15.0,
        "cacheReadUsdPerM": 0.3,
        "cacheWriteUsdPerM": 3.75,
    }
    assert body["cost_usd"] == DAILY_COST
    assert [session["session"] for session in body["sessions"]] == ["sess-1", "sess-2"]
    assert body["sessions"][1] == {
        "role": "code-review",
        "session": "sess-2",
        "source": None,
        "issue_number": None,
        "issue_title": None,
        "turns": 2,
        "tokens": {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0},
        "cost_usd": "0.000000",
    }


def test_shift_detail_not_found(api: TestClient) -> None:
    """Неизвестный номер смены — `404` с текстом контракта."""
    response = api.get("/api/usage/shifts/999")

    assert response.status_code == 404
    assert response.json()["detail"] == SHIFT_NOT_FOUND


# ── чтение: проекты со суммами ──────────────────────────────────────────────


def test_usage_projects_empty(api: TestClient) -> None:
    """Журнал пуст — пустой список, а не `404`: проектов без смен может не быть вовсе."""
    response = api.get(PROJECTS_URL)

    assert response.status_code == 200
    assert response.json() == []


def test_usage_projects_sums_by_project(api: TestClient) -> None:
    """Строка на проект: смены, сессии, токены, деньги и время последней смены."""
    _create_project(api)
    _create_project(api, code="other", name="Другой", prices=OTHER_PRICES)

    post_shift(api, shift_body(shift_key="2024-05-01", sessions=[session_body(session="a")]))
    post_shift(
        api,
        shift_body(
            project_ref="other",
            project_title="Другой",
            sessions=[session_body(session="b")],
        ),
    )
    post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            started_at="2024-05-02T10:00:00Z",
            ended_at="2024-05-03T02:00:00Z",
            sessions=[session_body(session="c")],
        ),
    )

    response = api.get(PROJECTS_URL)

    assert response.status_code == 200
    body = response.json()
    # Дороже всех — «Другой»: ответ отсортирован по деньгам по убыванию.
    assert [row["project_ref"] for row in body] == ["other", PROJECT]
    assert body[1]["shifts"] == 2
    assert body[1]["sessions"] == 2
    assert body[1]["cost_usd"] == "0.013800"
    assert body[1]["project_title"] == TITLE
    # Последняя смена проекта — по времени окончания, а не по порядку записи.
    assert body[1]["last_shift_at"].startswith("2024-05-03T02:00:00")


# ── удаление смены и повторная отправка (#88) ───────────────────────────────


def test_repost_of_deleted_shift_creates_it_again(api: TestClient, project: dict[str, Any]) -> None:
    """Удалённая смена освобождает ключ, и очередь, отправив её снова, заводит её заново.

    Это известное следствие физического удаления (#88), документируется тестом, а не
    правится: повторная отправка той же пары `(project_ref, shift_key)` после `DELETE`
    создаёт новую смену и снова прибавляет деньги к итогу проекта. Уникальность пары
    держит только живая строка — мягкого удаления у смен нет.
    """
    first = post_shift(api, shift_body())
    assert first.status_code == 201, first.text
    shift_id = first.json()["shift_id"]
    removed = api.delete(f"/api/projects/{project['id']}/expenses/shift/{shift_id}")
    assert removed.status_code == 200, removed.text
    assert journal(api, project)["total"] == "0.000000"

    again = post_shift(api, shift_body())

    assert again.status_code == 201, again.text
    assert again.json()["changed"] is True
    assert again.json()["accepted"] == 1
    assert journal(api, project)["total"] == DAILY_COST
