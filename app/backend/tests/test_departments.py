"""Ручки `/api/roles` и отделов проекта: коды, дословные тексты и мягкое удаление.

Отдел живёт внутри проекта, поэтому создание и список ходят вложенным путём
(`/api/projects/{project_id}/departments`), а правка и удаление — плоским
(`/api/departments/{department_id}`). Создание выбирает только вид отдела: имя отдела —
это название вида, время работы и роли заполняются на странице правки.

База в памяти и сид справочников живут в `conftest.py`: без сида `department_kinds` и
`roles` нечего выбирать, а без настоящего частичного индекса
`uq_departments_project_name_alive` гонку по имени проверить нечем.
"""

import json
from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.api import departments as api
from app.api import registry as registry_api
from app.models.department import Department, department_roles
from app.models.department_kind import FIELD_KEYS_BY_CODE
from app.models.registry import RegistryDocument
from app.models.role import DEFAULT_ROLES

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}
SECOND_PROJECT: dict[str, str] = {
    "name": "CloudPass",
    "description": "Второй проект",
    "repo_url": "gidvantus/cloudpass",
}

# `id` видов — автоинкремент сида: «Разработка» первая, «Маркетинг» вторая.
DEVELOPMENT_KIND_ID = 1
MARKETING_KIND_ID = 2

# Тело создания: ровно один вид, ни имени, ни времени, ни ролей.
DEPARTMENT: dict[str, Any] = {"kind_id": DEVELOPMENT_KIND_ID}

# Telegram-значения в тестах вымышленные: настоящие токен и id чата живут только
# в реестре проектов отдела и в репозиторий не попадают никогда.
TELEGRAM_TOKEN = "123456789:AAHfakeTokenForDepartmentTests"
TELEGRAM_CHAT_ID = "123456789"

# Поля страницы правки: имя, образец значения, предел длины, текст отказа на длину.
TEXT_FIELD_CASES: list[tuple[str, str, int, str]] = [
    ("repo_path", "gidvantus/workflow", 500, api.REPO_PATH_TOO_LONG),
    ("base_branch", "main", 200, api.BASE_BRANCH_TOO_LONG),
    ("workspace", "D:\\Agents\\Workflow", 500, api.WORKSPACE_TOO_LONG),
    ("human_workspace", "D:\\Development\\VideCoding\\Workflow", 500, api.HUMAN_WORKSPACE_TOO_LONG),
    ("artifacts_dir", "D:\\Agents\\Workflow-artifacts", 500, api.ARTIFACTS_DIR_TOO_LONG),
    ("compose_project", "workflow-agent", 200, api.COMPOSE_PROJECT_TOO_LONG),
    ("telegram_token", TELEGRAM_TOKEN, 200, api.TELEGRAM_TOKEN_TOO_LONG),
    ("telegram_chat_id", TELEGRAM_CHAT_ID, 64, api.TELEGRAM_CHAT_ID_TOO_LONG),
]
TEXT_FIELDS = [field for field, _value, _max, _detail in TEXT_FIELD_CASES]

# Договорное тело ответа отдела: `fields` и `kind` добавлены справочником видов.
DEPARTMENT_FIELDS = {
    "id",
    "project_id",
    "name",
    "kind",
    "fields",
    "windows",
    "roles",
    "repo_path",
    "base_branch",
    "workspace",
    "human_workspace",
    "artifacts_dir",
    "compose_project",
    "telegram_token",
    "telegram_chat_id",
    "max_rework",
    "enabled",
    "notifications_enabled",
    "created_at",
    "updated_at",
}

# Отодвинутое в прошлое время: сравнение `updated_at` не зависит от точности часов.
PAST = datetime(2000, 1, 1)


@pytest.fixture(name="project_id")
def project_id_fixture(client: TestClient) -> int:
    """Живой проект: без него вложенные ручки отделов отвечают `404`."""
    return int(_create_project(client)["id"])


def _create_project(client: TestClient, **overrides: str) -> dict[str, Any]:
    """Создать проект через ручку и вернуть тело ответа."""
    response = client.post("/api/projects", json={**PROJECT, **overrides})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _departments_url(project_id: int) -> str:
    """Путь списка и создания отделов проекта."""
    return f"/api/projects/{project_id}/departments"


def _department_url(department_id: int) -> str:
    """Путь правки и удаления одного отдела."""
    return f"/api/departments/{department_id}"


