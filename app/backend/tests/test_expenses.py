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
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.api import expenses as api
from app.api import usage as usage_api
from app.config import Settings, get_settings
from app.models.expense import ProjectExpense

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


# ── пересчёт строки по текущим ценам (#88) ──────────────────────────────────


def _patch_prices(client: TestClient, project_id: int, **prices: str) -> None:
    """Сменить цены проекта ручкой `PATCH` — цену строки считает сервер, а не тест."""
    response = client.patch(f"/api/projects/{project_id}", json=prices)
    assert response.status_code == status.HTTP_200_OK, response.text


def _recalculate(client: TestClient, project_id: int, kind: str, row_id: int) -> Any:
    """Позвать пересчёт строки и вернуть ответ — успех и отказ различает тест."""
    return client.post(f"/api/projects/{project_id}/expenses/{kind}/{row_id}/recalculate")


def _delete(client: TestClient, project_id: int, kind: str, row_id: int) -> Any:
    """Позвать удаление строки и вернуть ответ."""
    return client.delete(f"/api/projects/{project_id}/expenses/{kind}/{row_id}")


def test_recalculate_manual_uses_current_prices(client: TestClient) -> None:
    """Пересчёт ручной записи: новая сумма по текущим ценам, факты строки не меняются."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    row = _post(client, project["id"], spent_on="2026-11-19", **{"in": 1_500_000})
    assert row["amount"] == "0.405000"
    _patch_prices(
        client,
        project["id"],
        price_input="0.54",
        price_output="2.20",
        price_cache_read="0.14",
        price_cache_write="0.68",
    )

    response = _recalculate(client, project["id"], "manual", row["id"])

    assert response.status_code == status.HTTP_200_OK, response.text
    body = response.json()
    # 1 500 000 × 0,54 / 1 000 000 = 0,81.
    assert body["total"] == "0.810000"
    assert body["item"] == {
        "kind": "manual",
        "id": row["id"],
        "spent_on": "2026-11-19",
        "tokens": {"in": 1_500_000, "out": 0, "cacheRead": 0, "cacheWrite": 0},
        "amount": "0.810000",
    }
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal == {"total": "0.810000", "items": [body["item"]]}


def test_recalculate_shift_rewrites_session_costs_and_rates(machine: TestClient) -> None:
    """Пересчёт смены: суммы сессий и смены новые, снимок цен текущий, токены прежние."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    sent = machine.post(
        "/api/usage/shifts",
        headers=AUTH,
        json=_shift_document(
            project_ref="workflow",
            sessions=[
                _shift_session("sess-1"),
                _shift_session("sess-2", tokens=_tokens(**{"in": 2_000_000})),
            ],
        ),
    )
    assert sent.status_code == status.HTTP_201_CREATED, sent.text
    shift_id = sent.json()["shift_id"]
    assert sent.json()["cost_usd"] == "0.810000"
    _patch_prices(
        machine,
        project["id"],
        price_input="1",
        price_output="2",
        price_cache_read="3",
        price_cache_write="4",
    )

    response = _recalculate(machine, project["id"], "shift", shift_id)

    assert response.status_code == status.HTTP_200_OK, response.text
    body = response.json()
    assert body["item"]["kind"] == "shift"
    assert body["item"]["id"] == shift_id
    # Сессии: 1 000 000 × 1 / 1 000 000 = 1,00 и 2 000 000 × 1 / 1 000 000 = 2,00.
    assert body["item"]["amount"] == "3.000000"
    assert body["item"]["tokens"] == {
        "in": 3_000_000,
        "out": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
    }
    assert body["item"]["sessions_count"] == 2
    assert body["total"] == "3.000000"

    detail = machine.get(f"/api/usage/shifts/{shift_id}").json()
    assert detail["cost_usd"] == "3.000000"
    assert detail["tokens"] == {"in": 3_000_000, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    assert detail["sessions_count"] == 2
    # Снимок цен перезаписан текущими ценами проекта — той же формулой, что при записи.
    assert detail["rates"] == {
        "inputUsdPerM": 1.0,
        "cacheReadUsdPerM": 3.0,
        "cacheWriteUsdPerM": 4.0,
        "outputUsdPerM": 2.0,
    }
    costs = {session["session"]: session["cost_usd"] for session in detail["sessions"]}
    assert costs == {"sess-1": "1.000000", "sess-2": "2.000000"}
    # Ходы и тикеты — факты, а не деньги: пересчёт их не трогает.
    assert [session["turns"] for session in detail["sessions"]] == [3, 3]


def test_recalculate_is_idempotent(client: TestClient) -> None:
    """Повторный пересчёт при неизменных ценах отдаёт те же числа и не копит сумму."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    row = _post(client, project["id"], **{"in": 1_000_000})

    first = _recalculate(client, project["id"], "manual", row["id"])
    second = _recalculate(client, project["id"], "manual", row["id"])

    assert first.status_code == status.HTTP_200_OK, first.text
    assert second.status_code == status.HTTP_200_OK, second.text
    assert second.json() == first.json()
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "0.270000"
    assert [item["amount"] for item in journal["items"]] == ["0.270000"]


def test_recalculated_total_equals_sum_of_journal_rows(machine: TestClient) -> None:
    """Итог после пересчёта — сумма всех строк журнала, обеих половин, а не дельта."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    manual = _post(machine, project["id"], spent_on="2026-11-19", **{"in": 1_500_000})
    shift = _post_shift(machine, project_ref="workflow")
    assert shift["cost_usd"] == "0.270000"
    _patch_prices(
        machine,
        project["id"],
        price_input="0.54",
        price_output="0.54",
        price_cache_read="0.54",
        price_cache_write="0.54",
    )

    recalculated = _recalculate(machine, project["id"], "manual", manual["id"])
    assert recalculated.status_code == status.HTTP_200_OK, recalculated.text

    journal = machine.get(f"/api/projects/{project['id']}/expenses").json()
    # Ручная запись — 0,81 по новой цене, смена осталась прежней: её ещё не пересчитали.
    assert journal["total"] == "1.080000"
    assert sum(Decimal(item["amount"]) for item in journal["items"]) == Decimal("1.080000")

    recalculated_shift = _recalculate(machine, project["id"], "shift", shift["shift_id"])
    assert recalculated_shift.status_code == status.HTTP_200_OK, recalculated_shift.text

    journal = machine.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "1.350000"
    assert sum(Decimal(item["amount"]) for item in journal["items"]) == Decimal("1.350000")


# ── удаление строки журнала (#88) ───────────────────────────────────────────


def test_delete_manual_removes_row_and_rebuilds_total(client: TestClient) -> None:
    """Удаление ручной записи: строка исчезает из журнала, итог — сумма оставшихся строк."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    gone = _post(client, project["id"], spent_on="2026-11-18", **{"in": 1_000_000})
    kept = _post(client, project["id"], spent_on="2026-11-19", **{"in": 1_500_000})

    response = _delete(client, project["id"], "manual", gone["id"])

    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json() == {"total": "0.405000"}
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["items"] == [kept]
    assert journal["total"] == "0.405000"


def test_delete_shift_removes_shift_and_its_sessions(machine: TestClient) -> None:
    """Удаление смены убирает и её сессии: детализация даёт 404, сумм проекта нет."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    manual = _post(machine, project["id"], spent_on="2026-11-19", **{"in": 1_500_000})
    shift = _post_shift(machine, project_ref="workflow")
    shift_id = shift["shift_id"]

    response = _delete(machine, project["id"], "shift", shift_id)

    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json() == {"total": "0.405000"}
    journal = machine.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal == {"total": "0.405000", "items": [manual]}

    detail = machine.get(f"/api/usage/shifts/{shift_id}")
    assert detail.status_code == status.HTTP_404_NOT_FOUND
    assert detail.json()["detail"] == usage_api.SHIFT_NOT_FOUND
    # Смен в разрезе проектов больше нет — и сессий удалённой смены в них тоже.
    assert machine.get("/api/usage/projects").json() == []


def test_total_stays_sum_of_rows_after_series_of_actions(machine: TestClient) -> None:
    """Серия пересчётов и удалений: итог после каждого шага равен сумме строк журнала."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    first = _post(machine, project["id"], spent_on="2026-11-17", **{"in": 1_000_000})
    second = _post(machine, project["id"], spent_on="2026-11-18", **{"in": 2_000_000})
    shift = _post_shift(machine, project_ref="workflow")
    _patch_prices(
        machine,
        project["id"],
        price_input="0.54",
        price_output="1.10",
        price_cache_read="0.07",
        price_cache_write="0.34",
    )

    def assert_total_matches() -> None:
        journal = machine.get(f"/api/projects/{project['id']}/expenses").json()
        assert Decimal(journal["total"]) == sum(
            Decimal(item["amount"]) for item in journal["items"]
        )

    _recalculate(machine, project["id"], "manual", first["id"])
    assert_total_matches()
    assert _delete(machine, project["id"], "manual", second["id"]).status_code == status.HTTP_200_OK
    assert_total_matches()
    recalculated = _recalculate(machine, project["id"], "shift", shift["shift_id"])
    assert recalculated.status_code == status.HTTP_200_OK, recalculated.text
    assert_total_matches()
    assert _delete(machine, project["id"], "shift", shift["shift_id"]).status_code == (
        status.HTTP_200_OK
    )
    assert_total_matches()
    assert machine.get(f"/api/projects/{project['id']}/expenses").json()["total"] == "0.540000"


# ── отказы новых ручек ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "row_id"),
    [("manual", 1), ("shift", 1)],
)
def test_recalculate_checks_project_first(client: TestClient, kind: str, row_id: int) -> None:
    """Несуществующий проект — `404 «Проект не найден»` раньше проверки строки."""
    response = _recalculate(client, 999, kind, row_id)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


@pytest.mark.parametrize("kind", ["manual", "shift"])
def test_mutations_return_404_for_deleted_project(client: TestClient, kind: str) -> None:
    """Мягко удалённый проект — тот же `404` проекта на пересчёте и удалении."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    client.delete(f"/api/projects/{project['id']}")

    recalc = _recalculate(client, project["id"], kind, 1)
    removed = _delete(client, project["id"], kind, 1)

    assert recalc.status_code == status.HTTP_404_NOT_FOUND
    assert recalc.json()["detail"] == "Проект не найден"
    assert removed.status_code == status.HTTP_404_NOT_FOUND
    assert removed.json()["detail"] == "Проект не найден"


def test_recalculate_unknown_kind_and_missing_rows(machine: TestClient) -> None:
    """Неизвестный вид и чужая ручная запись — «Запись не найдена», чужая смена — своя."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    other = _create_project(
        machine,
        name="Другой",
        repo_url="gidvantus/other",
        code="other",
        **ACCEPTANCE_PRICES,
    )
    foreign = _post(machine, other["id"], **{"in": 1_000_000})
    foreign_shift = _post_shift(machine, project_ref="other")

    for response in (
        _recalculate(machine, project["id"], "cost", 1),
        _recalculate(machine, project["id"], "manual", 999),
        _recalculate(machine, project["id"], "manual", foreign["id"]),
    ):
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert response.json()["detail"] == api.ROW_NOT_FOUND

    shift_response = _recalculate(machine, project["id"], "shift", foreign_shift["shift_id"])
    assert shift_response.status_code == status.HTTP_404_NOT_FOUND
    assert shift_response.json()["detail"] == usage_api.SHIFT_NOT_FOUND


def test_recalculate_shift_of_other_project_is_shift_not_found(machine: TestClient) -> None:
    """Смена соседнего проекта — `404 «Смена не найдена»`, как и несуществующая."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    _create_project(
        machine,
        name="Другой",
        repo_url="gidvantus/other",
        code="other",
        **ACCEPTANCE_PRICES,
    )
    foreign = _post_shift(machine, project_ref="other")

    for action in (
        _recalculate(machine, project["id"], "shift", foreign["shift_id"]),
        _delete(machine, project["id"], "shift", foreign["shift_id"]),
    ):
        assert action.status_code == status.HTTP_404_NOT_FOUND
        assert action.json()["detail"] == usage_api.SHIFT_NOT_FOUND


