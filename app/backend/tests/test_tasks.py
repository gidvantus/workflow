"""Ручки `/api/projects/{project_id}/tasks`: коды, тексты отказов и формат стоимости.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей. `Numeric` в SQLite хранится числом с плавающей
точкой, поэтому тесты сверяют строку контракта (`"1250.00"`), а не `Decimal`, и берут
представимые значения: на стенде с PostgreSQL поведение точное.
"""

from collections.abc import Iterator
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.api import tasks as api
from app.db import Base, get_db
from app.models.task import Task

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}
TASK: dict[str, str] = {
    "name": "Свёрстать список",
    "description": "Первый подраздел проекта",
    "cost": "1250",
}


@pytest.fixture(name="session_factory")
def session_factory_fixture() -> Iterator[sessionmaker[Session]]:
    """Движок на одну in-memory базу: все сессии видят одно и то же соединение."""
    engine: Engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        yield factory
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture(name="client")
def client_fixture(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    """Клиент поверх подменённой зависимости: приложение не ходит в настоящую базу."""

    def override_get_db() -> Iterator[Session]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    main.app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(main.app) as test_client:
            yield test_client
    finally:
        main.app.dependency_overrides.clear()


def _tasks_url(project_id: int) -> str:
    """Путь ручек задач проекта."""
    return f"/api/projects/{project_id}/tasks"


def _create_project(client: TestClient, **overrides: str) -> dict[str, Any]:
    """Создать проект через ручку и вернуть тело ответа: задачам нужен живой проект."""
    response = client.post("/api/projects", json={**PROJECT, **overrides})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _create_task(client: TestClient, project_id: int, **overrides: Any) -> dict[str, Any]:
    """Создать задачу через ручку и вернуть тело ответа."""
    response = client.post(_tasks_url(project_id), json={**TASK, **overrides})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _rows(session_factory: sessionmaker[Session]) -> list[Task]:
    """Строки задач напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(session.scalars(select(Task).order_by(Task.id)))


def test_create_returns_task_with_contract_fields(client: TestClient) -> None:
    """`201` и ровно те поля, что обещаны контрактом; стоимость — строка."""
    project = _create_project(client)

    response = client.post(_tasks_url(project["id"]), json=TASK)

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()
    assert set(body) == {
        "id",
        "project_id",
        "name",
        "description",
        "cost",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
    assert body["project_id"] == project["id"]
    assert body["name"] == "Свёрстать список"
    assert body["description"] == "Первый подраздел проекта"
    assert body["cost"] == "1250.00"
    assert isinstance(datetime.fromisoformat(body["created_at"]), datetime)
    assert isinstance(datetime.fromisoformat(body["updated_at"]), datetime)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1250", "1250.00"),
        ("1250.5", "1250.50"),
        ("1250,50", "1250.50"),
        (" 1250,5 ", "1250.50"),
    ],
)
def test_create_normalizes_cost_to_two_decimals(
    client: TestClient,
    value: str,
    expected: str,
) -> None:
    """Точка и запятая, один и два знака после — в ответе всегда два знака."""
    project = _create_project(client)

    body = _create_task(client, project["id"], cost=value)

    assert body["cost"] == expected


@pytest.mark.parametrize(
    "extra",
    [{}, {"cost": None}, {"cost": "  "}],
)
def test_create_without_cost_stores_null(client: TestClient, extra: dict[str, Any]) -> None:
    """Нет поля, `null` и пробелы — одно и то же: «стоимость не указана»."""
    project = _create_project(client)
    payload = {"name": TASK["name"], "description": TASK["description"], **extra}

    response = client.post(_tasks_url(project["id"]), json=payload)

    assert response.status_code == status.HTTP_201_CREATED, response.text
    assert response.json()["cost"] is None


def test_create_without_cost_keeps_value_in_database_null(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """В базе «не указана» — это `NULL`, а не `0`: иначе «бесплатно» не отличить."""
    project = _create_project(client)
    _create_task(client, project["id"], cost=None)

    rows = _rows(session_factory)

    assert len(rows) == 1
    assert rows[0].cost is None


def test_create_stores_quantized_cost(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """В базе стоимость лежит ровно с двумя знаками: `1250,5` → `1250.50`."""
    project = _create_project(client)
    _create_task(client, project["id"], cost="1250,5")

    rows = _rows(session_factory)

    assert rows[0].cost == Decimal("1250.50")


def test_create_without_description_stores_empty_string(client: TestClient) -> None:
    """`description` не обязателен: без него в ответе и в базе пустая строка."""
    project = _create_project(client)

    response = client.post(_tasks_url(project["id"]), json={"name": "Без описания"})

    assert response.status_code == status.HTTP_201_CREATED
    assert response.json()["description"] == ""


def test_create_trims_name(client: TestClient) -> None:
    """Пробелы по краям названия снимаются, а не сохраняются в базу."""
    project = _create_project(client)

    body = _create_task(client, project["id"], name="  Свёрстать список  ")

    assert body["name"] == "Свёрстать список"


def test_duplicate_names_in_one_project_are_allowed(client: TestClient) -> None:
    """Повтор названия внутри проекта разрешён: уникального индекса у задачи нет."""
    project = _create_project(client)

    first = _create_task(client, project["id"])
    second = _create_task(client, project["id"], cost=None)

    assert first["name"] == second["name"]
    assert first["id"] != second["id"]
    assert len(client.get(_tasks_url(project["id"])).json()) == 2


def test_list_is_empty_on_empty_base(client: TestClient) -> None:
    """Пустая база — пустой массив, а не отказ."""
    project = _create_project(client)

    response = client.get(_tasks_url(project["id"]))

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == []


def test_list_returns_tasks_ordered_by_id(client: TestClient) -> None:
    """Список проекта — все его задачи, порядок по `id` возрастанию."""
    project = _create_project(client)
    first = _create_task(client, project["id"], name="Первая")
    second = _create_task(client, project["id"], name="Вторая")

    response = client.get(_tasks_url(project["id"]))

    assert response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in response.json()] == [first["id"], second["id"]]
    assert [item["name"] for item in response.json()] == ["Первая", "Вторая"]


def test_list_shows_only_tasks_of_requested_project(client: TestClient) -> None:
    """Задачи второго проекта в списке первого не появляются."""
    first_project = _create_project(client)
    second_project = _create_project(client, name="DSH Desktop", repo_url="gidvantus/dsh")
    own = _create_task(client, first_project["id"], name="Своя")
    _create_task(client, second_project["id"], name="Чужая")

    first_list = client.get(_tasks_url(first_project["id"])).json()
    second_list = client.get(_tasks_url(second_project["id"])).json()

    assert [item["id"] for item in first_list] == [own["id"]]
    assert [item["name"] for item in first_list] == ["Своя"]
    assert [item["name"] for item in second_list] == ["Чужая"]


def test_unknown_project_is_not_found(client: TestClient) -> None:
    """Несуществующий проект — `404` с текстом контракта на обеих ручках."""
    list_response = client.get(_tasks_url(999))
    create_response = client.post(_tasks_url(999), json=TASK)

    assert list_response.status_code == status.HTTP_404_NOT_FOUND
    assert list_response.json() == {"detail": "Проект не найден"}
    assert create_response.status_code == status.HTTP_404_NOT_FOUND
    assert create_response.json() == {"detail": "Проект не найден"}


def test_deleted_project_is_not_found(client: TestClient) -> None:
    """Мягко удалённый проект — тот же `404`: список и создание задачи недоступны."""
    project = _create_project(client)
    deleted = client.delete(f"/api/projects/{project['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    list_response = client.get(_tasks_url(project["id"]))
    create_response = client.post(_tasks_url(project["id"]), json=TASK)

    assert list_response.status_code == status.HTTP_404_NOT_FOUND
    assert list_response.json() == {"detail": "Проект не найден"}
    assert create_response.status_code == status.HTTP_404_NOT_FOUND
    assert create_response.json() == {"detail": "Проект не найден"}


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"name": "  "}, "Укажите название задачи"),
        ({"name": "я" * 201}, "Название задачи длиннее 200 символов"),
        ({"description": "я" * 2001}, "Описание длиннее 2000 символов"),
        ({"cost": "дорого"}, "Стоимость указывается числом, например 1250.00"),
        ({"cost": "-5"}, "Стоимость указывается числом, например 1250.00"),
        ({"cost": "12.345"}, "Стоимость указывается числом, например 1250.00"),
        ({"cost": "0"}, "Стоимость должна быть больше нуля"),
        ({"cost": "0.00"}, "Стоимость должна быть больше нуля"),
    ],
)
def test_create_rejects_invalid_fields(
    client: TestClient,
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Отказы проверки — `422` с ровно тем текстом, что записан в контракте."""
    project = _create_project(client)

    response = client.post(_tasks_url(project["id"]), json={**TASK, **payload})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}
    assert client.get(_tasks_url(project["id"])).json() == []


