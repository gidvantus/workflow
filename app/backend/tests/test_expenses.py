"""Ручки журнала расходов проекта: расчёт суммы, порядок записей, итог и отказы.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей (общий движок — в `conftest.py`). Сумму считает сервер,
поэтому проверки сравнивают ровно то, что увидит фронт: строки с двумя знаками и итог,
который обязан сходиться с суммой строк.

Деньги проекта в тестах задаются ручкой `PATCH /api/projects/{id}`: цены — часть
контракта проекта, и обходить её прямым `UPDATE` значило бы проверять не тот путь.
"""

from decimal import Decimal
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.api import expenses as api

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}

# Цены сценария приёмки — те же, что в макете `mockups/53`: рубли за 1 млн токенов.
ACCEPTANCE_PRICES: dict[str, str] = {
    "price_input": "0.27",
    "price_output": "1.10",
    "price_cache_read": "0.07",
    "price_cache_write": "0.34",
}


def _create_project(client: TestClient, **prices: Any) -> dict[str, Any]:
    """Создать проект с ценами (если заданы) и вернуть тело ответа."""
    payload: dict[str, Any] = {**PROJECT, **prices}
    response = client.post("/api/projects", json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _expense_body(**overrides: Any) -> dict[str, Any]:
    """Тело записи: по умолчанию ненулевой вход, остальные количества нулевые."""
    body: dict[str, Any] = {
        "spent_on": "2026-11-19",
        "tokens_input": 1_000_000,
        "tokens_output": 0,
        "tokens_cache_read": 0,
        "tokens_cache_write": 0,
    }
    body.update(overrides)
    return body


def _post(client: TestClient, project_id: int, **overrides: Any) -> dict[str, Any]:
    """Записать расход через ручку и вернуть тело ответа."""
    response = client.post(f"/api/projects/{project_id}/expenses", json=_expense_body(**overrides))
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def test_empty_journal_returns_zero_total(client: TestClient) -> None:
    """Пустой журнал — `0.00` и пустой список, а не `404` и не `null`."""
    project = _create_project(client)

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"total": "0.00", "items": []}


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
        json=_expense_body(spent_on="05.11.2026", tokens_input=-1),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_post_returns_created_expense_fields(client: TestClient) -> None:
    """`201` и ровно те поля записи, что обещаны контрактом."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    body = _post(client, project["id"], spent_on="2026-11-05", tokens_output=2_000_000)

    assert set(body) == {
        "id",
        "project_id",
        "spent_on",
        "tokens_input",
        "tokens_output",
        "tokens_cache_read",
        "tokens_cache_write",
        "amount",
        "created_at",
    }
    assert body["project_id"] == project["id"]
    assert body["spent_on"] == "2026-11-05"
    assert body["tokens_input"] == 1_000_000
    assert body["tokens_output"] == 2_000_000
    assert body["tokens_cache_read"] == 0
    assert body["tokens_cache_write"] == 0
    # 1 000 000 × 0,27 / 1 000 000 = 0,27; 2 000 000 × 1,10 / 1 000 000 = 2,20.
    assert body["amount"] == "2.47"


def test_amount_rounds_half_up_once_per_record(client: TestClient) -> None:
    """0,405 ₽ округляется до `0.41`, а не до `0.40`: округление половины вверх."""
    project = _create_project(client, price_input="0.27")

    body = _post(client, project["id"], tokens_input=1_500_000)

    assert body["amount"] == "0.41"


def test_rounding_once_over_the_whole_record_not_per_component(client: TestClient) -> None:
    """Округление одно на запись: 0,0049 + 0,0049 = 0,0098 → `0.01`, а не два нуля."""
    project = _create_project(client)
    response = client.patch(
        f"/api/projects/{project['id']}",
        json={"price_input": "0.0049", "price_output": "0.0049"},
    )
    assert response.status_code == status.HTTP_200_OK, response.text

    body = _post(client, project["id"], tokens_input=1_000_000, tokens_output=1_000_000)

    assert body["amount"] == "0.01"


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
        tokens_input=100_000,
        tokens_output=100_000,
        tokens_cache_read=100_000,
        tokens_cache_write=100_000,
    )

    # (0,1 + 0,2 + 0,3 + 0,4) ₽ = 1,00 ₽.
    assert body["amount"] == "1.00"


def test_total_is_sum_of_rounded_amounts(client: TestClient) -> None:
    """Сценарий приёмки: две записи, сумма строк сходится с итогом копейка в копейку."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    first = _post(client, project["id"], spent_on="2026-11-18", tokens_input=1_500_000)
    second = _post(
        client,
        project["id"],
        spent_on="2026-11-19",
        tokens_input=0,
        tokens_cache_read=1_400_000,
    )

    assert first["amount"] == "0.41"
    assert second["amount"] == "0.10"

    response = client.get(f"/api/projects/{project['id']}/expenses")

    body = response.json()
    assert body["total"] == "0.51"
    # Сумма строк сходится с итогом копейка в копейку: итог — сумма округлённых сумм.
    assert sum(Decimal(item["amount"]) for item in body["items"]) == Decimal("0.51")


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
    other = _create_project(client, name="Другой", repo_url="gidvantus/other", **ACCEPTANCE_PRICES)
    _post(client, other["id"], tokens_input=1_000_000)

    body = _post(client, mine["id"], tokens_input=1_500_000)

    response = client.get(f"/api/projects/{mine['id']}/expenses")

    assert response.json() == {"total": "0.41", "items": [body]}


