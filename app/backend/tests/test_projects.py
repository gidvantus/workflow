"""Ручки `/api/projects`: коды, дословные тексты отказов и soft delete.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей. Индексы `uq_projects_name_alive` и
`uq_projects_code_alive` живут и в SQLite, поэтому и гонка по имени, и гонка по коду
проверяются на настоящем индексе. База в памяти и клиент живут в `conftest.py` —
один общий движок на все ручки, чтобы не держать копию фикстуры в каждом модуле.
"""

import json
from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.api import projects as api
from app.api import registry as registry_api
from app.models.project import Project
from app.models.registry import RegistryDocument

PROJECT: dict[str, str] = {
    "name": "Workflow",
    "description": "Отдел разработки",
    "repo_url": "gidvantus/workflow",
}


def _create(client: TestClient, **overrides: Any) -> dict[str, Any]:
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
        "code",
        "price_input",
        "price_output",
        "price_cache_read",
        "price_cache_write",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
    assert body["name"] == "Workflow"
    assert body["description"] == "Отдел разработки"
    assert body["repo_url"] == "gidvantus/workflow"
    # Кода нет — `null`, а не пустая строка: «не задан» и «пусто» значат одно и то же.
    assert body["code"] is None
    # Цен нет — четыре нуля строкой с шестью знаками: «не тарифицируется», а не «неизвестно».
    assert body["price_input"] == "0.000000"
    assert body["price_output"] == "0.000000"
    assert body["price_cache_read"] == "0.000000"
    assert body["price_cache_write"] == "0.000000"
    # Итог проекта в ответе проекта не приходит: его единственный источник — журнал.
    assert "total_cost" not in body
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


