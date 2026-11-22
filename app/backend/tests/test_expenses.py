"""Объединённый журнал расходов проекта: запись за день, смена, итог и отказы.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей (общий движок — в `conftest.py`). Сумму считает сервер
по ценам проекта, поэтому проверки сравнивают ровно то, что увидит фронт: строки с шестью
знаками, `kind` у каждой половины и итог, который обязан сходиться с суммой строк.

Журнал один на два источника факта, и здесь проверяются оба: ручная запись
(`POST /api/projects/{id}/expenses`) и смена отдела (`POST /api/usage/shifts`). Смена
приезжает без денег, её сумму считает сервер по тем же ценам и прибавляет к тому же итогу.

Деньги проекта в тестах задаются ручкой `PATCH /api/projects/{id}`: цены — часть
контракта проекта, и обходить её прямым `UPDATE` значило бы проверять не тот путь.
"""

from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.api import expenses as api
from app.config import Settings, get_settings

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}

# Цены сценария приёмки: доллары США за 1 000 000 токенов.
ACCEPTANCE_PRICES: dict[str, str] = {
    "price_input": "0.27",
    "price_output": "1.10",
    "price_cache_read": "0.07",
    "price_cache_write": "0.34",
}

# Токен надстройки отдела: приём смены требует его, и без него смену в журнал не завести.
TOKEN = "stand-token"
AUTH = {"X-Registry-Token": TOKEN}


@pytest.fixture(name="machine")
def machine_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с токеном надстройки: им отправляется смена в журнал."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite://", registry_token=TOKEN
    )
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


