"""Ручки `/api/roles` и `/api/departments`: коды, дословные тексты и soft delete.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей. Миграции здесь не выполняются, поэтому сид ролей
делает фикстура — тем же каталогом `DEFAULT_ROLES`, что и ревизия `0003_departments`:
без сида таблица `roles` пуста и любой `POST` падает на «нет такой роли».
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


def _create(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Создать отдел через ручку и вернуть тело ответа."""
    payload = {**DEPARTMENT, **overrides}
    response = client.post("/api/departments", json=payload)
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


def test_create_returns_created_department(client: TestClient) -> None:
    """`201` и ровно те поля, что обещаны контрактом, время — без секунд."""
    response = client.post("/api/departments", json=DEPARTMENT)

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()
    assert set(body) == {
        "id",
        "name",
        "start_time",
        "end_time",
        "roles",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
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


def test_create_allows_midnight_crossing(client: TestClient) -> None:
    """`end_time` меньше `start_time` — переход через полночь, а не ошибка."""
    created = _create(client, start_time="13:00", end_time="04:00")

    assert created["start_time"] == "13:00"
    assert created["end_time"] == "04:00"
    assert len(client.get("/api/departments").json()) == 1


def test_list_is_empty_on_empty_base(client: TestClient) -> None:
    """Пустая база — пустой массив, а не отказ."""
    response = client.get("/api/departments")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == []


def test_list_returns_alive_departments_ordered_by_id(client: TestClient) -> None:
    """Список — только живые строки, порядок по `id` возрастанию."""
    first = _create(client)
    second = _create(client, name="Аналитика", start_time="09:00", end_time="18:00", role_ids=[1])

    response = client.get("/api/departments")

    assert response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in response.json()] == [first["id"], second["id"]]
    assert [item["name"] for item in response.json()] == ["Разработка", "Аналитика"]