def test_duplicate_name_is_caught_by_index(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонка двух `POST`: предварительная проверка отключена, `409` держит индекс.

    Так поведение двух одновременных запросов одним именем: оба проходят
    `_name_is_taken`, второй ловит `IntegrityError` частичного индекса
    `uq_projects_name_alive` и получает тот же текст контракта. Тест разом
    проверяет, что индекс привязан к таблице (его создаёт `create_all`) и что
    ветка `except IntegrityError` в `_commit_or_conflict` жива.
    """
    _create(client)
    monkeypatch.setattr(api, "_name_is_taken", lambda *args, **kwargs: False)

    response = client.post("/api/projects", json={**PROJECT, "repo_url": "gidvantus/other"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Проект с таким названием уже есть"}
    assert len(client.get("/api/projects").json()) == 1


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


def test_repo_url_over_500_characters_uses_format_text(client: TestClient) -> None:
    """Ссылка длиннее 500 символов отвечает текстом про формат, а не про длину.

    Набор текстов `422` в контракте закрыт: отдельной формулировки про 500 символов
    в нём нет, поэтому длинная, но валидная ссылка получает форматный отказ. Тест
    фиксирует этот выбор в наборе: если постановщик добавит «Адрес репозитория
    длиннее 500 символов», здесь появится новый текст и отдельная константа.
    """
    long_repo = "https://example.com/" + "a" * (501 - len("https://example.com/"))
    assert len(long_repo) == 501

    response = client.post("/api/projects", json={**PROJECT, "repo_url": long_repo})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {
        "detail": "Адрес репозитория должен быть ссылкой или вида owner/repo"
    }


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


def test_create_with_code_stores_and_returns_it(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """Код сохраняется в базу и возвращается тем же значением."""
    created = _create(client, code="workflow")

    assert created["code"] == "workflow"
    rows = _rows(session_factory)
    assert [(row.id, row.code) for row in rows] == [(created["id"], "workflow")]


def test_create_keeps_code_register_and_trims_spaces(client: TestClient) -> None:
    """Верхний регистр кода разрешён (живой слаг `CRMDormitory`), пробелы по краям снимаются."""
    created = _create(client, code="  CRMDormitory  ")

    assert created["code"] == "CRMDormitory"


@pytest.mark.parametrize("empty", ["", "   "])
def test_create_with_empty_code_means_not_set(client: TestClient, empty: str) -> None:
    """Пустой код — это «не задан»: в базе `NULL`, а не пустая строка."""
    created = _create(client, code=empty)

    assert created["code"] is None


def test_create_with_null_code_means_not_set(client: TestClient) -> None:
    """Явный `null` в теле — то же самое, что отсутствие поля."""
    created = _create(client, code=None)

    assert created["code"] is None


@pytest.mark.parametrize(
    ("code", "detail"),
    [
        ("работа", api.CODE_INVALID),
        ("work flow", api.CODE_INVALID),
        ("work_flow", api.CODE_INVALID),
        ("workflow!", api.CODE_INVALID),
        ("-workflow", api.CODE_INVALID),
        ("a" * (api.CODE_MAX_LENGTH + 1), api.CODE_TOO_LONG),
        ("1" * (api.CODE_MAX_LENGTH + 1), api.CODE_TOO_LONG),
        ("12345", api.CODE_ALL_DIGITS),
    ],
)
def test_create_rejects_invalid_code(client: TestClient, code: str, detail: str) -> None:
    """Каждый отказ по коду — `422` с дословным текстом контракта."""
    response = client.post("/api/projects", json={**PROJECT, "code": code})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


def test_create_accepts_code_of_max_length(client: TestClient) -> None:
    """Ровно 32 символа — ещё не «длиннее 32», код сохраняется."""
    code = "a" * api.CODE_MAX_LENGTH

    created = _create(client, code=code)

    assert created["code"] == code


def test_taken_code_is_conflict_ignoring_register(client: TestClient) -> None:
    """Занятый код — `409`, сравнение без учёта регистра."""
    _create(client, name="CRMDormitory", repo_url="gidvantus/dorm", code="CRMDormitory")

    response = client.post(
        "/api/projects",
        json={**PROJECT, "name": "Другой", "repo_url": "gidvantus/two", "code": "crmdormitory"},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Код проекта уже занят"}


def test_code_of_deleted_project_is_free(client: TestClient) -> None:
    """Код удалённого проекта свободен: индекс смотрит только на живые строки."""
    created = _create(client, code="workflow")
    assert client.delete(f"/api/projects/{created['id']}").status_code == 204

    repeated = _create(client, name="Второй", repo_url="gidvantus/two", code="workflow")

    assert repeated["code"] == "workflow"


def test_code_conflict_is_caught_by_index(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонка двух `POST`: предварительная проверка отключена, `409` держит индекс.

    Оба запроса проходят `_code_is_taken`, второй ловит `IntegrityError` частичного
    индекса `uq_projects_code_alive`. Тест фиксирует, что отказ гонки приходит с текстом
    про код, а не про имя: текст выбирается по имени сработавшего индекса.
    """
    _create(client, name="Первый", repo_url="gidvantus/one", code="workflow")
    monkeypatch.setattr(api, "_code_is_taken", lambda *args, **kwargs: False)

    response = client.post(
        "/api/projects",
        json={**PROJECT, "name": "Второй", "repo_url": "gidvantus/two", "code": "WORKFLOW"},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Код проекта уже занят"}
    assert len(client.get("/api/projects").json()) == 1


def test_patch_sets_code_once(client: TestClient) -> None:
    """Код задаётся один раз: повтор того же кода — `200`, смена и стирание — `422`."""
    created = _create(client)

    first = client.patch(f"/api/projects/{created['id']}", json={"code": "workflow"})
    assert first.status_code == status.HTTP_200_OK, first.text
    assert first.json()["code"] == "workflow"

    same = client.patch(f"/api/projects/{created['id']}", json={"code": "workflow"})
    assert same.status_code == status.HTTP_200_OK, same.text
    assert same.json()["code"] == "workflow"

    for payload in ({"code": "other"}, {"code": ""}, {"code": None}):
        changed = client.patch(f"/api/projects/{created['id']}", json=payload)
        assert changed.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT, changed.text
        assert changed.json() == {"detail": "Код проекта не меняется"}

    assert client.get("/api/projects").json()[0]["code"] == "workflow"


@pytest.mark.parametrize("empty", ["", "   ", None])
def test_patch_empty_code_on_project_without_code_changes_nothing(
    client: TestClient,
    empty: str | None,
) -> None:
    """У проекта без кода пустой `code` в `PATCH` — не отказ и не стирание, а «не задан»."""
    created = _create(client)

    response = client.patch(f"/api/projects/{created['id']}", json={"code": empty})

    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json()["code"] is None


def test_patch_taken_code_is_conflict(client: TestClient) -> None:
    """Занятый код при первой установке — `409` без учёта регистра."""
    _create(client, name="Первый", repo_url="gidvantus/one", code="workflow")
    second = _create(client, name="Второй", repo_url="gidvantus/two")

    response = client.patch(f"/api/projects/{second['id']}", json={"code": "WORKFLOW"})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Код проекта уже занят"}
    assert client.get("/api/projects").json()[1]["code"] is None


@pytest.mark.parametrize(
    ("code", "detail"),
    [
        ("работа", api.CODE_INVALID),
        ("work_flow", api.CODE_INVALID),
        ("12345", api.CODE_ALL_DIGITS),
        ("a" * (api.CODE_MAX_LENGTH + 1), api.CODE_TOO_LONG),
    ],
)
def test_patch_invalid_code_is_unprocessable(
    client: TestClient,
    code: str,
    detail: str,
) -> None:
    """Проверки кода у `PATCH` те же, что у `POST`, и с теми же текстами."""
    created = _create(client)

    response = client.patch(f"/api/projects/{created['id']}", json={"code": code})

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize(
    ("value", "expected"),
    [("workflow", "workflow"), ("  CRMDormitory  ", "CRMDormitory"), ("wrk-2", "wrk-2")],
)
def test_validate_code_returns_trimmed_code(value: str, expected: str) -> None:
    """Валидатор кода доступен без HTTP: он снимает пробелы по краям и хранит регистр."""
    assert api.validate_code(value) == expected


@pytest.mark.parametrize("value", [None, "", "   "])
def test_validate_code_treats_empty_as_not_set(value: str | None) -> None:
    """`None` и пустая строка — одно и то же: кода нет."""
    assert api.validate_code(value) is None


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("работа", api.CODE_INVALID),
        ("-workflow", api.CODE_INVALID),
        ("work_flow", api.CODE_INVALID),
        ("1" * (api.CODE_MAX_LENGTH + 1), api.CODE_TOO_LONG),
        ("12345", api.CODE_ALL_DIGITS),
    ],
)
def test_validate_code_rejects(value: str, detail: str) -> None:
    """Отказы валидатора кода — `422` с дословным текстом контракта."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_code(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


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


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("0.27", "0.270000"),
        ("0,27", "0.270000"),
        ("1", "1.000000"),
        ("0", "0.000000"),
        (" 12.5 ", "12.500000"),
        ("0.123456", "0.123456"),
    ],
)
def test_validate_price_accepts(value: str, expected: str) -> None:
    """Цена — `Decimal` ровно с шестью знаками; запятая и целое число проходят."""
    assert str(api.validate_price(value)) == expected


@pytest.mark.parametrize(
    ("value", "detail"),
    [
        ("", api.PRICE_INVALID),
        ("   ", api.PRICE_INVALID),
        ("дорого", api.PRICE_INVALID),
        ("0.1234567", api.PRICE_INVALID),
        ("1 250", api.PRICE_INVALID),
        ("-0.27", api.PRICE_NEGATIVE),
        ("-0,5", api.PRICE_NEGATIVE),
    ],
)
def test_validate_price_rejects(value: str, detail: str) -> None:
    """Мусор и лишние знаки — текст про формат, минус — отдельный текст про знак."""
    with pytest.raises(HTTPException) as excinfo:
        api.validate_price(value)
    assert excinfo.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert excinfo.value.detail == detail


def test_create_with_prices_returns_them_as_strings(client: TestClient) -> None:
    """Цены можно задать сразу при создании: в ответе они строкой с шестью знаками."""
    body = _create(
        client,
        price_input="0,27",
        price_output="1.1",
        price_cache_read="0",
        price_cache_write="0.07",
    )

    assert body["price_input"] == "0.270000"
    assert body["price_output"] == "1.100000"
    assert body["price_cache_read"] == "0.000000"
    assert body["price_cache_write"] == "0.070000"


def test_patch_sets_each_price(client: TestClient) -> None:
    """`PATCH` правит цены по одной: непереданные поля остаются прежними."""
    project = _create(client)

    response = client.patch(
        f"/api/projects/{project['id']}",
        json={"price_input": "0.27", "price_cache_read": "0,03"},
    )

    assert response.status_code == status.HTTP_200_OK, response.text
    body = response.json()
    assert body["price_input"] == "0.270000"
    assert body["price_output"] == "0.000000"
    assert body["price_cache_read"] == "0.030000"
    assert body["price_cache_write"] == "0.000000"


def test_patch_price_zero_is_allowed(client: TestClient) -> None:
    """Ноль — допустимая цена: «не тарифицируется», а не ошибка. Четыре нуля тоже."""
    project = _create(client, price_input="0.27")

    response = client.patch(f"/api/projects/{project['id']}", json={"price_input": "0"})

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["price_input"] == "0.000000"


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"price_input": "-0.27"}, api.PRICE_NEGATIVE),
        ({"price_output": "дорого"}, api.PRICE_INVALID),
        ({"price_cache_read": "0.1234567"}, api.PRICE_INVALID),
        ({"price_cache_write": ""}, api.PRICE_INVALID),
    ],
)
def test_patch_returns_price_refusal_texts(
    client: TestClient, payload: dict[str, str], detail: str
) -> None:
    """Отказы по цене — `422` с дословным текстом контракта, строка не меняется."""
    project = _create(client, price_input="0.27")

    response = client.patch(f"/api/projects/{project['id']}", json=payload)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["detail"] == detail


def test_patch_does_not_change_total_cost(client: TestClient) -> None:
    """`total_cost` правкой проекта не меняется: поле необъявлено и отбрасывается.

    Один только `total_cost` в теле — пустая правка, остальные поля применяются без него.
    """
    project = _create(client)

    empty = client.patch(f"/api/projects/{project['id']}", json={"total_cost": "999.00"})
    assert empty.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert empty.json()["detail"] == api.NO_FIELDS_TO_UPDATE

    response = client.patch(
        f"/api/projects/{project['id']}",
        json={"name": "Другое имя", "total_cost": "999.00"},
    )
    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["name"] == "Другое имя"
    assert "total_cost" not in body


# ---------------------------------------------------------------------------------------
# Публикация реестра правкой проекта (issue #68): `title` документа — это `name` строки,
# поэтому переименование и удаление проекта обязаны доезжать до диспетчера без `rebuild`.
# ---------------------------------------------------------------------------------------


def _with_department(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Завести проект и отдел разработки ручками: проект без отдела в реестр не попадает."""
    project = _create(client, **overrides)
    response = client.post(f"/api/projects/{project['id']}/departments", json={"kind_id": 1})
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return project