def _create_project(
    client: TestClient,
    *,
    name: str = PROJECT["name"],
    repo_url: str = PROJECT["repo_url"],
    code: str | None = None,
    **prices: Any,
) -> dict[str, Any]:
    """Создать проект с ценами (если заданы) и вернуть тело ответа."""
    payload: dict[str, Any] = {
        "name": name,
        "description": PROJECT["description"],
        "repo_url": repo_url,
        **prices,
    }
    if code is not None:
        payload["code"] = code
    response = client.post("/api/projects", json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _tokens(**overrides: Any) -> dict[str, Any]:
    """Четыре количества записи: по умолчанию ненулевой вход, остальные нулевые."""
    counts: dict[str, Any] = {"in": 1_000_000, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    counts.update(overrides)
    return counts


def _expense_body(**overrides: Any) -> dict[str, Any]:
    """Тело ручной записи: день и четыре количества, без суммы."""
    body: dict[str, Any] = {"spent_on": "2026-11-19", "tokens": _tokens()}
    for key, value in overrides.items():
        if key in {"in", "out", "cacheRead", "cacheWrite"}:
            body["tokens"][key] = value
        else:
            body[key] = value
    return body


def _post(client: TestClient, project_id: int, **overrides: Any) -> dict[str, Any]:
    """Записать расход через ручку и вернуть тело ответа."""
    response = client.post(f"/api/projects/{project_id}/expenses", json=_expense_body(**overrides))
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _shift_session(
    session: str = "sess-1",
    tokens: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Сессия смены в форме контракта: количества и ходы, без денег."""
    return {
        "role": "dev-backend",
        "session": session,
        "issue_number": 72,
        "issue_title": "Один раздел «Расходы»",
        "source": "issue-created",
        "turns": 3,
        "tokens": _tokens() if tokens is None else tokens,
    }


def _shift_document(
    *,
    project_ref: str,
    shift_key: str = "2024-05-01",
    sessions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Документ смены отдела: сумму в нём не присылают, её считает сервер."""
    return {
        "project_ref": project_ref,
        "project_title": "Workflow",
        "shift_key": shift_key,
        "started_at": "2024-05-01T10:00:00Z",
        "ended_at": "2024-05-01T18:00:00Z",
        "reason": "window",
        "sessions": [_shift_session()] if sessions is None else sessions,
    }


def _post_shift(
    machine: TestClient,
    *,
    project_ref: str,
    shift_key: str = "2024-05-01",
    tokens: dict[str, int] | None = None,
    session: str = "sess-1",
) -> dict[str, Any]:
    """Отправить смену отдела: её сумму считает сервер по ценам проекта."""
    response = machine.post(
        "/api/usage/shifts",
        headers=AUTH,
        json=_shift_document(
            project_ref=project_ref,
            shift_key=shift_key,
            sessions=[_shift_session(session=session, tokens=tokens)],
        ),
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def test_empty_journal_returns_zero_total(client: TestClient) -> None:
    """Пустой журнал — `0.000000` и пустой список, а не `404` и не `null`."""
    project = _create_project(client)

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"total": "0.000000", "items": []}


def test_get_returns_404_for_unknown_project(client: TestClient) -> None:
    """Несуществующий проект — `404` с общим текстом проекта."""
    response = client.get("/api/projects/999/expenses")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_get_returns_404_for_deleted_project(client: TestClient) -> None:
    """Мягко удалённый проект — тот же `404`: журнал удалённого проекта не читается."""
    project = _create_project(client)
    client.delete(f"/api/projects/{project['id']}")

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_post_returns_404_for_deleted_project(client: TestClient) -> None:
    """Запись в удалённый проект — `404`."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    client.delete(f"/api/projects/{project['id']}")

    response = client.post(f"/api/projects/{project['id']}/expenses", json=_expense_body())

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_post_checks_project_before_body(client: TestClient) -> None:
    """`404` важнее проверок тела: у несуществующего проекта не бывает «кривой даты»."""
    response = client.post(
        "/api/projects/999/expenses",
        json=_expense_body(spent_on="05.11.2026", **{"in": -1}),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_post_returns_created_journal_row(client: TestClient) -> None:
    """`201` и ровно те поля строки журнала, что обещаны контрактом.

    У ручной записи нет интервала, причины и числа сессий: этих ключей в ответе нет вовсе
    (`response_model_exclude_none`), поэтому фронт различает половины по `kind`.
    """
    project = _create_project(client, **ACCEPTANCE_PRICES)

    body = _post(client, project["id"], spent_on="2026-11-05", out=2_000_000)

    assert body == {
        "kind": "manual",
        "id": 1,
        "spent_on": "2026-11-05",
        "tokens": {"in": 1_000_000, "out": 2_000_000, "cacheRead": 0, "cacheWrite": 0},
        # 1 000 000 × 0,27 / 1 000 000 = 0,27; 2 000 000 × 1,10 / 1 000 000 = 2,20.
        "amount": "2.470000",
    }


def test_amount_rounds_half_up(client: TestClient) -> None:
    """0,0000005 округляется до `0.000001`, а не до нуля: округление половины вверх."""
    project = _create_project(client, price_input="0.5")

    body = _post(client, project["id"], **{"in": 1})

    assert body["amount"] == "0.000001"


def test_rounding_once_over_the_whole_record_not_per_component(client: TestClient) -> None:
    """Округление одно на запись: 0,0000004 + 0,0000004 = 0,000001, а не два нуля."""
    project = _create_project(client, price_input="0.000001", price_output="0.000001")

    body = _post(client, project["id"], **{"in": 400_000, "out": 400_000})

    assert body["amount"] == "0.000001"


def test_all_four_prices_take_part_in_amount(client: TestClient) -> None:
    """Сумма складывает все четыре пары «количество × цена»."""
    project = _create_project(
        client,
        price_input="1",
        price_output="2",
        price_cache_read="3",
        price_cache_write="4",
    )

    body = _post(
        client,
        project["id"],
        **{"in": 100_000, "out": 100_000, "cacheRead": 100_000, "cacheWrite": 100_000},
    )

    # (0,1 + 0,2 + 0,3 + 0,4) = 1,00.
    assert body["amount"] == "1.000000"


def test_valid_body_beyond_kopeck_precision_is_stored(client: TestClient) -> None:
    """Максимум контракта не даёт `500`: сумма на 14 знаков до точки сохраняется целиком.

    Цена шаблона пускает 10 знаков до разделителя, количество — до 10^12; произведение
    даёт 10^14, и колонка денег журнала обязана это держать. `Numeric(20, 6)` оставила бы
    14 знаков всего и ответила бы `numeric field overflow` на валидном вводе (на SQLite
    теста это не воспроизводится — проверяется сам путь и вид суммы).
    """
    project = _create_project(
        client,
        price_input="100000000",
        price_output="0",
        price_cache_read="0",
        price_cache_write="0",
    )

    body = _post(client, project["id"], **{"in": 10**12})

    assert body["amount"] == "100000000000000.000000"
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "100000000000000.000000"


def test_total_is_sum_of_rounded_amounts(client: TestClient) -> None:
    """Сценарий приёмки: две записи, сумма строк сходится с итогом до шестого знака."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    first = _post(client, project["id"], spent_on="2026-11-18", **{"in": 1_500_000})
    second = _post(
        client,
        project["id"],
        spent_on="2026-11-19",
        **{"in": 0, "cacheRead": 1_400_000},
    )

    assert first["amount"] == "0.405000"
    assert second["amount"] == "0.098000"

    response = client.get(f"/api/projects/{project['id']}/expenses")

    body = response.json()
    assert body["total"] == "0.503000"
    # Сумма строк сходится с итогом: итог — сумма округлённых сумм.
    assert sum(Decimal(item["amount"]) for item in body["items"]) == Decimal("0.503000")


def test_list_is_ordered_by_day_then_id_descending(client: TestClient) -> None:
    """Порядок — `spent_on DESC, id DESC`: свежий день сверху, внутри дня поздняя запись."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    old = _post(client, project["id"], spent_on="2026-11-05")
    same_day_first = _post(client, project["id"], spent_on="2026-11-19")
    same_day_second = _post(client, project["id"], spent_on="2026-11-19")

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert [item["id"] for item in response.json()["items"]] == [
        same_day_second["id"],
        same_day_first["id"],
        old["id"],
    ]


def test_journal_shows_only_own_project_records(client: TestClient) -> None:
    """Журнал проекта не показывает записи соседнего проекта и не считает их в итог."""
    mine = _create_project(client, **ACCEPTANCE_PRICES)
    other = _create_project(
        client,
        name="Другой",
        repo_url="gidvantus/other",
        code="other",
        **ACCEPTANCE_PRICES,
    )
    _post(client, other["id"], **{"in": 1_000_000})

    body = _post(client, mine["id"], **{"in": 1_500_000})

    response = client.get(f"/api/projects/{mine['id']}/expenses")

    assert response.json() == {"total": "0.405000", "items": [body]}


def test_task_cost_does_not_change_project_total(client: TestClient) -> None:
    """Стоимость задачи в журнал и в итог не входит: это отдельная сущность."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    task = client.post(
        f"/api/projects/{project['id']}/tasks",
        json={"name": "Задача", "cost": "1250.00"},
    )
    assert task.status_code == status.HTTP_201_CREATED, task.text

    _post(client, project["id"], **{"in": 1_500_000})

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert response.json()["total"] == "0.405000"


def test_amount_in_body_is_ignored(client: TestClient) -> None:
    """Суммы в теле нет: присланное `amount` отбрасывается, считает сервер."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={**_expense_body(**{"in": 1_500_000}), "amount": "999.00"},
    )

    assert response.status_code == status.HTTP_201_CREATED, response.text
    assert response.json()["amount"] == "0.405000"


# ── смена в том же журнале ──────────────────────────────────────────────────


def test_shift_and_manual_record_share_one_journal(machine: TestClient) -> None:
    """Обе половины — одной ведомостью: у строк `kind`, у смены интервал, итог общий."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    _post(machine, project["id"], spent_on="2026-11-19", **{"in": 1_500_000})
    _post_shift(machine, project_ref="workflow")

    response = machine.get(f"/api/projects/{project['id']}/expenses")

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    # Смена закрылась 1 мая, ручная запись — 19 ноября: свежая сверху.
    assert [item["kind"] for item in body["items"]] == ["manual", "shift"]
    # 0,405 (ручная) + 0,27 (смена: 1 000 000 × 0,27 / 1 000 000).
    assert body["total"] == "0.675000"
    assert sum(Decimal(item["amount"]) for item in body["items"]) == Decimal("0.675000")

    shift_row = body["items"][1]
    assert shift_row["amount"] == "0.270000"
    assert shift_row["spent_on"] == "2024-05-01"
    assert shift_row["tokens"] == {"in": 1_000_000, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    assert shift_row["reason"] == "window"
    assert shift_row["sessions_count"] == 1
    assert shift_row["started_at"].startswith("2024-05-01T10:00:00")
    assert shift_row["ended_at"].startswith("2024-05-01T18:00:00")

    manual_row = body["items"][0]
    # У ручной записи этих полей нет вовсе, а не `null`: фронт смотрит на `kind`.
    assert "reason" not in manual_row
    assert "sessions_count" not in manual_row
    assert "started_at" not in manual_row


def test_shift_of_project_without_code_is_found_by_numeric_ref(machine: TestClient) -> None:
    """Проект без кода живёт в реестре под своим `id`: смена ищется по нему же."""
    project = _create_project(machine, **ACCEPTANCE_PRICES)
    _post_shift(machine, project_ref=str(project["id"]))

    body = machine.get(f"/api/projects/{project['id']}/expenses").json()

    assert [item["kind"] for item in body["items"]] == ["shift"]
    assert body["total"] == "0.270000"


def test_shift_of_other_project_does_not_leak_into_journal(machine: TestClient) -> None:
    """Смена чужого проекта не появляется в журнале и не прибавляется к его итогу."""
    mine = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    _create_project(
        machine,
        name="Другой",
        repo_url="gidvantus/other",
        code="other",
        **ACCEPTANCE_PRICES,
    )
    _post_shift(machine, project_ref="other")

    body = machine.get(f"/api/projects/{mine['id']}/expenses").json()

    assert body == {"total": "0.000000", "items": []}


def _assign_code(machine: TestClient, project_id: int, code: str) -> None:
    """Дать проекту код: с этого момента реестр отдела зовёт его кодом, а не `str(id)`."""
    response = machine.patch(f"/api/projects/{project_id}", json={"code": code})
    assert response.status_code == status.HTTP_200_OK, response.text


def test_shift_recorded_by_numeric_ref_stays_after_code_is_assigned(
    machine: TestClient,
) -> None:
    """Смена, записанная под `str(id)`, остаётся в журнале и после присвоения кода.

    Реестр отдела зовёт проект кодом, если код задан, и `str(id)` — если нет. Смена,
    приехавшая до присвоения кода, лежит под числовым ключом, и её деньги уже прибавлены
    к итогу проекта. Поиск только по текущему ключу потерял бы строку, и итог перестал
    бы сходиться с суммой строк — ради чего тикет и делался.
    """
    project = _create_project(machine, **ACCEPTANCE_PRICES)
    _post_shift(machine, project_ref=str(project["id"]))

    _assign_code(machine, project["id"], "workflow")

    body = machine.get(f"/api/projects/{project['id']}/expenses").json()
    assert [item["kind"] for item in body["items"]] == ["shift"]
    assert body["items"][0]["amount"] == "0.270000"
    assert body["total"] == "0.270000"
    assert sum(Decimal(item["amount"]) for item in body["items"]) == Decimal(body["total"])


def test_shift_repeated_after_code_is_assigned_is_recognised(machine: TestClient) -> None:
    """Повтор смены под новым ключом — та же смена: новых строк и денег не появляется.

    Очередь отдела может отправить смену ещё раз уже после присвоения кода, с тем же
    `shift_key`, но с кодом вместо `str(id)`. Ключей у проекта два, и смена ищется по
    обоим: иначе журнал завёл бы вторую строку той же смены, а сессия считалась бы
    дважды.
    """
    project = _create_project(machine, **ACCEPTANCE_PRICES)
    first = _post_shift(machine, project_ref=str(project["id"]))
    assert first["changed"] is True

    _assign_code(machine, project["id"], "workflow")
    response = machine.post(
        "/api/usage/shifts",
        headers=AUTH,
        json=_shift_document(project_ref="workflow"),
    )

    assert response.status_code == status.HTTP_200_OK, response.text
    again = response.json()
    assert again["changed"] is False
    assert again["accepted"] == 0
    assert again["skipped"] == 1
    body = machine.get(f"/api/projects/{project['id']}/expenses").json()
    assert [item["kind"] for item in body["items"]] == ["shift"]
    assert body["total"] == "0.270000"


# ── отказы контракта ────────────────────────────────────────────────────────


def test_post_without_prices_refuses(client: TestClient) -> None:
    """Проект без цен — отказ «Цены проекта не заполнены», записи и итога не появляется."""
    project = _create_project(client)

    response = client.post(f"/api/projects/{project['id']}/expenses", json=_expense_body())

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_PRICES
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal == {"total": "0.000000", "items": []}


def test_post_with_zero_prices_only_refuses(client: TestClient) -> None:
    """Три заполненные цены и одна нулевая — не «нет цен»: запись проходит."""
    project = _create_project(client, price_input="0.27", price_output="0")

    body = _post(client, project["id"], **{"in": 1_500_000})

    assert body["amount"] == "0.405000"


def test_post_all_tokens_zero_refuses(client: TestClient) -> None:
    """Все четыре количества нулевые — отказ: запись ничего не тратит."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_TOKENS


def test_post_without_tokens_refuses(client: TestClient) -> None:
    """Без блока количеств — отказ «Укажите хотя бы одно количество токенов»."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={"spent_on": "2026-11-05"},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_TOKENS


def test_post_empty_counts_block_refuses(client: TestClient) -> None:
    """Пустой блок количеств — тот же отказ, что и отсутствие блока."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={"spent_on": "2026-11-05", "tokens": {}},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_TOKENS


def test_post_zero_tokens_checked_before_prices(client: TestClient) -> None:
    """Порядок отказов — контракт: сначала количества, потом цены проекта."""
    project = _create_project(client)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{"in": 0}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_TOKENS


@pytest.mark.parametrize(
    "spent_on",
    ["05.11.2026", "2026-11-5", "2026-02-30", "2026-13-01", "", "вчера"],
)
def test_post_bad_date_refuses(client: TestClient, spent_on: str) -> None:
    """Кривой формат и несуществующая календарная дата — один текст про `ГГГГ-ММ-ДД`."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(spent_on=spent_on),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.SPENT_ON_INVALID


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("in", -1),
        ("out", api.TOKENS_MAX + 1),
        ("cacheRead", -1_000),
        ("cacheWrite", api.TOKENS_MAX + 1),
    ],
)
def test_post_bad_tokens_refuses(client: TestClient, key: str, value: int) -> None:
    """Количество вне `0 ≤ n ≤ 10^12` — отказ `422` текстом про целое неотрицательное."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{key: value}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.TOKENS_INVALID


@pytest.mark.parametrize(
    ("key", "value", "detail"),
    [
        ("in", 12.5, api.TOKENS_INVALID),
        ("in", "1 500", api.TOKENS_INVALID),
        ("in", "abc", api.TOKENS_INVALID),
        ("in", None, api.TOKENS_INVALID),
        ("in", True, api.TOKENS_INVALID),
        ("in", "1" * 4400, api.TOKENS_INVALID),
        ("spent_on", None, api.SPENT_ON_INVALID),
        ("spent_on", 20261105, api.SPENT_ON_INVALID),
        ("spent_on", 5.5, api.SPENT_ON_INVALID),
    ],
)
def test_post_bad_field_types_refuse_with_contract_text(
    client: TestClient, key: str, value: Any, detail: str
) -> None:
    """Нечисловое количество и не строка в дате — текст контракта, а не массив pydantic.

    Схема запроса пропускает свободные типы намеренно: проверку делает ручка, поэтому
    `12.5`, `"1 500"`, `"abc"`, `null` и `true` получают ровно тот `detail`, который
    фронт показывает пользователю дословно.
    """
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{key: value}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == detail


@pytest.mark.parametrize("value", [1_500_000.0, "1500000"])
def test_post_accepts_whole_number_in_free_type(client: TestClient, value: Any) -> None:
    """Свободный тип не мешает нормальному вводу: целое в `float` и строка из цифр."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    body = _post(client, project["id"], **{"in": value})

    assert body["tokens"]["in"] == 1_500_000
    assert body["amount"] == "0.405000"


def test_post_checks_project_before_body_types(client: TestClient) -> None:
    """`404` остаётся первым и при теле, которое иначе отклонила бы схема."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    client.delete(f"/api/projects/{project['id']}")

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={"spent_on": None, "tokens": {"in": "abc"}},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


@pytest.mark.parametrize("key", ["in", "out", "cacheRead", "cacheWrite"])
def test_post_bool_tokens_refuse_in_every_field(client: TestClient, key: str) -> None:
    """`true` в любом количестве — отказ контракта, а не запись с `1` и суммой.

    Булево в объединении типов схемы стоит первым: `bool` — подкласс `int`, и без этого
    pydantic привёл бы `true` к `1`, создал запись и посчитал по ней деньги.
    """
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{key: True}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.TOKENS_INVALID
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["items"] == []
    assert journal["total"] == "0.000000"


def test_post_with_missing_token_field_is_refused(client: TestClient) -> None:
    """Пропущенное количество — отказ контракта: ноль приходит нулём, а не пропуском."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    body = _expense_body()
    del body["tokens"]["out"]

    response = client.post(f"/api/projects/{project['id']}/expenses", json=body)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.TOKENS_INVALID


def test_post_without_date_is_refused(client: TestClient) -> None:
    """Без `spent_on` ручка отвечает своим текстом про дату, а не отказом схемы."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={"tokens": _tokens()},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.SPENT_ON_INVALID


def test_two_posts_accumulate_total(client: TestClient) -> None:
    """Каждая запись прибавляется к итогу проекта: 0,405 + 0,405 = 0,810."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    _post(client, project["id"], **{"in": 1_500_000})
    _post(client, project["id"], **{"in": 1_500_000})

    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "0.810000"
    assert [item["amount"] for item in journal["items"]] == ["0.405000", "0.405000"]


def test_total_is_incremented_in_sql(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """Итог прибавляется SQL-инкрементом, а не присваиванием числа, посчитанного в Python.

    Требование п.7 постановки («два одновременных `POST` не теряют сумму») держится
    ровно на этом выражении: чтение-изменение-запись в Python на последовательных
    запросах даёт тот же результат и проходит любой тест суммы, а потерю показывает
    только гонка. Поэтому проверяется сам ушедший `UPDATE`: в нём стоит
    `total_cost=(projects.total_cost + ?)`, то есть прибавление, а не готовое число.
    """
    project = _create_project(client, **ACCEPTANCE_PRICES)
    engine = session_factory.kw["bind"]
    assert isinstance(engine, Engine)
    statements: list[str] = []

    def capture(
        connection: Connection,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        """Запомнить каждый ушедший в базу запрос: текст разбирается после `POST`."""
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        body = _post(client, project["id"], **{"in": 1_500_000})
    finally:
        event.remove(engine, "before_cursor_execute", capture)

    updates = [
        " ".join(statement.split()).lower()
        for statement in statements
        if statement.lstrip().upper().startswith("UPDATE") and "total_cost" in statement
    ]
    assert len(updates) == 1, updates
    assert "total_cost=(projects.total_cost + ?)" in updates[0], updates[0]
    assert body["amount"] == "0.405000"


def test_validate_spent_on_accepts_calendar_date() -> None:
    """Валидатор даты доступен без HTTP и возвращает `date`, а не строку."""
    assert str(api.validate_spent_on(" 2026-11-05 ")) == "2026-11-05"


@pytest.mark.parametrize("value", [-1, api.TOKENS_MAX + 1])
def test_validate_tokens_rejects_out_of_range(value: int) -> None:
    """Валидатор количества — тот же текст отказа, что у ручки."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_tokens(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == api.TOKENS_INVALID


@pytest.mark.parametrize("value", [0, 1, api.TOKENS_MAX])
def test_validate_tokens_accepts_range(value: int) -> None:
    """Границы диапазона включены: ноль и `10^12` — допустимые количества."""
    assert api.validate_tokens(value) == value


@pytest.mark.parametrize(
    ("value", "expected"), [(1_500_000.0, 1_500_000), (" 1500000 ", 1_500_000), (1.0, 1)]
)
def test_validate_tokens_accepts_whole_number_of_any_type(value: object, expected: int) -> None:
    """Целое в свободном типе разбирается: `float` без дробной части и строка из цифр."""
    assert api.validate_tokens(value) == expected


@pytest.mark.parametrize(
    "value",
    [12.5, 1.5, "1 500", "abc", "", None, True, [1], {"a": 1}, "1" * 4400, "9" * 4301],
)
def test_validate_tokens_rejects_non_whole(value: object) -> None:
    """Всё, из чего не выходит целое неотрицательное число, — тот же текст контракта.

    Строка цифр длиннее потолка отсекается до `int()`: Python 3.12 отказывается
    разбирать строку больше 4300 цифр, и без этой проверки тело с длинной строкой
    цифр дало бы необработанный `500` вместо отказа контракта.
    """
    with pytest.raises(HTTPException) as excinfo:
        api.validate_tokens(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == api.TOKENS_INVALID


@pytest.mark.parametrize("value", [None, 20261105, 5.5, ["2026-11-05"]])
def test_validate_spent_on_rejects_non_string(value: object) -> None:
    """Дата — только строка `ГГГГ-ММ-ДД`: число, `null` и список получают текст про дату."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_spent_on(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == api.SPENT_ON_INVALID
