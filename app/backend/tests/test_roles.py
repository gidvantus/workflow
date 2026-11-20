"""Раздел «Роли»: справочник, правка из веба, мягкое удаление и связь с отделами.

Проверяется то, что видит человек и фронт: состав полей `GET /api/roles`, коды ответов
`POST`/`PATCH`/`DELETE` и дословные тексты отказов — они часть контракта, поэтому
сравниваются как строки, а не «какой-то 422».

Отдельная группа — граница с отделами: роль, стоящая в живом отделе, не удаляется, а
роль, удалённая до привязки, не принимается в `role_ids` тем же текстом, что и
несуществующая. Скиллы ролей живут в `test_skills.py`, машинные ручки — в `test_presets.py`.
"""

from collections.abc import Iterator
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.departments import ROLE_UNKNOWN
from app.api.roles import (
    NO_FIELDS_TO_UPDATE,
    ROLE_CODE_FORMAT,
    ROLE_CODE_IMMUTABLE,
    ROLE_CODE_REQUIRED,
    ROLE_CODE_TAKEN,
    ROLE_CODE_TOO_LONG,
    ROLE_DESCRIPTION_TOO_LONG,
    ROLE_IN_DEPARTMENTS,
    ROLE_NOT_FOUND,
    ROLE_TITLE_REQUIRED,
    ROLE_TITLE_TOO_LONG,
)
from app.models.department import Department
from app.models.role import DEFAULT_ROLES, Role

ROLES_URL = "/api/roles"

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}

# Поля ответа роли: `skill_count` считается на чтении, `updated_at` двигается при правке.
ROLE_FIELDS = {"id", "code", "title", "description", "skill_count", "updated_at"}


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


def _create_role(client: TestClient, **payload: Any) -> dict[str, Any]:
    """Живая роль через API: код и название задаются вызывающим, остальное — по умолчанию."""
    body: dict[str, Any] = {"code": "data-analyst", "title": "Дата-аналитик"}
    body.update(payload)
    response = client.post(ROLES_URL, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _roles(client: TestClient) -> list[dict[str, Any]]:
    """Список ролей как его видит фронт."""
    return client.get(ROLES_URL).json()


def _project_id(client: TestClient) -> int:
    """Живой проект: без него вложенный путь создания отдела отвечает `404`."""
    response = client.post("/api/projects", json=PROJECT)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def test_list_returns_seeded_roles_with_new_fields(client: TestClient) -> None:
    """Десять ролей сида, у каждой — описание, число скиллов и время правки."""
    body = _roles(client)

    assert len(body) == 10
    assert [item["code"] for item in body] == [code for code, _title in DEFAULT_ROLES]
    assert [item["id"] for item in body] == list(range(1, 11))
    for item in body:
        assert set(item) == ROLE_FIELDS
        assert item["description"] == ""
        assert item["skill_count"] == 0
        assert isinstance(datetime.fromisoformat(item["updated_at"]), datetime)


def test_create_returns_created_role(client: TestClient) -> None:
    """`201` и полная строка роли: новая роль становится последней в списке."""
    response = client.post(
        ROLES_URL,
        json={"code": "data-analyst", "title": "Дата-аналитик", "description": "Считает метрики"},
    )

    assert response.status_code == 201
    body = response.json()
    assert set(body) == ROLE_FIELDS
    assert body["id"] == 11
    assert body["code"] == "data-analyst"
    assert body["title"] == "Дата-аналитик"
    assert body["description"] == "Считает метрики"
    assert body["skill_count"] == 0

    assert _roles(client)[-1] == body


def test_create_without_description_stores_empty_string(client: TestClient) -> None:
    """Описание необязательно: в базе пустая строка, а не `null`."""
    body = _create_role(client)

    assert body["description"] == ""
    assert _roles(client)[-1]["description"] == ""


def test_create_trims_code_and_title(client: TestClient) -> None:
    """Пробелы по краям кода и названия срезаются: код — имя каталога пресета."""
    body = _create_role(client, code="  data-analyst  ", title="  Дата-аналитик  ")

    assert body["code"] == "data-analyst"
    assert body["title"] == "Дата-аналитик"


def test_create_with_existing_code_conflicts(client: TestClient) -> None:
    """Код живой роли занят: `409` и текст контракта."""
    response = client.post(ROLES_URL, json={"code": "analyst", "title": "Ещё аналитик"})

    assert response.status_code == 409
    assert response.json()["detail"] == ROLE_CODE_TAKEN


def test_create_with_code_of_deleted_role_conflicts(client: TestClient) -> None:
    """Код мягко удалённой роли не переиспользуется: `409`, второй строки не появляется."""
    body = _create_role(client)
    assert client.delete(f"{ROLES_URL}/{body['id']}").status_code == 204

    response = client.post(ROLES_URL, json={"code": "data-analyst", "title": "Дата-аналитик"})

    assert response.status_code == 409
    assert response.json()["detail"] == ROLE_CODE_TAKEN


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"title": "Без кода"}, ROLE_CODE_REQUIRED),
        ({"code": "", "title": "Пустой код"}, ROLE_CODE_REQUIRED),
        ({"code": "   ", "title": "Одни пробелы"}, ROLE_CODE_REQUIRED),
        ({"code": "Data-Analyst", "title": "Заглавные"}, ROLE_CODE_FORMAT),
        ({"code": "data_analyst", "title": "Подчёркивание"}, ROLE_CODE_FORMAT),
        ({"code": "-lead", "title": "Дефис первым"}, ROLE_CODE_FORMAT),
        ({"code": "аналитик", "title": "Кириллица"}, ROLE_CODE_FORMAT),
        ({"code": "a" * 51, "title": "Длинный код"}, ROLE_CODE_TOO_LONG),
        ({"code": "data-analyst"}, ROLE_TITLE_REQUIRED),
        ({"code": "data-analyst", "title": "  "}, ROLE_TITLE_REQUIRED),
        ({"code": "data-analyst", "title": "я" * 101}, ROLE_TITLE_TOO_LONG),
    ],
)
def test_create_validates_code_and_title(
    client: TestClient,
    payload: dict[str, str],
    detail: str,
) -> None:
    """Пределы и формат кода и названия: `422` с дословным текстом контракта."""
    response = client.post(ROLES_URL, json=payload)

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    # Отказ ничего не создаёт: список остаётся сидовым.
    assert len(_roles(client)) == 10