def _published(session_factory: sessionmaker[Session]) -> dict[str, Any]:
    """Документ последней ревизии реестра, разобранный из базы, — в обход ручек."""
    with session_factory() as session:
        rows = list(
            session.scalars(
                select(RegistryDocument).order_by(RegistryDocument.revision.desc()).limit(1)
            )
        )
        if not rows:
            return {}
        document: dict[str, Any] = json.loads(rows[0].body)
        return document


def test_patch_publishes_registry_with_new_title(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Переименование проекта публикует ревизию: `title` в документе — новое имя."""
    project = _with_department(client)
    assert _published(session_factory)["projects"][0]["title"] == project["name"]

    response = client.patch(f"/api/projects/{project['id']}", json={"name": "Workflow 2"})

    assert response.status_code == status.HTTP_200_OK, response.text
    with session_factory() as session:
        revisions = list(
            session.scalars(select(RegistryDocument).order_by(RegistryDocument.revision))
        )
        assert [row.revision for row in revisions] == [1, 2]
        assert revisions[-1].note == registry_api.NOTE_EDIT
        published = json.loads(revisions[-1].body)
        assert published["projects"][0]["title"] == "Workflow 2"
        assert published == registry_api.build_document(session)


def test_delete_removes_project_from_registry_document(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Удаление проекта публикует документ без него; второй проект остаётся."""
    first = _with_department(client)
    second = _with_department(client, name="CloudPass", repo_url="gidvantus/cloudpass")
    assert len(_published(session_factory)["projects"]) == 2

    response = client.delete(f"/api/projects/{first['id']}")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    document = _published(session_factory)
    assert [project["id"] for project in document["projects"]] == [str(second["id"])]