def test_task_cost_does_not_change_project_total(client: TestClient) -> None:
    """Стоимость задачи в журнал и в итог не входит: это отдельная сущность."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    task = client.post(
        f"/api/projects/{project['id']}/tasks",
        json={"name": "Задача", "cost": "1250.00"},
    )
    assert task.status_code == status.HTTP_201_CREATED, task.text

    _post(client, project["id"], tokens_input=1_500_000)

    response = client.get(f"/api/projects/{project['id']}/expenses")

    assert response.json()["total"] == "0.41"


def test_amount_in_body_is_ignored(client: TestClient) -> None:
    """Суммы в теле нет: присланное `amount` отбрасывается, считает сервер."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json={**_expense_body(tokens_input=1_500_000), "amount": "999.00"},
    )

    assert response.status_code == status.HTTP_201_CREATED, response.text
    assert response.json()["amount"] == "0.41"


def test_post_without_prices_refuses(client: TestClient) -> None:
    """Проект без цен — отказ «Цены проекта не заполнены», записи и итога не появляется."""
    project = _create_project(client)

    response = client.post(f"/api/projects/{project['id']}/expenses", json=_expense_body())

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_PRICES
    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal == {"total": "0.00", "items": []}


def test_post_with_zero_prices_only_refuses(client: TestClient) -> None:
    """Три заполненные цены и одна нулевая — не «нет цен»: запись проходит."""
    project = _create_project(client, price_input="0.27", price_output="0")

    body = _post(client, project["id"], tokens_input=1_500_000)

    assert body["amount"] == "0.41"


def test_post_all_tokens_zero_refuses(client: TestClient) -> None:
    """Все четыре количества нулевые — отказ: запись ничего не тратит."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(tokens_input=0, tokens_output=0, tokens_cache_read=0),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.NO_TOKENS


def test_post_zero_tokens_checked_before_prices(client: TestClient) -> None:
    """Порядок отказов — контракт: сначала количества, потом цены проекта."""
    project = _create_project(client)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(tokens_input=0),
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
    ("field", "value"),
    [
        ("tokens_input", -1),
        ("tokens_output", api.TOKENS_MAX + 1),
        ("tokens_cache_read", -1_000),
        ("tokens_cache_write", api.TOKENS_MAX + 1),
    ],
)
def test_post_bad_tokens_refuses(client: TestClient, field: str, value: int) -> None:
    """Количество вне `0 ≤ n ≤ 10^12` — отказ `422` текстом про целое неотрицательное."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{field: value}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.TOKENS_INVALID


