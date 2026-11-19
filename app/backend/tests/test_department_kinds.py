"""Ручка справочника видов отделов `/api/department-kinds` и её связь с созданием отдела.

Справочник — зеркало ролей: две строки сида, порядок по `id`, только чтение, у каждого
вида — массив `fields` с порядком полей страницы правки. Пути создания и правки отдела
живут в `test_departments.py`; здесь проверяется сам справочник и то, что проверка проекта
идёт раньше проверки вида.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.departments import KIND_UNKNOWN
from app.api.projects import PROJECT_NOT_FOUND
from app.models.department_kind import DEFAULT_DEPARTMENT_KINDS, FIELD_KEYS_BY_CODE, DepartmentKind

KINDS_URL = "/api/department-kinds"

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}

DEVELOPMENT_FIELDS = [
    "schedule",
    "roles",
    "repo_path",
    "base_branch",
    "workspace",
    "human_workspace",
    "artifacts_dir",
    "compose_project",
    "max_rework",
    "notifications",
]
MARKETING_FIELDS = ["repo_path", "base_branch", "workspace", "human_workspace"]


@pytest.fixture(name="open_session")
def open_session_fixture(
    session_factory: sessionmaker[Session],
) -> Iterator[Session]:
    """Сессия к той же базе, что у клиента: ею в тестах заводятся строки в обход API."""
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def _create_project(client: TestClient) -> int:
    """Живой проект: без него вложенный путь создания отдела отвечает `404`."""
    response = client.post("/api/projects", json=PROJECT)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def test_list_returns_kinds_in_seed_order(client: TestClient) -> None:
    """Два вида сида в порядке `DEFAULT_DEPARTMENT_KINDS`: разработка, затем маркетинг."""
    response = client.get(KINDS_URL)

    assert response.status_code == 200
    body = response.json()
    assert [item["id"] for item in body] == [1, 2]
    assert [item["code"] for item in body] == [code for code, _title in DEFAULT_DEPARTMENT_KINDS]
    assert [item["title"] for item in body] == [title for _code, title in DEFAULT_DEPARTMENT_KINDS]


def test_kind_body_has_exactly_contract_fields(client: TestClient) -> None:
    """Тело вида — `{id, code, title, fields}`: лишнего не отдаём, `data-testid` есть."""
    body: list[dict[str, Any]] = client.get(KINDS_URL).json()

    for item in body:
        assert set(item) == {"id", "code", "title", "fields"}


def test_development_has_ten_fields_in_catalog_order(client: TestClient) -> None:
    """У «Разработки» десять полей, и порядок — порядок каталога, а не алфавит."""
    body: list[dict[str, Any]] = client.get(KINDS_URL).json()

    development = next(item for item in body if item["code"] == "development")
    assert development["fields"] == DEVELOPMENT_FIELDS
    assert development["fields"] == list(FIELD_KEYS_BY_CODE["development"])
    assert len(development["fields"]) == 10


def test_marketing_has_four_fields(client: TestClient) -> None:
    """У «Маркетинга» только четыре строки: ни времени, ни ролей, ни лимита, ни уведомлений."""
    body: list[dict[str, Any]] = client.get(KINDS_URL).json()

    marketing = next(item for item in body if item["code"] == "marketing")
    assert marketing["fields"] == MARKETING_FIELDS
    assert len(marketing["fields"]) == 4


def test_kind_absent_from_catalog_has_no_fields(
    client: TestClient,
    open_session: Session,
) -> None:
    """Код, которого нет в каталоге, даёт пустой `fields`: страница не падает."""
    open_session.add(DepartmentKind(code="support", title="Поддержка"))
    open_session.commit()

    body: list[dict[str, Any]] = client.get(KINDS_URL).json()

    support = next(item for item in body if item["code"] == "support")
    assert support["fields"] == []


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_catalog_has_no_control_handlers(client: TestClient, method: str) -> None:
    """Управляющих ручек у справочника нет: только чтение, как у ролей."""
    response = getattr(client, method)(KINDS_URL)

    assert response.status_code == 405


def test_deleted_project_is_checked_before_unknown_kind(client: TestClient) -> None:
    """`404` проекта раньше `422` вида: вложенный путь сперва смотрит на проект.

    Вид в теле заведомо неизвестен — если бы ручка проверяла его первой, ответ был бы
    `422`, а не `404`.
    """
    project_id = _create_project(client)
    assert client.delete(f"/api/projects/{project_id}").status_code == 204

    response = client.post(
        f"/api/projects/{project_id}/departments",
        json={"kind_id": 999},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == PROJECT_NOT_FOUND


def test_unknown_kind_is_rejected_on_create(client: TestClient) -> None:
    """Известный проект и неизвестный вид — `422` с дословным текстом контракта."""
    project_id = _create_project(client)

    response = client.post(
        f"/api/projects/{project_id}/departments",
        json={"kind_id": 999},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == KIND_UNKNOWN
    assert client.get(f"/api/projects/{project_id}/departments").json() == []