def _create(
    client: TestClient,
    project_id: int,
    kind_id: int = DEVELOPMENT_KIND_ID,
) -> dict[str, Any]:
    """Создать отдел через ручку выбранным видом и вернуть тело ответа."""
    response = client.post(_departments_url(project_id), json={"kind_id": kind_id})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _windows(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    """Окна работы из пар «начало, конец» — в том виде, в каком их принимает `PATCH`."""
    return [{"start_time": start, "end_time": end} for start, end in pairs]


# Окна работы — семь штук встык, без пересечений: на одно больше предела задачи.
SEVEN_WINDOWS: list[dict[str, str]] = _windows(
    ("00:00", "03:00"),
    ("03:00", "06:00"),
    ("06:00", "09:00"),
    ("09:00", "12:00"),
    ("12:00", "15:00"),
    ("15:00", "18:00"),
    ("18:00", "21:00"),
)


def _age_row(session_factory: sessionmaker[Session], department_id: int) -> None:
    """Отодвинуть `created_at` и `updated_at` строки в прошлое — для сравнения дат."""
    with session_factory() as session:
        session.execute(
            update(Department)
            .where(Department.id == department_id)
            .values(created_at=PAST, updated_at=PAST)
        )
        session.commit()


def _rows(session_factory: sessionmaker[Session]) -> list[Department]:
    """Строки таблицы напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(session.scalars(select(Department).order_by(Department.id)))


def _links(session_factory: sessionmaker[Session]) -> list[tuple[int, int]]:
    """Строки связи `department_roles` напрямую из базы."""
    with session_factory() as session:
        return [
            (row.department_id, row.role_id)
            for row in session.execute(select(department_roles)).all()
        ]


def test_roles_are_seeded_in_contract_order(client: TestClient) -> None:
    """`GET /api/roles` — ровно десять ролей в порядке таблицы контракта.

    Поля `description`, `skill_count` и `updated_at` появились вместе с разделом «Роли»:
    первые две роли ниже сверяются по `id`/`code`/`title`, потому что остальные поля
    заводятся вместе с ролью и проверяются в `test_roles.py`.
    """
    response = client.get("/api/roles")

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert len(body) == 10
    assert [item["code"] for item in body] == [code for code, _ in DEFAULT_ROLES]
    assert [item["id"] for item in body] == list(range(1, 11))
    assert [item["title"] for item in body] == [title for _code, title in DEFAULT_ROLES]
    assert set(body[0]) == {"id", "code", "title", "description", "skill_count", "updated_at"}
    assert body[0]["id"] == 1
    assert body[0]["code"] == "analyst"
    assert body[0]["title"] == "Аналитик"
    assert body[9]["code"] == "jev"
    assert body[9]["title"] == "Jev (System One)"


def test_create_returns_created_department(client: TestClient, project_id: int) -> None:
    """`201` и ровно те поля, что обещаны контрактом: пустое расписание и роли.

    Создание выбирает только вид, поэтому имя — название вида, а время и роли приезжают
    пустыми: их заполняют на странице правки. `fields` уже здесь — фронт рисует страницу
    по ответу ручки, не дожидаясь отдельного справочника.
    """
    response = client.post(_departments_url(project_id), json=DEPARTMENT)

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()
    assert set(body) == DEPARTMENT_FIELDS
    assert body["id"] == 1
    # Проект приходит из пути, а не из тела: форма создания проекта не выбирает.
    assert body["project_id"] == project_id
    assert body["name"] == "Разработка"
    assert body["kind"] == {"id": DEVELOPMENT_KIND_ID, "code": "development", "title": "Разработка"}
    assert body["fields"] == list(FIELD_KEYS_BY_CODE["development"])
    # Новый отдел создаётся без расписания: пустой набор окон, а не `null`.
    assert body["windows"] == []
    assert body["roles"] == []
    assert body["max_rework"] == 3
    # Работа отдела включена: выключенный отдел перестал бы брать задачи, и умолчание
    # `false` остановило бы работу после выкатки.
    assert body["enabled"] is True
    assert body["notifications_enabled"] is False
    for field in TEXT_FIELDS:
        assert body[field] is None
    assert isinstance(datetime.fromisoformat(body["created_at"]), datetime)
    assert isinstance(datetime.fromisoformat(body["updated_at"]), datetime)


def test_create_marketing_kind_uses_its_own_fields(
    client: TestClient,
    project_id: int,
) -> None:
    """«Маркетинг» — четыре поля страницы и ни одного лишнего."""
    created = _create(client, project_id, MARKETING_KIND_ID)

    assert created["name"] == "Маркетинг"
    assert created["kind"]["code"] == "marketing"
    assert created["fields"] == list(FIELD_KEYS_BY_CODE["marketing"])
    assert created["fields"] == ["repo_path", "base_branch", "workspace", "human_workspace"]


def test_create_allows_both_kinds_in_one_project(
    client: TestClient,
    project_id: int,
) -> None:
    """Вид — не уникальный ключ: в одном проекте живут и разработка, и маркетинг."""
    _create(client, project_id, DEVELOPMENT_KIND_ID)
    marketing = _create(client, project_id, MARKETING_KIND_ID)

    assert [item["name"] for item in client.get(_departments_url(project_id)).json()] == [
        "Разработка",
        "Маркетинг",
    ]
    assert marketing["id"] == 2


def test_create_same_kind_in_two_projects_is_allowed(client: TestClient) -> None:
    """Одно и то же имя в двух проектах — не конфликт: правило проекта."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]

    first = _create(client, first_project)
    second = _create(client, second_project)

    assert first["name"] == second["name"] == "Разработка"
    assert first["project_id"] != second["project_id"]


def test_create_duplicate_kind_is_conflict(client: TestClient, project_id: int) -> None:
    """Второй отдел того же вида в проекте — `409`: имя вида уже занято."""
    _create(client, project_id)

    response = client.post(_departments_url(project_id), json=DEPARTMENT)

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}
    assert len(client.get(_departments_url(project_id)).json()) == 1


def test_create_duplicate_name_is_caught_by_index(
    client: TestClient,
    project_id: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонку по имени ловит частичный индекс, а не только проверка в ручке.

    Проверка `_name_is_taken` отключена: если бы уникальность держала только она, второй
    `POST` создал бы дубль, а он обязан получить тот же `409`.
    """
    _create(client, project_id)
    monkeypatch.setattr(api, "_name_is_taken", lambda *_args, **_kwargs: False)

    response = client.post(_departments_url(project_id), json=DEPARTMENT)

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}
    assert len(client.get(_departments_url(project_id)).json()) == 1


def test_index_allows_same_name_in_different_projects(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Индекс не мешает одинаковым именам в разных проектах: он по паре с проектом."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    _create(client, first_project)
    monkeypatch.setattr(api, "_name_is_taken", lambda *_args, **_kwargs: False)

    created = _create(client, second_project)

    assert created["name"] == "Разработка"
    assert created["project_id"] == second_project
    assert len(client.get(_departments_url(first_project)).json()) == 1
    assert len(client.get(_departments_url(second_project)).json()) == 1


def test_create_without_kind_is_schema_error(client: TestClient, project_id: int) -> None:
    """Тело без `kind_id` — `422` схемы: без вида отдел не создаётся."""
    response = client.post(_departments_url(project_id), json={})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert "kind_id" in response.text


def test_list_is_empty_on_empty_project(client: TestClient, project_id: int) -> None:
    """Пустой проект — пустой массив, а не отказ."""
    response = client.get(_departments_url(project_id))

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == []


def test_list_returns_alive_departments_ordered_by_id(
    client: TestClient,
    project_id: int,
) -> None:
    """Список — только живые строки проекта, порядок по `id`, у каждой свой `fields`."""
    first = _create(client, project_id, DEVELOPMENT_KIND_ID)
    second = _create(client, project_id, MARKETING_KIND_ID)

    response = client.get(_departments_url(project_id))

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert [item["id"] for item in body] == [first["id"], second["id"]]
    assert [item["name"] for item in body] == ["Разработка", "Маркетинг"]
    assert [item["fields"] for item in body] == [
        list(FIELD_KEYS_BY_CODE["development"]),
        list(FIELD_KEYS_BY_CODE["marketing"]),
    ]
    assert set(body[0]) == DEPARTMENT_FIELDS


def test_list_shows_only_departments_of_this_project(client: TestClient) -> None:
    """Список проекта не показывает чужие отделы."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    _create(client, first_project, DEVELOPMENT_KIND_ID)
    _create(client, second_project, MARKETING_KIND_ID)

    first_listed = client.get(_departments_url(first_project)).json()
    second_listed = client.get(_departments_url(second_project)).json()

    assert [item["name"] for item in first_listed] == ["Разработка"]
    assert [item["name"] for item in second_listed] == ["Маркетинг"]


@pytest.mark.parametrize("method", ["get", "post"])
def test_nested_handlers_check_project_before_body(
    client: TestClient,
    method: str,
) -> None:
    """Несуществующий проект — `404` раньше любой проверки тела."""
    response = getattr(client, method)(
        _departments_url(999),
        **({"json": {"kind_id": 999}} if method == "post" else {}),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Проект не найден"}


@pytest.mark.parametrize("method", ["get", "post"])
def test_nested_handlers_hide_deleted_project(client: TestClient, method: str) -> None:
    """Мягко удалённый проект — тот же `404`: его отделы недостижимы вложенным путём."""
    project_id = _create_project(client)["id"]
    assert client.delete(f"/api/projects/{project_id}").status_code == status.HTTP_204_NO_CONTENT

    response = getattr(client, method)(
        _departments_url(project_id),
        **({"json": DEPARTMENT} if method == "post" else {}),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Проект не найден"}


def test_patch_changes_only_sent_fields(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` меняет присланное поле и `updated_at`, не трогая время, роли и проект."""
    created = _create(client, project_id)
    _age_row(session_factory, created["id"])

    response = client.patch(
        _department_url(created["id"]), json={"repo_path": " gidvantus/workflow "}
    )

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["id"] == created["id"]
    assert body["project_id"] == project_id
    assert body["name"] == created["name"]
    # Пробелы по краям снимаются: в базе не остаётся « gidvantus/workflow ».
    assert body["repo_path"] == "gidvantus/workflow"
    for field in TEXT_FIELDS[1:]:
        assert body[field] is None
    assert body["windows"] == []
    assert body["roles"] == []
    assert body["max_rework"] == 3
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


@pytest.mark.parametrize(
    ("field", "value"),
    [(field, value) for field, value, _max, _detail in TEXT_FIELD_CASES],
    ids=TEXT_FIELDS,
)
def test_patch_writes_each_text_field(
    client: TestClient,
    project_id: int,
    field: str,
    value: str,
) -> None:
    """Каждое из восьми строковых полей страницы записывается своим значением."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={field: value})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()[field] == value


@pytest.mark.parametrize(
    ("field", "value", "max_length", "detail"),
    TEXT_FIELD_CASES,
    ids=TEXT_FIELDS,
)
def test_patch_rejects_too_long_text_field(
    client: TestClient,
    project_id: int,
    field: str,
    value: str,
    max_length: int,
    detail: str,
) -> None:
    """У каждого поля свой предел и свой дословный текст отказа."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={field: "я" * (max_length + 1)})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}
    # Отказ не оставляет половину правки: поле осталось пустым.
    assert client.get(_departments_url(project_id)).json()[0][field] is None


@pytest.mark.parametrize("cleared", ["", None], ids=["empty-string", "null"])
@pytest.mark.parametrize("field", TEXT_FIELDS, ids=TEXT_FIELDS)
def test_patch_clears_text_field(
    client: TestClient,
    project_id: int,
    field: str,
    cleared: str | None,
) -> None:
    """`""` и `null` значат одно и то же — «не заполнено»: значение стирается."""
    created = _create(client, project_id)
    filled = client.patch(_department_url(created["id"]), json={field: "значение"})
    assert filled.status_code == status.HTTP_200_OK

    response = client.patch(_department_url(created["id"]), json={field: cleared})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()[field] is None


def test_patch_max_rework_null_returns_default(client: TestClient, project_id: int) -> None:
    """Пустое поле лимита возвращает умолчание `3`, а не ноль."""
    created = _create(client, project_id)
    filled = client.patch(_department_url(created["id"]), json={"max_rework": 7})
    assert filled.json()["max_rework"] == 7

    response = client.patch(_department_url(created["id"]), json={"max_rework": None})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["max_rework"] == 3


@pytest.mark.parametrize("value", [0, 99])
def test_patch_max_rework_accepts_bounds(
    client: TestClient,
    project_id: int,
    value: int,
) -> None:
    """`0` — «возвращать нельзя», `99` — верхняя граница поля: обе допустимы."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"max_rework": value})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["max_rework"] == value


@pytest.mark.parametrize("value", [-1, 100])
def test_patch_max_rework_rejects_out_of_range(
    client: TestClient,
    project_id: int,
    value: int,
) -> None:
    """За пределами `0..99` — `422` с дословным текстом контракта."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"max_rework": value})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {
        "detail": "Лимит возврата задачи указывается целым числом от 0 до 99"
    }


def test_patch_max_rework_rejects_not_integer(client: TestClient, project_id: int) -> None:
    """`"abc"` в лимите — `422` схемы: это не число, а не «пустое поле»."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"max_rework": "abc"})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_patch_notifications_toggle_keeps_telegram_values(
    client: TestClient,
    project_id: int,
) -> None:
    """Выключение уведомлений не стирает токен и id чата: значения остаются в базе."""
    created = _create(client, project_id)
    enabled = client.patch(
        _department_url(created["id"]),
        json={
            "notifications_enabled": True,
            "telegram_token": TELEGRAM_TOKEN,
            "telegram_chat_id": TELEGRAM_CHAT_ID,
        },
    )

    disabled = client.patch(_department_url(created["id"]), json={"notifications_enabled": False})

    assert enabled.status_code == status.HTTP_200_OK
    assert enabled.json()["notifications_enabled"] is True
    assert disabled.status_code == status.HTTP_200_OK
    assert disabled.json()["notifications_enabled"] is False
    assert disabled.json()["telegram_token"] == TELEGRAM_TOKEN
    assert disabled.json()["telegram_chat_id"] == TELEGRAM_CHAT_ID


def test_patch_notifications_null_does_not_change(
    client: TestClient,
    project_id: int,
) -> None:
    """`null` для флажка — «не менять»: значения «пусто» у флажка нет."""
    created = _create(client, project_id)
    assert (
        client.patch(
            _department_url(created["id"]),
            json={"notifications_enabled": True},
        ).json()["notifications_enabled"]
        is True
    )

    response = client.patch(
        _department_url(created["id"]),
        json={"notifications_enabled": None},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["notifications_enabled"] is True


def test_patch_enabled_toggle_keeps_settings(
    client: TestClient,
    project_id: int,
) -> None:
    """Выключение отдела не стирает ни расписание, ни роли, ни строки, ни бота.

    Флаг работы отдела — «диспетчер его не обслуживает», а не «настроек больше нет»:
    отдел выключается и включается тем же `PATCH`, и всё заполненное остаётся на месте.
    """
    created = _create(client, project_id)
    filled = client.patch(
        _department_url(created["id"]),
        json={
            "repo_path": "gidvantus/workflow",
            "workspace": "D:\\Agents\\Workflow",
            "max_rework": 5,
            "windows": [{"start_time": "13:00", "end_time": "04:00"}],
            "notifications_enabled": True,
            "telegram_token": TELEGRAM_TOKEN,
            "telegram_chat_id": TELEGRAM_CHAT_ID,
        },
    )
    assert filled.status_code == status.HTTP_200_OK, filled.text
    assert filled.json()["enabled"] is True

    disabled = client.patch(_department_url(created["id"]), json={"enabled": False})

    assert disabled.status_code == status.HTTP_200_OK
    body = disabled.json()
    assert body["enabled"] is False
    assert body["repo_path"] == "gidvantus/workflow"
    assert body["workspace"] == "D:\\Agents\\Workflow"
    assert body["max_rework"] == 5
    assert body["windows"] == [{"start_time": "13:00", "end_time": "04:00"}]
    assert body["notifications_enabled"] is True
    assert body["telegram_token"] == TELEGRAM_TOKEN
    assert body["telegram_chat_id"] == TELEGRAM_CHAT_ID
    # Роли выключение не трогает: набор в ответе тот же, что был до правки.
    assert body["roles"] == filled.json()["roles"]

    enabled_again = client.patch(_department_url(created["id"]), json={"enabled": True})

    assert enabled_again.status_code == status.HTTP_200_OK
    assert enabled_again.json()["enabled"] is True


def test_patch_enabled_null_does_not_change(client: TestClient, project_id: int) -> None:
    """`null` для флага работы — «не менять»: значения «пусто» у флажка нет."""
    created = _create(client, project_id)
    assert (
        client.patch(
            _department_url(created["id"]),
            json={"enabled": False},
        ).json()["enabled"]
        is False
    )

    response = client.patch(_department_url(created["id"]), json={"enabled": None})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["enabled"] is False


def test_patch_enabled_rejects_not_boolean(client: TestClient, project_id: int) -> None:
    """`"выключен"` во флаге — `422` схемы: флажок булев, строку он не принимает."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"enabled": "выключен"})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_patch_ignores_sent_project_id(client: TestClient) -> None:
    """Присланный `project_id` не переносит отдел: значение остаётся прежним.

    Переноса отдела между проектами в приложении нет. Тело из одного `project_id` не
    меняет ничего, поэтому отдел возвращается как есть; вместе с настоящим полем правки
    применяется только оно.
    """
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    created = _create(client, first_project)

    only_project = client.patch(
        _department_url(created["id"]),
        json={"project_id": second_project},
    )
    with_repo = client.patch(
        _department_url(created["id"]),
        json={"project_id": second_project, "repo_path": "gidvantus/workflow"},
    )

    assert only_project.status_code == status.HTTP_200_OK
    assert only_project.json()["project_id"] == first_project
    assert only_project.json()["repo_path"] is None
    assert with_repo.status_code == status.HTTP_200_OK
    assert with_repo.json()["project_id"] == first_project
    assert with_repo.json()["repo_path"] == "gidvantus/workflow"
    # Отдел не переехал: в списке второго проекта его нет.
    assert client.get(_departments_url(second_project)).json() == []


def test_patch_does_not_rename(client: TestClient, project_id: int) -> None:
    """Имя отдела не редактируется: оно равно названию вида.

    Тело из одного `name` не меняет ничего и получает отказ пустого тела; вместе с
    настоящим полем правки `name` молча игнорируется, и отдел остаётся «Разработкой».
    """
    created = _create(client, project_id)

    only_name = client.patch(_department_url(created["id"]), json={"name": "Аналитика"})
    with_field = client.patch(
        _department_url(created["id"]),
        json={"name": "Аналитика", "repo_path": "gidvantus/workflow"},
    )

    assert only_name.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert only_name.json() == {"detail": "Нет полей для изменения"}
    assert with_field.status_code == status.HTTP_200_OK
    assert with_field.json()["name"] == "Разработка"


def test_patch_empty_body_is_unprocessable(client: TestClient, project_id: int) -> None:
    """Пустое тело — `422` с дословным текстом контракта."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Нет полей для изменения"}


def test_patch_replaces_roles_entirely(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` с `role_ids` заменяет набор целиком и двигает `updated_at`.

    Строка `departments` при правке одних ролей не меняется, поэтому `updated_at`
    выставляется в ручке явно: без этого «Обновлён» в списке остался бы прежним.
    """
    created = _create(client, project_id)
    _age_row(session_factory, created["id"])

    response = client.patch(_department_url(created["id"]), json={"role_ids": [1, 5, 6]})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert [role["id"] for role in body["roles"]] == [1, 5, 6]
    assert [role["title"] for role in body["roles"]] == [
        "Аналитик",
        "Код-ревьюер",
        "Тестировщик",
    ]
    assert body["project_id"] == project_id
    assert body["name"] == created["name"]
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


def test_patch_repeated_role_ids_collapse(client: TestClient, project_id: int) -> None:
    """Повтор в `role_ids` — не ошибка ввода: набор приходит без повторов."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"role_ids": [6, 2, 6, 2]})

    assert response.status_code == status.HTTP_200_OK
    assert [role["id"] for role in response.json()["roles"]] == [2, 6]


def test_patch_empty_role_list_clears_roles(client: TestClient, project_id: int) -> None:
    """Пустой список ролей допустим и стирает набор: «хотя бы одна роль» больше не нужно."""
    created = _create(client, project_id)
    assert client.patch(
        _department_url(created["id"]),
        json={"role_ids": [2, 6]},
    ).json()["roles"]

    response = client.patch(_department_url(created["id"]), json={"role_ids": []})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["roles"] == []


def test_patch_null_role_ids_clears_roles(client: TestClient, project_id: int) -> None:
    """`null` в `role_ids` — «ничего не выбрано», как и пустой список.

    Фронт отправляет блок ролей массивом, поэтому `null` — edge case контракта, а не
    рабочий путь; трактуется он так же, как пустой набор, иначе отдел нельзя было бы
    очистить одним телом.
    """
    created = _create(client, project_id)
    assert client.patch(
        _department_url(created["id"]),
        json={"role_ids": [2]},
    ).json()["roles"]

    response = client.patch(_department_url(created["id"]), json={"role_ids": None})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["roles"] == []


def test_patch_unknown_role_rejects(client: TestClient, project_id: int) -> None:
    """Неизвестный `id` роли — прежний `422` с прежним текстом."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"role_ids": [999]})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Выбрана роль, которой нет в списке ролей"}


def test_role_can_stand_in_two_departments_of_different_projects(
    client: TestClient,
) -> None:
    """Одна роль стоит в отделах двух проектов: связь многие-ко-многим, не поле."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    first = _create(client, first_project, DEVELOPMENT_KIND_ID)
    second = _create(client, second_project, DEVELOPMENT_KIND_ID)
    assert client.patch(_department_url(first["id"]), json={"role_ids": [6]}).status_code == 200

    response = client.patch(_department_url(second["id"]), json={"role_ids": [6]})

    assert response.status_code == status.HTTP_200_OK
    assert [role["id"] for role in response.json()["roles"]] == [6]


def test_patch_sets_windows(client: TestClient, project_id: int) -> None:
    """Набор окон приходит целиком, порядок задаёт сервер: по возрастанию начала.

    Первое окно идёт через полночь (`04:00` после `13:00`) — это свойство окна, а не
    ошибка; в ответе время ровно `"ЧЧ:ММ"` без секунд.
    """
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows(("13:00", "04:00"), ("07:00", "09:00"))},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["windows"] == [
        {"start_time": "07:00", "end_time": "09:00"},
        {"start_time": "13:00", "end_time": "04:00"},
    ]


def test_patch_replaces_windows_entirely(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Набор заменяется целиком, а не дополняется: старое окно не остаётся в базе.

    Правка другого поля набор не трогает, а правка окна сдвигает `updated_at` — колонка
    «Обновлён» показывает дату правки, хотя в строке менялся только JSON.
    """
    created = _create(client, project_id)
    first = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows(("09:00", "18:00"))},
    )
    assert first.status_code == status.HTTP_200_OK
    _age_row(session_factory, created["id"])

    second = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows(("10:00", "14:00"), ("15:00", "19:00"))},
    )

    assert second.status_code == status.HTTP_200_OK
    assert second.json()["windows"] == [
        {"start_time": "10:00", "end_time": "14:00"},
        {"start_time": "15:00", "end_time": "19:00"},
    ]
    assert datetime.fromisoformat(second.json()["updated_at"]) > PAST
    # Набор пережил круг «правка → база → список»: в строке лежит ровно два окна.
    listed = client.get(_departments_url(project_id)).json()[0]
    assert listed["windows"] == second.json()["windows"]

    untouched = client.patch(
        _department_url(created["id"]),
        json={"repo_path": "gidvantus/workflow"},
    )

    assert untouched.status_code == status.HTTP_200_OK
    assert untouched.json()["windows"] == second.json()["windows"]


@pytest.mark.parametrize("payload", [[], None], ids=["empty-list", "null"])
def test_patch_requires_at_least_one_window(
    client: TestClient,
    project_id: int,
    payload: list[Any] | None,
) -> None:
    """`[]` и `null` одинаково значат «окон нет»: расписание — набор, и пустым он не бывает."""
    created = _create(client, project_id)
    assert (
        client.patch(
            _department_url(created["id"]),
            json={"windows": _windows(("09:00", "18:00"))},
        ).status_code
        == status.HTTP_200_OK
    )

    response = client.patch(_department_url(created["id"]), json={"windows": payload})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Укажите хотя бы одно окно времени работы"}


def test_patch_accepts_six_touching_windows(client: TestClient, project_id: int) -> None:
    """Шесть окон встык — предел задачи: касание концами пересечением не считается."""
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={
            "windows": _windows(
                ("00:00", "04:00"),
                ("04:00", "08:00"),
                ("08:00", "12:00"),
                ("12:00", "16:00"),
                ("16:00", "20:00"),
                ("20:00", "00:00"),
            )
        },
    )

    assert response.status_code == status.HTTP_200_OK
    assert len(response.json()["windows"]) == 6


def test_patch_rejects_seven_windows(client: TestClient, project_id: int) -> None:
    """Седьмое окно — отказ: предел шесть, и он проверяется до пересечений."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={"windows": SEVEN_WINDOWS})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Окон времени работы не может быть больше шести"}


@pytest.mark.parametrize(
    "pairs",
    [
        # второе окно внутри первого
        (("09:00", "18:00"), ("12:00", "14:00")),
        # одинаковые окна — тоже пересечение
        (("13:00", "04:00"), ("13:00", "04:00")),
        # окно через полночь перекрывает второе после полуночи
        (("13:00", "04:00"), ("02:00", "05:00")),
        # окно через полночь перекрывает второе до полуночи
        (("13:00", "04:00"), ("20:00", "22:00")),
        # второе само идёт через полночь и перекрывает первое
        (("06:00", "12:00"), ("20:00", "08:00")),
        # хвост последнего окна накрывает начало первого
        (("00:00", "02:00"), ("23:00", "01:00")),
    ],
    ids=[
        "inside",
        "duplicate",
        "crossing-vs-after-midnight",
        "crossing-vs-before-midnight",
        "crossing-second",
        "tail-vs-first",
    ],
)
def test_patch_rejects_overlapping_windows(
    client: TestClient,
    project_id: int,
    pairs: tuple[tuple[str, str], ...],
) -> None:
    """Пересечение запрещено в любом виде, включая окна через полночь."""
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows(*pairs)},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Окна времени работы пересекаются"}


@pytest.mark.parametrize("value", ["9:00", "25:00", "12:60", "13:00:00", "утро", ""])
def test_patch_rejects_invalid_window_time(
    client: TestClient,
    project_id: int,
    value: str,
) -> None:
    """Кривой формат времени в окне — тот же текст отказа, что и у валидатора."""
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows((value, "04:00"))},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Время работы указывается как ЧЧ:ММ, например 09:00"}


def test_patch_rejects_closed_window(client: TestClient, project_id: int) -> None:
    """Равные начало и конец у окна — отказ с прежним текстом про совпадение."""
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={"windows": _windows(("13:00", "13:00"))},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Начало и конец рабочего времени совпадают"}


def test_patch_windows_do_not_require_old_pair(client: TestClient, project_id: int) -> None:
    """Прежняя пара ушла из контракта: `start_time`/`end_time` в теле больше не поля."""
    created = _create(client, project_id)

    response = client.patch(
        _department_url(created["id"]),
        json={"start_time": "13:00", "end_time": "04:00"},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == "Нет полей для изменения"


def test_patch_unknown_department_not_found(client: TestClient) -> None:
    """Правка несуществующего отдела — `404`."""
    response = client.patch(_department_url(999), json={"repo_path": "gidvantus/workflow"})

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Отдел не найден"}


def test_flat_list_is_gone(client: TestClient) -> None:
    """Плоского списка отделов больше нет: `GET /api/departments` — `404`."""
    response = client.get("/api/departments")

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_flat_create_is_gone(client: TestClient) -> None:
    """Плоского создания тоже нет: отдел создаётся путём проекта."""
    response = client.post("/api/departments", json=DEPARTMENT)

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_orphan_department_is_reachable_by_flat_paths(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Строка без проекта (сирота) не видна в списке, но достаётся плоскими ручками.

    Так ведут себя отделы, заведённые до привязки к проектам: их не удаляют и не
    бэкфиллят, а убрать строку можно только плоским `PATCH`/`DELETE`. Вид у сироты есть:
    миграция `0006` бэкфиллит `kind_id` всем строкам, включая сирот.
    """
    created = _create(client, project_id)
    with session_factory() as session:
        session.execute(
            update(Department).where(Department.id == created["id"]).values(project_id=None)
        )
        session.commit()

    # В списке проекта строки без проекта нет.
    assert client.get(_departments_url(project_id)).json() == []

    response = client.patch(
        _department_url(created["id"]), json={"repo_path": "gidvantus/workflow"}
    )

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["project_id"] is None
    assert body["repo_path"] == "gidvantus/workflow"
    assert body["kind"]["code"] == "development"
    # Имя освобождается в проекте: сирота с ним не конфликтует.
    _create(client, project_id)


def test_orphan_names_are_unique_among_orphans(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Уникальность сирот держит ручка: индекс с `NULL project_id` дубль не ловит.

    `NULL` в уникальном индексе не равен `NULL`, поэтому две живые строки без проекта
    с одинаковым именем индекс пропускает — проверка `_name_is_taken` обязана их видеть.
    """
    created = _create(client, project_id)
    with session_factory() as session:
        session.execute(update(Department).values(project_id=None))
        session.commit()

    with session_factory() as session:
        assert api._name_is_taken(session, None, created["name"]) is True
        assert api._name_is_taken(session, None, "разработка") is True
        assert api._name_is_taken(session, None, "Маркетинг") is False


def test_name_check_ignores_register(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Занятость имени сравнивается без учёта регистра — кириллицей тоже."""
    _create(client, project_id)

    with session_factory() as session:
        assert api._name_is_taken(session, project_id, "разработка") is True
        assert api._name_is_taken(session, project_id, "РАЗРАБОТКА") is True
        assert api._name_is_taken(session, project_id, "Маркетинг") is False


def test_delete_keeps_row_and_role_links(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`204`; из списка проекта отдел исчезает, строка и строки связи остаются."""
    created = _create(client, project_id)
    filled = client.patch(
        _department_url(created["id"]),
        json={"role_ids": [2, 6], "repo_path": "gidvantus/workflow"},
    )
    assert filled.status_code == status.HTTP_200_OK

    response = client.delete(_department_url(created["id"]))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert response.content == b""
    assert client.get(_departments_url(project_id)).json() == []
    rows = _rows(session_factory)
    assert len(rows) == 1
    assert rows[0].id == created["id"]
    assert rows[0].name == created["name"]
    assert rows[0].project_id == project_id
    assert rows[0].deleted_at is not None
    # Мягкое удаление не чистит связь: физического удаления в приложении нет.
    assert _links(session_factory) == [(created["id"], 2), (created["id"], 6)]


def test_repeat_operations_on_deleted_department_are_not_found(
    client: TestClient,
    project_id: int,
) -> None:
    """`PATCH` и повторный `DELETE` по удалённому отделу — `404`, воскрешения нет."""
    created = _create(client, project_id)
    deleted = client.delete(_department_url(created["id"]))
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    patch_response = client.patch(
        _department_url(created["id"]),
        json={"repo_path": "gidvantus/workflow"},
    )
    delete_response = client.delete(_department_url(created["id"]))

    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.json() == {"detail": "Отдел не найден"}
    assert delete_response.status_code == status.HTTP_404_NOT_FOUND
    assert delete_response.json() == {"detail": "Отдел не найден"}


def test_name_of_deleted_department_can_be_used_again(
    client: TestClient,
    project_id: int,
) -> None:
    """Имя удалённого отдела свободно: индекс смотрит только на живые строки."""
    created = _create(client, project_id)
    deleted = client.delete(_department_url(created["id"]))
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    repeated = _create(client, project_id)

    assert repeated["name"] == created["name"]
    assert repeated["id"] != created["id"]


# ---------------------------------------------------------------------------------------
# Публикация реестра правкой отдела (issue #68): каждая правка пишет ревизию в своей же
# транзакции, поэтому документ ревизии обязан совпадать с текущей базой — без `rebuild`.
# ---------------------------------------------------------------------------------------


def _revisions(session_factory: sessionmaker[Session]) -> list[RegistryDocument]:
    """Строки ревизий реестра напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(session.scalars(select(RegistryDocument).order_by(RegistryDocument.revision)))


def test_patch_publishes_registry_revision(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` отдела добавляет ревизию, и её документ — ровно текущая база."""
    created = _create(client, project_id)
    assert [row.revision for row in _revisions(session_factory)] == [1]

    response = client.patch(
        _department_url(created["id"]),
        json={"enabled": False, "repo_path": "gidvantus/workflow"},
    )

    assert response.status_code == status.HTTP_200_OK, response.text
    rows = _revisions(session_factory)
    assert [row.revision for row in rows] == [1, 2]
    assert rows[-1].note == registry_api.NOTE_EDIT
    published = json.loads(rows[-1].body)
    assert published["projects"][0]["departments"][0]["enabled"] is False
    with session_factory() as session:
        assert published == registry_api.build_document(session)


def test_delete_publishes_registry_revision(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`DELETE` отдела публикует документ, в котором отдела уже нет."""
    created = _create(client, project_id)

    response = client.delete(_department_url(created["id"]))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    rows = _revisions(session_factory)
    assert [row.revision for row in rows] == [1, 2]
    assert json.loads(rows[-1].body) == {"version": 2, "agents": [], "projects": []}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("gidvantus/workflow", "gidvantus/workflow"),
        ("  gidvantus/workflow  ", "gidvantus/workflow"),
    ],
)
def test_validate_text_returns_trimmed_value(value: str, expected: str) -> None:
    """Валидатор строкового поля снимает пробелы по краям."""
    assert api.validate_text(value, api.REPO_PATH_MAX_LENGTH, api.REPO_PATH_TOO_LONG) == expected


@pytest.mark.parametrize("value", ["", "   ", None])
def test_validate_text_turns_blank_into_none(value: str | None) -> None:
    """Пустое и пробельное значение — это `NULL`, а не пустая строка в базе."""
    assert api.validate_text(value, api.REPO_PATH_MAX_LENGTH, api.REPO_PATH_TOO_LONG) is None


def test_validate_text_rejects_too_long() -> None:
    """Слишком длинное значение — отказ `422` с текстом своего поля."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_text(
            "я" * (api.BASE_BRANCH_MAX_LENGTH + 1),
            api.BASE_BRANCH_MAX_LENGTH,
            api.BASE_BRANCH_TOO_LONG,
        )
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == "Базовая ветка длиннее 200 символов"


@pytest.mark.parametrize(("value", "expected"), [(None, 3), (0, 0), (3, 3), (99, 99)])
def test_validate_max_rework_accepts(value: int | None, expected: int) -> None:
    """Пустое поле — умолчание `3`; остальные допустимые значения проходят как есть."""
    assert api.validate_max_rework(value) == expected


@pytest.mark.parametrize("value", [-1, 100])
def test_validate_max_rework_rejects(value: int) -> None:
    """За пределами `0..99` — один и тот же текст отказа."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_max_rework(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == "Лимит возврата задачи указывается целым числом от 0 до 99"


@pytest.mark.parametrize("value", ["00:00", "09:00", "13:00", "23:59"])
def test_validate_time_accepts(value: str) -> None:
    """Строго `ЧЧ:ММ`: допустимые значения превращаются во время суток."""
    assert api.validate_time(value).strftime("%H:%M") == value


@pytest.mark.parametrize(
    "value",
    ["9:00", "25:00", "12:60", "13:0", "13:00:00", "", " утро ", "24:00"],
)
def test_validate_time_rejects(value: str) -> None:
    """Кривой формат и выход за границы суток — один и тот же текст отказа."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_time(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == "Время работы указывается как ЧЧ:ММ, например 09:00"


def test_validate_times_allows_midnight_crossing() -> None:
    """`04:00` после `13:00` — это переход через полночь, пара проходит проверку."""
    start, end = api.validate_times("13:00", "04:00")

    assert start.strftime("%H:%M") == "13:00"
    assert end.strftime("%H:%M") == "04:00"


def test_validate_windows_canonicalizes_and_orders() -> None:
    """Валидатор отдаёт `"ЧЧ:ММ"` и сортирует по началу, а не по порядку в теле."""
    windows = api.validate_windows(_windows(("13:00", "04:00"), ("07:00", "09:00")))

    assert windows == [
        {"start_time": "07:00", "end_time": "09:00"},
        {"start_time": "13:00", "end_time": "04:00"},
    ]


@pytest.mark.parametrize(
    ("raw", "detail"),
    [
        ([], api.WINDOWS_REQUIRED),
        (SEVEN_WINDOWS, api.WINDOWS_TOO_MANY),
        (_windows(("09:00", "18:00"), ("10:00", "12:00")), api.WINDOWS_OVERLAP),
        (_windows(("13:00", "04:00"), ("02:00", "05:00")), api.WINDOWS_OVERLAP),
        (_windows(("9:00", "18:00")), api.CLOCK_INVALID),
        (_windows(("09:00", "09:00")), api.CLOCK_EQUAL),
    ],
    ids=["empty", "seven", "overlap", "overlap-crossing", "bad-format", "closed"],
)
def test_validate_windows_rejections(raw: list[dict[str, str]], detail: str) -> None:
    """Каждый отказ валидатора: текст из контракта и код `422`."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_windows(raw)

    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


def test_validate_windows_allows_touching_ends() -> None:
    """`13:00–18:00` и `18:00–21:00` касаются концами, но не пересекаются."""
    windows = api.validate_windows(_windows(("18:00", "21:00"), ("13:00", "18:00")))

    assert windows == [
        {"start_time": "13:00", "end_time": "18:00"},
        {"start_time": "18:00", "end_time": "21:00"},
    ]