@pytest.mark.parametrize(
    ("field", "value", "detail"),
    [
        ("tokens_input", 12.5, api.TOKENS_INVALID),
        ("tokens_input", "1 500", api.TOKENS_INVALID),
        ("tokens_input", "abc", api.TOKENS_INVALID),
        ("tokens_input", None, api.TOKENS_INVALID),
        ("tokens_input", "1" * 4400, api.TOKENS_INVALID),
        ("spent_on", None, api.SPENT_ON_INVALID),
        ("spent_on", 20261105, api.SPENT_ON_INVALID),
        ("spent_on", 5.5, api.SPENT_ON_INVALID),
    ],
)
def test_post_bad_field_types_refuse_with_contract_text(
    client: TestClient, field: str, value: Any, detail: str
) -> None:
    """Нечисловое количество и не строка в дате — текст контракта, а не массив pydantic.

    Схема запроса пропускает свободные типы намеренно: проверку делает ручка, поэтому
    `12.5`, `"1 500"`, `"abc"`, `null` и список получают ровно тот `detail`, который
    фронт показывает пользователю дословно.
    """
    project = _create_project(client, **ACCEPTANCE_PRICES)

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(**{field: value}),
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == detail


@pytest.mark.parametrize("value", [1_500_000.0, "1500000"])
def test_post_accepts_whole_number_in_free_type(client: TestClient, value: Any) -> None:
    """Свободный тип не мешает нормальному вводу: целое в `float` и строка из цифр."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    body = _post(client, project["id"], tokens_input=value)

    assert body["tokens_input"] == 1_500_000
    assert body["amount"] == "0.41"


def test_post_checks_project_before_body_types(client: TestClient) -> None:
    """`404` остаётся первым и при теле, которое иначе отклонила бы схема."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    client.delete(f"/api/projects/{project['id']}")

    response = client.post(
        f"/api/projects/{project['id']}/expenses",
        json=_expense_body(spent_on=None, tokens_input="abc"),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "Проект не найден"


def test_post_without_required_field_is_refused(client: TestClient) -> None:
    """Все пять полей обязательны: без количества — текст контракта, а не отказ схемы."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    body = _expense_body()
    del body["tokens_input"]

    response = client.post(f"/api/projects/{project['id']}/expenses", json=body)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.TOKENS_INVALID


def test_post_without_date_is_refused(client: TestClient) -> None:
    """Без `spent_on` ручка отвечает своим текстом про дату, а не отказом схемы."""
    project = _create_project(client, **ACCEPTANCE_PRICES)
    body = _expense_body()
    del body["spent_on"]

    response = client.post(f"/api/projects/{project['id']}/expenses", json=body)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == api.SPENT_ON_INVALID


def test_two_posts_accumulate_total(client: TestClient) -> None:
    """Каждая запись прибавляется к итогу проекта: 0,41 + 0,41 = 0,82."""
    project = _create_project(client, **ACCEPTANCE_PRICES)

    _post(client, project["id"], tokens_input=1_500_000)
    _post(client, project["id"], tokens_input=1_500_000)

    journal = client.get(f"/api/projects/{project['id']}/expenses").json()
    assert journal["total"] == "0.82"
    assert [item["amount"] for item in journal["items"]] == ["0.41", "0.41"]


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
        body = _post(client, project["id"], tokens_input=1_500_000)
    finally:
        event.remove(engine, "before_cursor_execute", capture)

    updates = [
        " ".join(statement.split()).lower()
        for statement in statements
        if statement.lstrip().upper().startswith("UPDATE") and "total_cost" in statement
    ]
    assert len(updates) == 1, updates
    assert "total_cost=(projects.total_cost + ?)" in updates[0], updates[0]
    assert body["amount"] == "0.41"


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