def test_delete_refuses_unknown_kind_and_rows(machine: TestClient) -> None:
    """Удаление неизвестного вида и чужой ручной записи — «Запись не найдена»."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    other = _create_project(
        machine,
        name="Другой",
        repo_url="gidvantus/other",
        code="other",
        **ACCEPTANCE_PRICES,
    )
    foreign = _post(machine, other["id"], **{"in": 1_000_000})

    for action in (
        _delete(machine, project["id"], "cost", 1),
        _delete(machine, project["id"], "manual", 999),
        _delete(machine, project["id"], "manual", foreign["id"]),
    ):
        assert action.status_code == status.HTTP_404_NOT_FOUND
        assert action.json()["detail"] == api.ROW_NOT_FOUND
    # Чужая запись не пострадала.
    other_journal = machine.get(f"/api/projects/{other['id']}/expenses").json()
    assert other_journal["items"] == [foreign]


def test_recalculate_checks_row_before_prices(client: TestClient) -> None:
    """Порядок отказов: строка раньше цен — у проекта без цен пропавшая строка даёт `404`."""
    project = _create_project(client)

    response = _recalculate(client, project["id"], "manual", 999)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == api.ROW_NOT_FOUND


@pytest.mark.parametrize("kind", ["manual", "shift"])
def test_recalculate_without_prices_refuses(machine: TestClient, kind: str) -> None:
    """Все четыре цены нули — `422 «Цены проекта не заполнены»`, строка не меняется."""
    project = _create_project(
        machine,
        code="workflow",
        price_input="0.27",
        price_output="1.10",
        price_cache_read="0.07",
        price_cache_write="0.34",
    )
    row = _post(machine, project["id"], **{"in": 1_000_000})
    shift = _post_shift(machine, project_ref="workflow")
    _patch_prices(
        machine,
        project["id"],
        price_input="0",
        price_output="0",
        price_cache_read="0",
        price_cache_write="0",
    )
    row_id = row["id"] if kind == "manual" else shift["shift_id"]

    response = _recalculate(machine, project["id"], kind, row_id)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_PRICES
    journal = machine.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "0.540000"
    assert sum(Decimal(item["amount"]) for item in journal["items"]) == Decimal("0.540000")


def test_recalculate_manual_beyond_shift_ceiling_succeeds(client: TestClient) -> None:
    """Строка дороже потолка смены пересчитывается: её колонка шире `Numeric(14,6)`.

    `POST` принимает ручную запись с суммой 10^14 — это валидный ввод контракта, — и
    потолок смены (`MAX_COST`) к ней не применим: сравнение шло бы с чужим пределом, и
    строку, которую сервер сам принял, нельзя было бы пересчитать никогда.
    """
    project = _create_project(
        client,
        price_input="100000000",
        price_output="0",
        price_cache_read="0",
        price_cache_write="0",
    )
    row = _post(client, project["id"], **{"in": 10**12})
    assert row["amount"] == "100000000000000.000000"

    response = _recalculate(client, project["id"], "manual", row["id"])

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["item"]["amount"] == "100000000000000.000000"
    assert response.json()["total"] == "100000000000000.000000"


def test_recalculate_manual_overflow_refuses_without_changing_row(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """Сумма сверх `Numeric(24,6)` — `422` про предел журнала, строка остаётся прежней.

    Контракт цен (10 знаков до точки) и количеств (до 10^12) даёт не больше 4·10^16, а
    колонка журнала держит 10^18: ручка записи такую строку не создаёт. Поэтому строка с
    количеством сверх `TOKENS_MAX` кладётся в базу напрямую — проверяется последняя защита
    колонки, а не вход ручки.
    """
    project = _create_project(
        client,
        price_input="9999999999",
        price_output="0",
        price_cache_read="0",
        price_cache_write="0",
    )
    with session_factory() as session:
        expense = ProjectExpense(
            project_id=project["id"],
            spent_on=date(2026, 11, 19),
            tokens_input=10**15,
            tokens_output=0,
            tokens_cache_read=0,
            tokens_cache_write=0,
            amount=Decimal("1"),
        )
        session.add(expense)
        session.commit()
        row_id = expense.id

    response = _recalculate(client, project["id"], "manual", row_id)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.COST_OVERFLOW
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["items"][0]["amount"] == "1.000000"


def test_recalculate_shift_overflow_refuses_without_touching_shift(machine: TestClient) -> None:
    """Смена сверх предела журнала не пересчитывается: отказ, прежние суммы и снимок цен."""
    project = _create_project(machine, code="workflow", **ACCEPTANCE_PRICES)
    shift = _post_shift(
        machine,
        project_ref="workflow",
        tokens=_tokens(**{"in": 10**12}),
    )
    _patch_prices(
        machine,
        project["id"],
        price_input="100000000",
        price_output="0",
        price_cache_read="0",
        price_cache_write="0",
    )

    response = _recalculate(machine, project["id"], "shift", shift["shift_id"])

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.COST_OVERFLOW
    detail = machine.get(f"/api/usage/shifts/{shift['shift_id']}").json()
    # 10^12 × 0,27 / 10^6 = 270 000 — прежняя сумма, и снимок цен прежний.
    assert detail["cost_usd"] == "270000.000000"
    assert detail["rates"]["inputUsdPerM"] == 0.27
    assert detail["sessions"][0]["cost_usd"] == "270000.000000"
