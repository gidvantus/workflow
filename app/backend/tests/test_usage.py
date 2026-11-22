"""Журнал расхода смен: приём смены от harness и суммы в разрезе проекта.

Это контракт с плагином отдела (`plugins/usage-web.mjs`): harness закрывает смену,
считает по каждой сессии ходы, токены и цену и присылает её одним `POST`. Веб ничего не
пересчитывает, а складывает присланное. Поэтому здесь проверяется не только «ручка
ответила», но и правила, ради которых журнал заведён:

- **идемпотентность**: повторная отправка той же смены `(project_ref, shift_key)` даёт
  `200` с `changed: false`, новых строк не заводит и денег проекту не прибавляет;
- **одна сессия один раз**: «продолженный диалог» из прошлой смены приезжает второй раз,
  пропускается (`skipped`) и остаётся за той сменой, которая записала его первой —
  суммы проекта при этом не удваиваются;
- **суммы смены — по принятым сессиям**: именно поэтому повтор ничего не прибавляет;
- **закрытый набор отказов**: каждому случаю из контракта — свой текст в `detail`,
  проверяется дословно, потому что harness показывает его человеку;
- **деньги строкой с шестью знаками**: `"0.420000"`, а не `0.42` и не `"0.42"`;
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
    COST_TOO_LARGE,
    FIELD_TOO_LONG,
    NEGATIVE_COST,
    PROJECT_REF_REQUIRED,
    RATES_INVALID,
    REASON_INVALID,
    SESSION_IDENTITY_REQUIRED,
    SESSION_NUMBERS_INVALID,
    SHIFT_KEY_REQUIRED,
    SHIFT_NOT_FOUND,
    SHIFT_TIME_INVALID,
    SHIFT_WRITE_RACE,
    TOO_MANY_SESSIONS,
    TOTALS_MISMATCH,
)
from app.config import Settings, get_settings

SHIFTS_URL = "/api/usage/shifts"
PROJECTS_URL = "/api/usage/projects"

TOKEN = "stand-token"
AUTH = {"X-Registry-Token": TOKEN}

PROJECT = "workflow"
TITLE = "Workflow"
SHIFT_KEY = "2024-05-01"

RATES: dict[str, float] = {
    "inputUsdPerM": 3.0,
    "outputUsdPerM": 15.0,
    "cacheReadUsdPerM": 0.3,
    "cacheWriteUsdPerM": 3.75,
}

# Отметка «тарифы не переданы»: `None` значил бы «нет тарифов», а умолчание помощника —
# «тарифы по умолчанию», и случай «тарифов нет вовсе» иначе не собрать.
_UNSET = object()


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


def session_body(
    *,
    role: str = "dev-backend",
    session: str = "sess-1",
    issue_number: int | None = 57,
    issue_title: str | None = "Журнал расхода смены",
    source: str | None = "issue-created",
    turns: int = 2,
    tokens: dict[str, int] | None = None,
    cost_usd: float = 0.25,
) -> dict[str, Any]:
    """Одна сессия смены в форме контракта."""
    return {
        "role": role,
        "session": session,
        "issue_number": issue_number,
        "issue_title": issue_title,
        "source": source,
        "turns": turns,
        "tokens": tokens
        if tokens is not None
        else {"in": 1000, "out": 200, "cacheRead": 3000, "cacheWrite": 0},
        "cost_usd": cost_usd,
    }


def shift_body(
    *,
    project_ref: str = PROJECT,
    project_title: str = TITLE,
    shift_key: str = SHIFT_KEY,
    sessions: list[dict[str, Any]] | None = None,
    rates: Any = _UNSET,
    total: float | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """Документ смены: сессии по умолчанию и итог, сходящийся с их суммой."""
    items = sessions if sessions is not None else [session_body()]
    body: dict[str, Any] = {
        "project_ref": project_ref,
        "project_title": project_title,
        "shift_key": shift_key,
        "started_at": "2024-05-01T10:00:00Z",
        "ended_at": "2024-05-01T18:00:00Z",
        "reason": "window",
        "rates": RATES if rates is _UNSET else rates,
        "sessions": items,
        "totals": {
            "cost_usd": (
                total
                if total is not None
                else round(sum(item.get("cost_usd", 0) for item in items), 6)
            )
        },
    }
    body.update(overrides)
    return body


def post_shift(api: TestClient, body: dict[str, Any]) -> Any:
    """Отправить смену с токеном надстройки."""
    return api.post(SHIFTS_URL, json=body, headers=AUTH)


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


# ── приём смены ─────────────────────────────────────────────────────────────


def test_store_shift_creates_it(api: TestClient) -> None:
    """Первая отправка смены — `201`, все сессии приняты, сумма по ним."""
    body = shift_body(
        sessions=[
            session_body(session="sess-1", cost_usd=0.25),
            session_body(role="code-review", session="sess-2", cost_usd=0.17),
        ]
    )

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json() == {
        "shift_id": 1,
        "accepted": 2,
        "skipped": 0,
        "sessions_count": 2,
        "cost_usd": "0.420000",
        "changed": True,
    }


def test_store_shift_is_idempotent(api: TestClient) -> None:
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
        "cost_usd": "0.250000",
        "changed": False,
    }


def test_repeat_shift_does_not_add_money(api: TestClient) -> None:
    """Повтор смены не прибавляет денег проекту: сумма считается по строкам журнала."""
    post_shift(api, shift_body())
    post_shift(api, shift_body())

    totals = api.get(f"/api/projects/{PROJECT}/usage").json()["totals"]

    assert totals["shifts"] == 1
    assert totals["sessions"] == 1
    assert totals["cost_usd"] == "0.250000"


def test_carried_session_counts_once(api: TestClient) -> None:
    """Сессия, взятая сменой из прошлой смены, входит в суммы проекта один раз.

    Она остаётся за той сменой, которая записала её первой: так суммы проекта не
    удваиваются. Это осознанное расхождение с текстом Telegram-сводки, где цифра дня.
    """
    carried = session_body(session="sess-carried", cost_usd=0.25)
    post_shift(api, shift_body(shift_key="2024-05-01", sessions=[carried]))

    second = post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            sessions=[
                carried,
                session_body(session="sess-new", cost_usd=0.10),
            ],
            total=0.35,
        ),
    )

    assert second.status_code == 201
    assert second.json()["accepted"] == 1
    assert second.json()["skipped"] == 1
    assert second.json()["sessions_count"] == 1
    assert second.json()["cost_usd"] == "0.100000"

    totals = api.get(f"/api/projects/{PROJECT}/usage").json()["totals"]
    assert totals["shifts"] == 2
    assert totals["sessions"] == 2
    assert totals["cost_usd"] == "0.350000"


def test_session_repeated_inside_one_shift_counts_once(api: TestClient) -> None:
    """Повтор сессии внутри одного тела считается так же, как повтор между сменами."""
    body = shift_body(
        sessions=[
            session_body(session="sess-1", cost_usd=0.25),
            session_body(session="sess-1", role="code-review", cost_usd=0.25),
        ],
        total=0.5,
    )

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json()["accepted"] == 1
    assert response.json()["skipped"] == 1
    assert response.json()["cost_usd"] == "0.250000"


def test_shift_without_sessions_is_accepted(api: TestClient) -> None:
    """Пустая смена — валидная запись: смена была, расхода в ней не случилось."""
    body = shift_body(sessions=[], total=0)

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json()["sessions_count"] == 0
    assert response.json()["cost_usd"] == "0.000000"


def test_project_title_falls_back_to_ref(api: TestClient) -> None:
    """Пустое название проекта берётся из его id: подпись, а не ключ."""
    body = shift_body(project_title="   ")

    post_shift(api, body)

    usage = api.get(f"/api/projects/{PROJECT}/usage").json()
    assert usage["project_title"] == PROJECT


def test_shift_sums_only_accepted_sessions(api: TestClient) -> None:
    """Токены смены — сумма принятых сессий, а не всего присланного тела."""
    post_shift(api, shift_body(sessions=[session_body(session="sess-1", cost_usd=0.25)]))
    response = post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            sessions=[
                session_body(
                    session="sess-1",
                    tokens={"in": 10**6, "out": 0, "cacheRead": 0, "cacheWrite": 0},
                    cost_usd=0.25,
                ),
                session_body(
                    session="sess-2",
                    tokens={"in": 100, "out": 20, "cacheRead": 30, "cacheWrite": 40},
                    cost_usd=0.01,
                ),
            ],
            total=0.26,
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
        ({"rates": None}, RATES_INVALID),
        ({"rates": []}, RATES_INVALID),
        ({"rates": {"inputUsdPerM": 3.0}}, RATES_INVALID),
        ({"rates": {**RATES, "outputUsdPerM": -1}}, RATES_INVALID),
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
        "нет-тарифов",
        "тарифы-не-объект",
        "тарифов-не-хватает",
        "тариф-отрицательный",
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
        ({"cost_usd": -0.5}, NEGATIVE_COST),
        ({"cost_usd": "дорого"}, SESSION_NUMBERS_INVALID),
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
        "цена-отрицательная",
        "цена-не-число",
    ],
)
def test_session_refusals(api: TestClient, session: dict[str, Any], text: str) -> None:
    """Сессия проверяется по одному полю, текст отказа — из контракта."""
    broken = {**session_body(), **session}
    body = shift_body(sessions=[broken], total=0)

    response = post_shift(api, body)

    assert response.status_code == 422
    assert response.json()["detail"] == text


def test_totals_must_match_sessions(api: TestClient) -> None:
    """Итог, разошедшийся с детализацией, — отказ: сумму нельзя подсунуть."""
    response = post_shift(api, shift_body(sessions=[session_body(cost_usd=0.25)], total=0.42))

    assert response.status_code == 422
    assert response.json()["detail"] == TOTALS_MISMATCH


def test_totals_allow_rounding_inside_quantum(api: TestClient) -> None:
    """Расхождение в последнем знаке — округление, а не подмена суммы."""
    response = post_shift(api, shift_body(sessions=[session_body(cost_usd=0.25)], total=0.2500004))

    assert response.status_code == 201


def test_totals_may_be_absent(api: TestClient) -> None:
    """Без блока `totals` сверять не с чем: сессии принимаются по себе."""
    body = shift_body(sessions=[session_body(cost_usd=0.25)])
    del body["totals"]

    response = post_shift(api, body)

    assert response.status_code == 201
    assert response.json()["cost_usd"] == "0.250000"


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
    sessions = [session_body(session=f"sess-{i}", cost_usd=0.0) for i in range(501)]

    response = post_shift(api, shift_body(sessions=sessions, total=0))

    assert response.status_code == 422
    assert response.json()["detail"] == TOO_MANY_SESSIONS


@pytest.mark.parametrize("cost", [100_000_000.0, 1e30])
def test_cost_beyond_column_is_refused(api: TestClient, cost: float) -> None:
    """Сумма сверх разрядности `Numeric(14,6)` — `422`, а не `500`.

    `1e30` ломает уже `Decimal.quantize`, `100000000.0` — вставку на PostgreSQL. Это
    третья защита от сломанного отправителя, как и длина значения сверх колонки.
    """
    response = post_shift(api, shift_body(sessions=[session_body(cost_usd=cost)]))

    assert response.status_code == 422
    assert response.json()["detail"] == COST_TOO_LARGE


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


def test_project_usage_lists_shifts_newest_first(api: TestClient) -> None:
    """Смены идут от новых к старым, итоги — по всем."""
    post_shift(
        api,
        shift_body(
            shift_key="2024-05-01",
            sessions=[session_body(session="a", cost_usd=0.25)],
        ),
    )
    post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            started_at="2024-05-02T10:00:00Z",
            ended_at="2024-05-02T18:00:00Z",
            sessions=[session_body(session="b", cost_usd=0.5)],
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
        "tokens": {"in": 2000, "out": 400, "cacheRead": 6000, "cacheWrite": 0},
        "cost_usd": "0.750000",
    }
    assert body["shifts"][0]["cost_usd"] == "0.500000"
    assert body["shifts"][0]["reason"] == "window"


def test_project_usage_keeps_projects_apart(api: TestClient) -> None:
    """Суммы одного проекта не смешиваются с суммами другого."""
    post_shift(api, shift_body(sessions=[session_body(session="a", cost_usd=0.25)]))
    post_shift(
        api,
        shift_body(
            project_ref="other",
            project_title="Другой",
            sessions=[session_body(session="a", cost_usd=0.5)],
        ),
    )

    mine = api.get(f"/api/projects/{PROJECT}/usage").json()
    other = api.get("/api/projects/other/usage").json()

    assert mine["totals"]["cost_usd"] == "0.250000"
    assert other["totals"]["cost_usd"] == "0.500000"
    # Один и тот же id сессии у разных проектов — разные сессии: уникальность по проекту.
    assert other["totals"]["sessions"] == 1


# ── чтение: одна смена ──────────────────────────────────────────────────────


def test_shift_detail(api: TestClient) -> None:
    """Детализация смены: тарифы расчёта и сессии по порядку записи."""
    created = post_shift(
        api,
        shift_body(
            sessions=[
                session_body(session="sess-1", cost_usd=0.25),
                session_body(
                    role="code-review",
                    session="sess-2",
                    issue_number=None,
                    issue_title=None,
                    source=None,
                    cost_usd=0.17,
                ),
            ],
            total=0.42,
        ),
    ).json()

    response = api.get(f"/api/usage/shifts/{created['shift_id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["project_ref"] == PROJECT
    assert body["project_title"] == TITLE
    assert body["rates"] == RATES
    assert body["cost_usd"] == "0.420000"
    assert [session["session"] for session in body["sessions"]] == ["sess-1", "sess-2"]
    assert body["sessions"][1] == {
        "role": "code-review",
        "session": "sess-2",
        "source": None,
        "issue_number": None,
        "issue_title": None,
        "turns": 2,
        "tokens": {"in": 1000, "out": 200, "cacheRead": 3000, "cacheWrite": 0},
        "cost_usd": "0.170000",
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
    post_shift(
        api,
        shift_body(shift_key="2024-05-01", sessions=[session_body(session="a", cost_usd=0.25)]),
    )
    post_shift(
        api,
        shift_body(
            project_ref="other",
            project_title="Другой",
            sessions=[session_body(session="b", cost_usd=0.5)],
        ),
    )
    post_shift(
        api,
        shift_body(
            shift_key="2024-05-02",
            started_at="2024-05-02T10:00:00Z",
            ended_at="2024-05-03T02:00:00Z",
            sessions=[session_body(session="c", cost_usd=0.1)],
        ),
    )

    response = api.get(PROJECTS_URL)

    assert response.status_code == 200
    body = response.json()
    # Дороже всех — «Другой»: ответ отсортирован по деньгам по убыванию.
    assert [row["project_ref"] for row in body] == ["other", PROJECT]
    assert body[1]["shifts"] == 2
    assert body[1]["sessions"] == 2
    assert body[1]["cost_usd"] == "0.350000"
    assert body[1]["project_title"] == TITLE
    # Последняя смена проекта — по времени окончания, а не по порядку записи.
    assert body[1]["last_shift_at"].startswith("2024-05-03T02:00:00")