@pytest.mark.parametrize(
    ("value", "expected"),
    [("Свёрстать список", "Свёрстать список"), ("  Свёрстать список  ", "Свёрстать список")],
)
def test_validate_name_returns_trimmed_value(value: str, expected: str) -> None:
    """Валидатор названия доступен без HTTP: он снимает пробелы по краям."""
    assert api.validate_name(value) == expected


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("", "Укажите название задачи"),
        ("   ", "Укажите название задачи"),
        ("я" * 201, "Название задачи длиннее 200 символов"),
    ],
)
def test_validate_name_rejects(value: str, detail: str) -> None:
    """Пустое и слишком длинное название — отказ `422` из валидатора."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_name(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1250", "1250.00"),
        ("1250.5", "1250.50"),
        ("1250,5", "1250.50"),
        (" 1250,50 ", "1250.50"),
        ("7", "7.00"),
    ],
)
def test_validate_cost_returns_quantized_decimal(value: str, expected: str) -> None:
    """Указанная стоимость — `Decimal` ровно с двумя знаками после разделителя."""
    assert api.validate_cost(value) == Decimal(expected)


@pytest.mark.parametrize("value", [None, "", "   "])
def test_validate_cost_absent_is_none(value: str | None) -> None:
    """Поле не прислано, `null` или пробелы — «стоимость не указана», без отказа."""
    assert api.validate_cost(value) is None


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("дорого", "Стоимость указывается числом, например 1250.00"),
        ("-5", "Стоимость указывается числом, например 1250.00"),
        ("12.345", "Стоимость указывается числом, например 1250.00"),
        ("1 250", "Стоимость указывается числом, например 1250.00"),
        ("0", "Стоимость должна быть больше нуля"),
        ("0.00", "Стоимость должна быть больше нуля"),
    ],
)
def test_validate_cost_rejects(value: str, detail: str) -> None:
    """Нечисло и неформат — отказ про формат, ноль — отказ про «больше нуля»."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_cost(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


def test_validate_description_allows_empty_and_long() -> None:
    """Пустое описание разрешено, ровно 2000 символов ещё проходит проверку."""
    assert api.validate_description("") == ""
    assert api.validate_description("я" * 2000) == "я" * 2000


def test_validate_description_rejects_over_limit() -> None:
    """Описание длиннее 2000 символов — отказ `422` тем же текстом, что у проекта."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_description("я" * 2001)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == "Описание длиннее 2000 символов"