def test_duplicate_name_is_conflict(client: TestClient) -> None:
    """Повтор названия — `409` с дословным текстом контракта."""
    _create(client)

    response = client.post("/api/departments", json={**DEPARTMENT, "role_ids": [1]})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_duplicate_name_ignores_register(client: TestClient) -> None:
    """Занятость названия сравнивается без учёта регистра."""
    _create(client)

    response = client.post("/api/departments", json={**DEPARTMENT, "name": "разработка"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_duplicate_name_is_caught_by_index(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонка двух `POST`: предварительная проверка отключена, `409` держит индекс.

    Так поведение двух одновременных запросов с одним именем: оба проходят
    `_name_is_taken`, второй ловит `IntegrityError` частичного индекса
    `uq_departments_name_alive` и получает тот же текст контракта.
    """
    _create(client)
    monkeypatch.setattr(api, "_name_is_taken", lambda *args, **kwargs: False)

    response = client.post("/api/departments", json={**DEPARTMENT, "role_ids": [1]})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}
    assert len(client.get("/api/departments").json()) == 1


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
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Отказы проверки — `422` с ровно тем текстом, что записан в контракте."""
    response = client.post("/api/departments", json={**DEPARTMENT, **payload})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_repeated_role_ids_collapse(client: TestClient) -> None:
    """Повтор роли в `role_ids` — не ошибка: в ответе роль стоит один раз."""
    created = _create(client, role_ids=[6, 2, 6, 2])

    assert [role["id"] for role in created["roles"]] == [2, 6]


def test_role_can_stand_in_two_departments(client: TestClient) -> None:
    """Одна роль живёт в двух отделах: связь многие-ко-многим, а не владение."""
    first = _create(client, role_ids=[6])
    second = _create(client, name="Поддержка", role_ids=[6])

    listed = {
        item["id"]: [role["id"] for role in item["roles"]]
        for item in client.get("/api/departments").json()
    }

    assert listed[first["id"]] == [6]
    assert listed[second["id"]] == [6]


def test_patch_changes_only_sent_fields(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """`PATCH` меняет название и `updated_at`, не трогая время и роли."""
    created = _create(client)
    # created_at отодвигается в прошлое, чтобы сравнение не зависело от точности часов.
    with session_factory() as session:
        session.execute(
            update(Department)
            .where(Department.id == created["id"])
            .values(created_at=datetime(2000, 1, 1))
        )
        session.commit()

    response = client.patch(f"/api/departments/{created['id']}", json={"name": "Разработка 2"})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["id"] == created["id"]
    assert body["name"] == "Разработка 2"
    assert body["start_time"] == created["start_time"]
    assert body["end_time"] == created["end_time"]
    assert [role["id"] for role in body["roles"]] == [2, 6]
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(body["created_at"])


def test_patch_replaces_roles_entirely(client: TestClient) -> None:
    """`PATCH` с `role_ids` заменяет набор целиком, а не дополняет его."""
    created = _create(client)

    response = client.patch(f"/api/departments/{created['id']}", json={"role_ids": [1, 5, 6]})

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert [role["id"] for role in body["roles"]] == [1, 5, 6]
    assert body["name"] == created["name"]
    assert body["start_time"] == created["start_time"]
    assert body["end_time"] == created["end_time"]


def test_patch_one_time_checks_the_whole_pair(client: TestClient) -> None:
    """Правка только начала проверяет итоговую пару: равные значения — отказ `422`."""
    created = _create(client, start_time="09:00", end_time="18:00")

    response = client.patch(f"/api/departments/{created['id']}", json={"start_time": "18:00"})

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
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Те же тексты `422`, что и на создании: набор отказов один на `POST` и `PATCH`."""
    created = _create(client)

    response = client.patch(f"/api/departments/{created['id']}", json=payload)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_patch_empty_body_is_unprocessable(client: TestClient) -> None:
    """Пустое тело — `422` с дословным текстом контракта."""
    created = _create(client)

    response = client.patch(f"/api/departments/{created['id']}", json={})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Нет полей для изменения"}


def test_patch_taken_name_is_conflict(client: TestClient) -> None:
    """Переименование в занятое имя — `409`."""
    _create(client)
    second = _create(client, name="Аналитика", role_ids=[1])

    response = client.patch(f"/api/departments/{second['id']}", json={"name": "разработка"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Отдел с таким названием уже есть"}


def test_patch_unknown_department_not_found(client: TestClient) -> None:
    """Правка несуществующего отдела — `404`."""
    response = client.patch("/api/departments/999", json={"name": "Кто-то"})

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Отдел не найден"}


def test_delete_keeps_row_and_role_links(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """`204`; из списка отдел исчезает, строка и строки связи остаются в базе."""
    created = _create(client)

    response = client.delete(f"/api/departments/{created['id']}")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert response.content == b""
    assert client.get("/api/departments").json() == []
    rows = _rows(session_factory)
    assert len(rows) == 1
    assert rows[0].id == created["id"]
    assert rows[0].name == created["name"]
    assert rows[0].deleted_at is not None
    # Мягкое удаление не чистит связь: физического удаления в приложении нет.
    assert _links(session_factory) == [(created["id"], 2), (created["id"], 6)]


def test_repeat_operations_on_deleted_department_are_not_found(client: TestClient) -> None:
    """`PATCH` и повторный `DELETE` по удалённому отделу — `404`, воскрешения нет."""
    created = _create(client)
    deleted = client.delete(f"/api/departments/{created['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    patch_response = client.patch(f"/api/departments/{created['id']}", json={"name": "Ещё раз"})
    delete_response = client.delete(f"/api/departments/{created['id']}")

    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.json() == {"detail": "Отдел не найден"}
    assert delete_response.status_code == status.HTTP_404_NOT_FOUND
    assert delete_response.json() == {"detail": "Отдел не найден"}


def test_name_of_deleted_department_can_be_used_again(client: TestClient) -> None:
    """Имя удалённого отдела свободно: индекс смотрит только на живые строки."""
    created = _create(client)
    deleted = client.delete(f"/api/departments/{created['id']}")
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    repeated = _create(client, role_ids=[1])

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
