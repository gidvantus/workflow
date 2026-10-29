"""Ручки `/api/projects`: коды, дословные тексты отказов и soft delete.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей. Индекс `uq_projects_name_alive` живёт и в SQLite,
поэтому поведение совпадает со стендом.
"""

from collections.abc import Iterator
from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, select, update
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.api import projects as api
from app.db import Base, get_db
from app.models.project import Project

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
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


def _create(client: TestClient, **overrides: str) -> dict[str, Any]:
    """Создать проект через ручку и вернуть тело ответа."""
    payload = {**PROJECT, **overrides}
    response = client.post("/api/projects", json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _rows(session_factory: sessionmaker[Session]) -> list[Project]:
    """Строки таблицы напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(session.scalars(select(Project).order_by(Project.id)))


def test_create_returns_created_project(client: TestClient) -> None:
    """`201` и ровно те поля, что обещаны контрактом."""
    response = client.post("/api/projects", json=PROJECT)

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()
    assert set(body) == {
        "id",
        "name",
        "description",
        "repo_url",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
    assert body["name"] == "Workflow"
    assert body["description"] == "Отдел разработки"
    assert body["repo_url"] == "gidvantus/workflow"
    assert isinstance(datetime.fromisoformat(body["created_at"]), datetime)
    assert isinstance(datetime.fromisoformat(body["updated_at"]), datetime)


def test_create_without_description_stores_empty_string(client: TestClient) -> None:
    """`description` не обязателен: без него в базе пустая строка, а не `NULL`."""
    response = client.post(
        "/api/projects",
        json={"name": "DSH Desktop", "repo_url": "https://example.com/dsh.git"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.json()["description"] == ""


def test_list_is_empty_on_empty_base(client: TestClient) -> None:
    """Пустая база — пустой массив, а не отказ."""
    response = client.get("/api/projects")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == []


def test_list_returns_alive_projects_ordered_by_id(client: TestClient) -> None:
    """Список — только живые строки, порядок по `id` возрастанию."""
    first = _create(client, name="Первый", repo_url="gidvantus/one")
    second = _create(client, name="Второй", repo_url="gidvantus/two")

    response = client.get("/api/projects")

    assert response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in response.json()] == [first["id"], second["id"]]
    assert [item["name"] for item in response.json()] == ["Первый", "Второй"]


def test_duplicate_name_is_conflict(client: TestClient) -> None:
    """Повтор названия — `409` с дословным текстом контракта."""
    _create(client)

    response = client.post("/api/projects", json={**PROJECT, "repo_url": "gidvantus/other"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Проект с таким названием уже есть"}


def test_duplicate_name_ignores_register(client: TestClient) -> None:
    """Занятость названия сравнивается без учёта регистра."""
    _create(client)

    response = client.post("/api/projects", json={**PROJECT, "name": "WORKFLOW"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Проект с таким названием уже есть"}


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"name": "  "}, "Укажите название проекта"),
        ({"name": "я" * 201}, "Название длиннее 200 символов"),
        ({"repo_url": ""}, "Укажите адрес репозитория"),
        ({"repo_url": "   "}, "Укажите адрес репозитория"),
        ({"repo_url": "не ссылка"}, "Адрес репозитория должен быть ссылкой или вида owner/repo"),
        ({"description": "я" * 2001}, "Описание длиннее 2000 символов"),
    ],
)
def test_create_rejects_invalid_fields(
    client: TestClient,
    payload: dict[str, str],
    detail: str,
) -> None:
    """Отказы проверки — `422` с ровно тем текстом, что записан в контракте."""
    response = client.post("/api/projects", json={**PROJECT, **payload})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_create_trims_name_and_repo_url(client: TestClient) -> None:
    """Пробелы по краям снимаются, а не сохраняются в базу."""
    response = client.post(
        "/api/projects",
        json={"name": "  Workflow  ", "repo_url": "  https://example.com/w.git  "},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.json()["name"] == "Workflow"
    assert response.json()["repo_url"] == "https://example.com/w.git"


def test_patch_changes_name_and_updated_at(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` меняет название и `updated_at`, не трогая остальные поля."""
    created = _create(client)
    # created_at отодвигается в прошлое, чтобы сравнение не зависело от точности часов.
    with session_factory() as session:
        session.execute(
            update(Project)
            .where(Project.id == created["id"])
            .values(created_at=datetime(2000, 1, 1))
        )
        session.commit()

    response = client.patch(f"/api/projects/{created['id']}", json={"name": "Workflow 2"})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["id"] == created["id"]
    assert body["name"] == "Workflow 2"
    assert body["description"] == created["description"]
    assert body["repo_url"] == created["repo_url"]
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


def test_patch_keeps_omitted_fields(client: TestClient) -> None:
    """Поля, которых нет в теле, остаются прежними."""
    created = _create(client)

    response = client.patch(f"/api/projects/{created['id']}", json={"description": "Новое"})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["name"] == created["name"]
    assert body["repo_url"] == created["repo_url"]
    assert body["description"] == "Новое"


def test_patch_empty_body_is_unprocessable(client: TestClient) -> None:
    """Пустое тело — `422` с дословным текстом контракта."""
    created = _create(client)

    response = client.patch(f"/api/projects/{created['id']}", json={})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Нет полей для изменения"}


def test_patch_unknown_project_not_found(client: TestClient) -> None:
    """Правка несуществующего проекта — `404`."""
    response = client.patch("/api/projects/999", json={"name": "Кто-то"})

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Проект не найден"}


def test_patch_taken_name_is_conflict(client: TestClient) -> None:
    """Переименование в занятое имя — `409`."""
    _create(client)
    second = _create(client, name="Второй", repo_url="gidvantus/two")

    response = client.patch(f"/api/projects/{second['id']}", json={"name": "workflow"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Проект с таким названием уже есть"}


def test_delete_is_soft(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """`204`; из списка проект исчезает, а строка в таблице остаётся с `deleted_at`."""
    created = _create(client)

    response = client.delete(f"/api/projects/{created['id']}")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert response.content == b""
    assert client.get("/api/projects").json() == []
    rows = _rows(session_factory)
    assert len(rows) == 1
    assert rows[0].id == created["id"]
    assert rows[0].name == created["name"]
    assert rows[0].deleted_at is not None


def test_repeat_operations_on_deleted_project_are_not_found(client: TestClient) -> None:
    """`PATCH` и повторный `DELETE` по удалённому проекту — `404`, воскрешения нет."""
    created = _create(client)
    deleted = client.delete(f"/api/projects/{created['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    patch_response = client.patch(f"/api/projects/{created['id']}", json={"name": "Ещё раз"})
    delete_response = client.delete(f"/api/projects/{created['id']}")

    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.json() == {"detail": "Проект не найден"}
    assert delete_response.status_code == status.HTTP_404_NOT_FOUND
    assert delete_response.json() == {"detail": "Проект не найден"}


def test_name_of_deleted_project_can_be_used_again(client: TestClient) -> None:
    """Имя удалённого проекта свободно: индекс смотрит только на живые строки."""
    created = _create(client)
    deleted = client.delete(f"/api/projects/{created['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    repeated = _create(client)

    assert repeated["name"] == created["name"]
    assert repeated["id"] != created["id"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("Workflow", "Workflow"), ("  Workflow  ", "Workflow")],
)
def test_validate_name_returns_trimmed_value(value: str, expected: str) -> None:
    """Валидатор имени доступен без HTTP: он снимает пробелы по краям."""
    assert api.validate_name(value) == expected


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("", "Укажите название проекта"),
        ("   ", "Укажите название проекта"),
        ("я" * 201, "Название длиннее 200 символов"),
    ],
)
def test_validate_name_rejects(value: str, detail: str) -> None:
    """Пустое и слишком длинное имя — отказ `422` из валидатора."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_name(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


@pytest.mark.parametrize(
    "value",
    ["gidvantus/workflow", "https://github.com/gidvantus/workflow", " http://example.com/x "],
)
def test_validate_repo_url_accepts(value: str) -> None:
    """Форма `owner/repo` и ссылка http(s) проходят проверку."""
    assert api.validate_repo_url(value) == value.strip()


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("", "Укажите адрес репозитория"),
        ("   ", "Укажите адрес репозитория"),
        ("не ссылка", "Адрес репозитория должен быть ссылкой или вида owner/repo"),
        ("example com/x", "Адрес репозитория должен быть ссылкой или вида owner/repo"),
        ("ftp://example.com", "Адрес репозитория должен быть ссылкой или вида owner/repo"),
    ],
)
def test_validate_repo_url_rejects(value: str, detail: str) -> None:
    """Пустое и кривое значение адреса репозитория — отказ `422` с текстом контракта."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_repo_url(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail
