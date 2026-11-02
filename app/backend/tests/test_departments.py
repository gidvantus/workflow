"""Ручки `/api/roles` и отделов проекта: коды, дословные тексты и soft delete.

Отдел живёт внутри проекта, поэтому создание и список ходят вложенным путём
(`/api/projects/{project_id}/departments`), а правка и удаление — плоским
(`/api/departments/{department_id}`).

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей — вместе с частичным уникальным индексом
`uq_departments_project_name_alive`, поэтому гонка по имени проверяется на настоящем
индексе, а не на заглушке. Миграции здесь не выполняются, поэтому сид ролей делает
фикстура — тем же каталогом `DEFAULT_ROLES`, что и ревизия `0003_departments`: без сида
таблица `roles` пуста и любой `POST` падает на «нет такой роли».
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
from app.api import departments as api
from app.db import Base, get_db
from app.models.department import Department, department_roles
from app.models.role import DEFAULT_ROLES, Role

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
DEPARTMENT: dict[str, Any] = {
    "name": "Разработка",
    "start_time": "13:00",
    "end_time": "04:00",
    "role_ids": [2, 6],
}


def _seed_roles(factory: sessionmaker[Session]) -> None:
    """Наполнить справочник так же, как это делает сид миграции."""
    with factory() as session:
        session.add_all([Role(code=code, title=title) for code, title in DEFAULT_ROLES])
        session.commit()


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
    _seed_roles(factory)
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


def _create(client: TestClient, project_id: int, **overrides: Any) -> dict[str, Any]:
    """Создать отдел через ручку и вернуть тело ответа."""
    payload = {**DEPARTMENT, **overrides}
    response = client.post(_departments_url(project_id), json=payload)
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


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
    """`GET /api/roles` — ровно десять ролей в порядке таблицы контракта."""
    response = client.get("/api/roles")

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert len(body) == 10
    assert [item["code"] for item in body] == [code for code, _ in DEFAULT_ROLES]
    assert [item["id"] for item in body] == list(range(1, 11))
    assert body[0] == {"id": 1, "code": "analyst", "title": "Аналитик"}
    assert body[9] == {"id": 10, "code": "jev", "title": "Jev (System One)"}


def test_create_returns_created_department(client: TestClient, project_id: int) -> None:
    """`201` и ровно те поля, что обещаны контрактом, время — без секунд."""
    response = client.post(_departments_url(project_id), json=DEPARTMENT)

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()
    assert set(body) == {
        "id",
        "project_id",
        "name",
        "start_time",
        "end_time",
        "roles",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
    # Проект приходит из пути, а не из тела: форма создания проекта не выбирает.
    assert body["project_id"] == project_id
    assert body["name"] == "Разработка"
    # Именно `13:00`, а не `13:00:00`: `<input type="time">` иначе не подставит значение.
    assert body["start_time"] == "13:00"
    assert body["end_time"] == "04:00"
    assert [role["id"] for role in body["roles"]] == [2, 6]
    assert [role["title"] for role in body["roles"]] == [
        "Разработчик (полный стек)",
        "Тестировщик",
    ]
    assert isinstance(datetime.fromisoformat(body["created_at"]), datetime)
    assert isinstance(datetime.fromisoformat(body["updated_at"]), datetime)


def test_create_allows_midnight_crossing(client: TestClient, project_id: int) -> None:
    """`end_time` меньше `start_time` — переход через полночь, а не ошибка."""
    created = _create(client, project_id, start_time="13:00", end_time="04:00")

    assert created["start_time"] == "13:00"
    assert created["end_time"] == "04:00"
    assert len(client.get(_departments_url(project_id)).json()) == 1


def test_list_is_empty_on_empty_project(client: TestClient, project_id: int) -> None:
    """Пустой проект — пустой массив, а не отказ."""
    response = client.get(_departments_url(project_id))

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == []


def test_list_returns_alive_departments_ordered_by_id(
    client: TestClient,
    project_id: int,
) -> None:
    """Список — только живые строки проекта, порядок по `id` возрастанию."""
    first = _create(client, project_id)
    second = _create(
        client,
        project_id,
        name="Аналитика",
        start_time="09:00",
        end_time="18:00",
        role_ids=[1],
    )

    response = client.get(_departments_url(project_id))

    assert response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in response.json()] == [first["id"], second["id"]]
    assert [item["name"] for item in response.json()] == ["Разработка", "Аналитика"]
    assert [item["project_id"] for item in response.json()] == [project_id, project_id]


def test_list_shows_only_departments_of_this_project(client: TestClient) -> None:
    """Отдел одного проекта не виден в списке другого: изоляция по `project_id`."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    first = _create(client, first_project)
    _create(client, second_project, name="Поддержка", role_ids=[9])

    first_list = client.get(_departments_url(first_project)).json()
    second_list = client.get(_departments_url(second_project)).json()

    assert [item["id"] for item in first_list] == [first["id"]]
    assert [item["name"] for item in first_list] == ["Разработка"]
    assert [item["name"] for item in second_list] == ["Поддержка"]


@pytest.mark.parametrize("method", ["get", "post"])
def test_nested_handlers_check_project_before_body(
    client: TestClient,
    method: str,
) -> None:
    """Живость проекта проверяется раньше проверок полей.

    Тело заведомо негодное по смыслу (пустое название), но валидное по схеме: разбор
    тела и проверку проекта делает FastAPI одинаково для обеих ручек, поэтому на
    несуществующем проекте побеждает `404`, а не `422` о названии.
    """
    url = _departments_url(999999)

    if method == "get":
        response = client.get(url)
    else:
        response = client.post(url, json={**DEPARTMENT, "name": "   "})

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Проект не найден"}


@pytest.mark.parametrize("method", ["get", "post"])
def test_nested_handlers_hide_deleted_project(client: TestClient, method: str) -> None:
    """Удалённый проект — тот же `404`: вложенный путь не находит ни одного отдела."""
    project = _create_project(client)
    deleted = client.delete(f"/api/projects/{project['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT
    url = _departments_url(int(project["id"]))
    response = client.get(url) if method == "get" else client.post(url, json=DEPARTMENT)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Проект не найден"}


def test_duplicate_name_is_conflict(client: TestClient, project_id: int) -> None:
    """Повтор названия в том же проекте — `409` с дословным текстом контракта."""
    _create(client, project_id)

    response = client.post(
        _departments_url(project_id),
        json={**DEPARTMENT, "role_ids": [1]},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_duplicate_name_ignores_register(client: TestClient, project_id: int) -> None:
    """Занятость названия сравнивается без учёта регистра."""
    _create(client, project_id)

    response = client.post(
        _departments_url(project_id),
        json={**DEPARTMENT, "name": "разработка"},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_same_name_is_allowed_in_two_projects(client: TestClient) -> None:
    """Уникальность имени — в пределах проекта: в двух проектах имя не конфликт."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]

    first = _create(client, first_project)
    second = _create(client, second_project)

    assert first["name"] == second["name"] == "Разработка"
    assert first["project_id"] == first_project
    assert second["project_id"] == second_project


def test_duplicate_name_is_caught_by_index(
    client: TestClient,
    project_id: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонка двух `POST`: предварительная проверка отключена, `409` держит индекс.

    Так поведение двух одновременных запросов с одним именем: оба проходят
    `_name_is_taken`, второй ловит `IntegrityError` частичного индекса
    `uq_departments_project_name_alive` и получает тот же текст контракта.
    """
    _create(client, project_id)
    monkeypatch.setattr(api, "_name_is_taken", lambda *args, **kwargs: False)

    response = client.post(
        _departments_url(project_id),
        json={**DEPARTMENT, "role_ids": [1]},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}
    assert len(client.get(_departments_url(project_id)).json()) == 1


def test_index_allows_same_name_in_different_projects(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Тот же индекс пропускает одинаковое имя в разных проектах.

    Предварительная проверка отключена, поэтому решение принимает только индекс: если
    бы он остался глобальным по имени, второй `POST` получил бы `409`.
    """
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    _create(client, first_project)
    monkeypatch.setattr(api, "_name_is_taken", lambda *args, **kwargs: False)

    response = client.post(_departments_url(second_project), json=DEPARTMENT)

    assert response.status_code == status.HTTP_201_CREATED, response.text
    assert response.json()["project_id"] == second_project


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"name": "  "}, "Укажите название отдела"),
        ({"name": "я" * 201}, "Название отдела длиннее 200 символов"),
        ({"start_time": "9:00"}, "Время работы указывается как ЧЧ:ММ, например 09:00"),
        ({"start_time": "25:00"}, "Время работы указывается как ЧЧ:ММ, например 09:00"),
        ({"end_time": "12:60"}, "Время работы указывается как ЧЧ:ММ, например 09:00"),
        ({"start_time": "13:00", "end_time": "13:00"}, "Начало и конец рабочего времени совпадают"),
        ({"role_ids": []}, "Выберите хотя бы одну роль"),
        ({"role_ids": [999]}, "Выбрана роль, которой нет в списке ролей"),
    ],
)
def test_create_rejects_invalid_fields(
    client: TestClient,
    project_id: int,
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Отказы проверки — `422` с ровно тем текстом, что записан в контракте."""
    response = client.post(_departments_url(project_id), json={**DEPARTMENT, **payload})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_repeated_role_ids_collapse(client: TestClient, project_id: int) -> None:
    """Повтор роли в `role_ids` — не ошибка: в ответе роль стоит один раз."""
    created = _create(client, project_id, role_ids=[6, 2, 6, 2])

    assert [role["id"] for role in created["roles"]] == [2, 6]


def test_role_can_stand_in_two_departments_of_different_projects(
    client: TestClient,
) -> None:
    """Одна роль живёт в отделах двух проектов: связь многие-ко-многим, а не владение."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    first = _create(client, first_project, role_ids=[6])
    second = _create(client, second_project, role_ids=[6])

    first_listed = client.get(_departments_url(first_project)).json()
    second_listed = client.get(_departments_url(second_project)).json()

    assert [[role["id"] for role in item["roles"]] for item in first_listed] == [[6]]
    assert [[role["id"] for role in item["roles"]] for item in second_listed] == [[6]]
    assert first["project_id"] != second["project_id"]


def test_patch_changes_only_sent_fields(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` меняет название и `updated_at`, не трогая время, роли и проект."""
    created = _create(client, project_id)
    # created_at отодвигается в прошлое, чтобы сравнение не зависело от точности часов.
    with session_factory() as session:
        session.execute(
            update(Department)
            .where(Department.id == created["id"])
            .values(created_at=datetime(2000, 1, 1))
        )
        session.commit()

    response = client.patch(_department_url(created["id"]), json={"name": "Разработка 2"})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["id"] == created["id"]
    assert body["project_id"] == project_id
    assert body["name"] == "Разработка 2"
    assert body["start_time"] == created["start_time"]
    assert body["end_time"] == created["end_time"]
    assert [role["id"] for role in body["roles"]] == [2, 6]
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


def test_patch_replaces_roles_entirely(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` с `role_ids` заменяет набор целиком, не меняя `project_id`.

    Строка `departments` при правке одних ролей не меняется, поэтому `updated_at`
    выставляется в ручке явно: без этого «Обновлён» в списке остался бы прежним.
    """
    created = _create(client, project_id)
    # created_at отодвигается в прошлое, чтобы сравнение не зависело от точности часов.
    with session_factory() as session:
        session.execute(
            update(Department)
            .where(Department.id == created["id"])
            .values(created_at=datetime(2000, 1, 1))
        )
        session.commit()

    response = client.patch(_department_url(created["id"]), json={"role_ids": [1, 5, 6]})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert [role["id"] for role in body["roles"]] == [1, 5, 6]
    assert body["project_id"] == project_id
    assert body["name"] == created["name"]
    assert body["start_time"] == created["start_time"]
    assert body["end_time"] == created["end_time"]
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


def test_patch_ignores_sent_project_id(client: TestClient) -> None:
    """Присланный `project_id` не переносит отдел: значение остаётся прежним.

    Переноса отдела между проектами в приложении нет. Тело из одного `project_id` не
    меняет ничего, поэтому отдел возвращается как есть; вместе с настоящим полем
    правки применяется только оно.
    """
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    created = _create(client, first_project)

    only_project = client.patch(
        _department_url(created["id"]),
        json={"project_id": second_project},
    )
    with_name = client.patch(
        _department_url(created["id"]),
        json={"project_id": second_project, "name": "Разработка 2"},
    )

    assert only_project.status_code == status.HTTP_200_OK
    assert only_project.json()["project_id"] == first_project
    assert only_project.json()["name"] == "Разработка"
    assert with_name.status_code == status.HTTP_200_OK
    assert with_name.json()["project_id"] == first_project
    assert with_name.json()["name"] == "Разработка 2"
    # Отдел не переехал: в списке второго проекта его нет.
    assert client.get(_departments_url(second_project)).json() == []


def test_patch_one_time_checks_the_whole_pair(client: TestClient, project_id: int) -> None:
    """Правка только начала проверяет итоговую пару: равные значения — отказ `422`."""
    created = _create(client, project_id, start_time="09:00", end_time="18:00")

    response = client.patch(_department_url(created["id"]), json={"start_time": "18:00"})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Начало и конец рабочего времени совпадают"}


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"start_time": "9:00"}, "Время работы указывается как ЧЧ:ММ, например 09:00"),
        ({"role_ids": []}, "Выберите хотя бы одну роль"),
        ({"role_ids": [999]}, "Выбрана роль, которой нет в списке ролей"),
        ({"name": "  "}, "Укажите название отдела"),
    ],
)
def test_patch_rejects_invalid_fields(
    client: TestClient,
    project_id: int,
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Те же тексты `422`, что и на создании: набор отказов один на `POST` и `PATCH`."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json=payload)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_patch_empty_body_is_unprocessable(client: TestClient, project_id: int) -> None:
    """Пустое тело — `422` с дословным текстом контракта."""
    created = _create(client, project_id)

    response = client.patch(_department_url(created["id"]), json={})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Нет полей для изменения"}


def test_patch_taken_name_is_conflict(client: TestClient, project_id: int) -> None:
    """Переименование в занятое имя того же проекта — `409`."""
    _create(client, project_id)
    second = _create(client, project_id, name="Аналитика", role_ids=[1])

    response = client.patch(_department_url(second["id"]), json={"name": "разработка"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_patch_taken_name_in_other_project_is_allowed(client: TestClient) -> None:
    """Имя, занятое в другом проекте, не мешает правке: правило — в пределах проекта."""
    first_project = _create_project(client)["id"]
    second_project = _create_project(client, **SECOND_PROJECT)["id"]
    _create(client, first_project)
    second = _create(client, second_project)

    response = client.patch(_department_url(second["id"]), json={"name": "Разработка"})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["name"] == "Разработка"
    assert response.json()["project_id"] == second_project


def test_patch_unknown_department_not_found(client: TestClient) -> None:
    """Правка несуществующего отдела — `404`."""
    response = client.patch(_department_url(999), json={"name": "Кто-то"})

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
    бэкфиллят, а убрать строку можно только плоским `PATCH`/`DELETE`.
    """
    created = _create(client, project_id)
    with session_factory() as session:
        session.execute(
            update(Department).where(Department.id == created["id"]).values(project_id=None)
        )
        session.commit()

    # В списке проекта строки без проекта нет.
    assert client.get(_departments_url(project_id)).json() == []

    response = client.patch(_department_url(created["id"]), json={"name": "Сирота 2"})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["project_id"] is None
    assert body["name"] == "Сирота 2"
    # Имя освобождается в проекте: сирота с ним не конфликтует.
    _create(client, project_id)


def test_orphan_duplicate_name_is_conflict(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Уникальность сирот держит ручка: индекс с `NULL project_id` дубль не ловит.

    `NULL` в уникальном индексе не равен `NULL`, поэтому две живые строки без проекта
    с одинаковым именем индекс пропустит. Отказ обязан дать `_name_is_taken`.
    """
    first = _create(client, project_id)
    second = _create(client, project_id, name="Аналитика", role_ids=[1])
    with session_factory() as session:
        session.execute(update(Department).values(project_id=None))
        session.commit()

    response = client.patch(_department_url(second["id"]), json={"name": first["name"]})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_delete_keeps_row_and_role_links(
    client: TestClient,
    project_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """`204`; из списка проекта отдел исчезает, строка и строки связи остаются."""
    created = _create(client, project_id)

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

    patch_response = client.patch(_department_url(created["id"]), json={"name": "Ещё раз"})
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

    repeated = _create(client, project_id, role_ids=[1])

    assert repeated["name"] == created["name"]
    assert repeated["id"] != created["id"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("Разработка", "Разработка"), ("  Разработка  ", "Разработка")],
)
def test_validate_name_returns_trimmed_value(value: str, expected: str) -> None:
    """Валидатор имени доступен без HTTP: он снимает пробелы по краям."""
    assert api.validate_name(value) == expected


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("", "Укажите название отдела"),
        ("   ", "Укажите название отдела"),
        ("я" * 201, "Название отдела длиннее 200 символов"),
    ],
)
def test_validate_name_rejects(value: str, detail: str) -> None:
    """Пустое и слишком длинное имя — отказ `422` из валидатора."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_name(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


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