def test_create_rejects_too_long_description(client: TestClient) -> None:
    """Описание роли длиннее 2000 символов — `422`."""
    response = client.post(
        ROLES_URL,
        json={"code": "data-analyst", "title": "Дата-аналитик", "description": "я" * 2001},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == ROLE_DESCRIPTION_TOO_LONG


def test_create_accepts_maximum_lengths(client: TestClient) -> None:
    """Ровно предельные значения принимаются: граница включительная."""
    body = _create_role(
        client,
        code="a" * 50,
        title="я" * 100,
        description="я" * 2000,
    )

    assert len(body["code"]) == 50
    assert len(body["title"]) == 100
    assert len(body["description"]) == 2000


def test_patch_updates_title_and_description(client: TestClient) -> None:
    """`PATCH` меняет название и описание и двигает `updated_at`."""
    before = _roles(client)[0]

    response = client.patch(
        f"{ROLES_URL}/1",
        json={"title": "Системный аналитик", "description": "Собирает требования"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Системный аналитик"
    assert body["description"] == "Собирает требования"
    assert body["code"] == "analyst"
    assert body["updated_at"] != before["updated_at"]
    assert _roles(client)[0] == body


def test_patch_field_absent_is_untouched(client: TestClient) -> None:
    """Поля, которого нет в теле, правка не касается: описание остаётся прежним."""
    client.patch(f"{ROLES_URL}/1", json={"description": "Собирает требования"})

    response = client.patch(f"{ROLES_URL}/1", json={"title": "Системный аналитик"})

    assert response.status_code == 200
    assert response.json()["description"] == "Собирает требования"


def test_patch_clears_description(client: TestClient) -> None:
    """Пустая строка и `null` стирают описание: «не заполнено» — это пусто."""
    client.patch(f"{ROLES_URL}/1", json={"description": "Собирает требования"})

    assert client.patch(f"{ROLES_URL}/1", json={"description": ""}).json()["description"] == ""
    assert client.patch(f"{ROLES_URL}/1", json={"description": None}).json()["description"] == ""


def test_patch_code_is_rejected(client: TestClient) -> None:
    """Код неизменяем: `422`, а не молчаливое игнорирование присланного значения."""
    response = client.patch(f"{ROLES_URL}/1", json={"code": "system-analyst"})

    assert response.status_code == 422
    assert response.json()["detail"] == ROLE_CODE_IMMUTABLE
    assert _roles(client)[0]["code"] == "analyst"


def test_patch_empty_body_is_rejected(client: TestClient) -> None:
    """Пустое тело — `422`: правка без полей ничего не значит."""
    response = client.patch(f"{ROLES_URL}/1", json={})

    assert response.status_code == 422
    assert response.json()["detail"] == NO_FIELDS_TO_UPDATE


def test_patch_unknown_role(client: TestClient) -> None:
    """Неизвестный `id` — `404` с текстом контракта."""
    response = client.patch(f"{ROLES_URL}/999", json={"title": "Кто-то"})

    assert response.status_code == 404
    assert response.json()["detail"] == ROLE_NOT_FOUND


def test_patch_deleted_role_is_not_found(client: TestClient) -> None:
    """Мягко удалённая роль не правится: `404`, воскрешения через `PATCH` нет."""
    body = _create_role(client)
    assert client.delete(f"{ROLES_URL}/{body['id']}").status_code == 204

    response = client.patch(f"{ROLES_URL}/{body['id']}", json={"title": "Дата-аналитик"})

    assert response.status_code == 404
    assert response.json()["detail"] == ROLE_NOT_FOUND


def test_delete_is_soft_and_hides_role(client: TestClient) -> None:
    """`204`: роль уходит из списка, строка в базе остаётся, второй `DELETE` — `404`."""
    body = _create_role(client)

    response = client.delete(f"{ROLES_URL}/{body['id']}")

    assert response.status_code == 204
    assert response.content == b""
    assert body["code"] not in [item["code"] for item in _roles(client)]
    assert client.delete(f"{ROLES_URL}/{body['id']}").status_code == 404


def test_delete_keeps_row_in_database(client: TestClient, open_session: Session) -> None:
    """Строка остаётся в базе с `deleted_at`: удаление мягкое, история не рвётся."""
    body = _create_role(client)
    client.delete(f"{ROLES_URL}/{body['id']}")

    role = open_session.get(Role, body["id"])
    assert role is not None
    assert role.deleted_at is not None


def test_delete_unknown_role(client: TestClient) -> None:
    """Неизвестный `id` — `404`."""
    response = client.delete(f"{ROLES_URL}/999")

    assert response.status_code == 404
    assert response.json()["detail"] == ROLE_NOT_FOUND


def test_delete_role_in_department_conflicts(client: TestClient) -> None:
    """Роль в живом отделе не удаляется: `409`, отдел не теряет роль молча."""
    project_id = _project_id(client)
    department = client.post(f"/api/projects/{project_id}/departments", json={"kind_id": 1}).json()
    patched = client.patch(
        f"/api/departments/{department['id']}",
        json={"role_ids": [1], "windows": [{"start_time": "09:00", "end_time": "18:00"}]},
    )
    assert patched.status_code == 200, patched.text
    assert [role["id"] for role in patched.json()["roles"]] == [1]

    response = client.delete(f"{ROLES_URL}/1")

    assert response.status_code == 409
    assert response.json()["detail"] == ROLE_IN_DEPARTMENTS
    assert "analyst" in [item["code"] for item in _roles(client)]


def test_delete_role_succeeds_after_department_frees_it(client: TestClient) -> None:
    """Убрали роль из отдела — её можно удалить: отказ держится на живой связи."""
    project_id = _project_id(client)
    department = client.post(f"/api/projects/{project_id}/departments", json={"kind_id": 1}).json()
    window = [{"start_time": "09:00", "end_time": "18:00"}]
    client.patch(f"/api/departments/{department['id']}", json={"role_ids": [1], "windows": window})
    client.patch(f"/api/departments/{department['id']}", json={"role_ids": [], "windows": window})

    response = client.delete(f"{ROLES_URL}/1")

    assert response.status_code == 204


def test_deleted_role_disappears_from_department(
    client: TestClient,
    open_session: Session,
) -> None:
    """Мягко удалённая роль не показывается в отделе, даже если связь осталась.

    Через API это состояние не собрать (роль в живом отделе не удаляется), поэтому
    строка связи заводится напрямую — фильтр `secondaryjoin` обязан её отбросить.
    """
    project_id = _project_id(client)
    department = client.post(f"/api/projects/{project_id}/departments", json={"kind_id": 1}).json()
    window = [{"start_time": "09:00", "end_time": "18:00"}]
    client.patch(f"/api/departments/{department['id']}", json={"role_ids": [2], "windows": window})

    row = open_session.get(Department, department["id"])
    assert row is not None
    role = open_session.get(Role, 2)
    assert role is not None
    role.deleted_at = datetime(2026, 11, 21, 12, 0)
    open_session.commit()

    body = client.get(f"/api/projects/{project_id}/departments").json()

    assert body[0]["roles"] == []


def test_deleted_role_is_not_accepted_in_department(client: TestClient) -> None:
    """Удалённая роль в `role_ids` — тот же `422`, что и несуществующая."""
    project_id = _project_id(client)
    department = client.post(f"/api/projects/{project_id}/departments", json={"kind_id": 1}).json()
    body = _create_role(client)
    assert client.delete(f"{ROLES_URL}/{body['id']}").status_code == 204

    response = client.patch(
        f"/api/departments/{department['id']}",
        json={
            "role_ids": [body["id"]],
            "windows": [{"start_time": "09:00", "end_time": "18:00"}],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == ROLE_UNKNOWN
