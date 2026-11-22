"""Ручки `/api/registry`: токен, `404` на пустой таблице, ревизии, `rebuild` и отказы.

Проверяется контракт задачи целиком, потому что тексты отказов читает человек, а
`revision`/`stored_at` — плагин диспетчера: ошибка в любом из них видна не в тестах,
а в остановленной смене. База в памяти и клиент живут в `conftest.py`; здесь —
надстройка над ними: токен реестра приходит из настроек, поэтому `get_settings`
подменяется на время теста.

`rebuild` проверяется на строках, заведённых прямо в базе, а не через ручки отделов:
важны все правила отдачи (незаполненные поля не попадают в документ, окно — парой,
бот — только при включённых уведомлениях и обоих полях), в том числе на состоянии,
которое ручки отделов не создают.

Публикация реестра правкой (issue #68) проверяется здесь же: правка отделов и проектов
пишет ревизию в своей транзакции, поэтому её документ обязан совпадать с базой, а отказы
(`422` формы, `409` занятого номера) — не оставлять ни правки, ни ревизии.
"""

import json
from collections.abc import Iterator
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.api import registry as api
from app.config import Settings, get_settings
from app.models.department import Department
from app.models.department_kind import DepartmentKind
from app.models.project import Project
from app.models.registry import RegistryDocument

TOKEN = "registry-test-token"
HEADERS = {"X-Registry-Token": TOKEN}


def _settings(token: str) -> Settings:
    """Настройки стенда без базы: строка подключения тестам не нужна, но обязательна."""
    return Settings(database_url="sqlite+pysqlite:///:memory:", registry_token=token)


@pytest.fixture(name="api_client")
def api_client_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с заданным токеном реестра в настройках."""
    main.app.dependency_overrides[get_settings] = lambda: _settings(TOKEN)
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


@pytest.fixture(name="tokenless_client")
def tokenless_client_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент стенда, где `REGISTRY_TOKEN` не задан: ручки обязаны отказать всем."""
    main.app.dependency_overrides[get_settings] = lambda: _settings("")
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


def _document(**project: Any) -> dict[str, Any]:
    """Годный документ реестра: один проект с одним отделом разработки.

    `default` и `department` — отдельные ключи удобства: первый становится полем
    документа, второй дополняет отдел разработки.
    """
    default = project.pop("default", None)
    department: dict[str, Any] = {"kind": "development", "repo": "gidvantus/workflow"}
    department.update(project.pop("department", {}))
    project.setdefault("id", "workflow")
    project.setdefault("title", "Workflow")
    project.setdefault("departments", [department])
    document: dict[str, Any] = {"version": 2, "projects": [project]}
    if default is not None:
        document["default"] = default
    return document


def _put(client: TestClient, document: Any) -> Any:
    """Отправить документ на сохранение с токеном."""
    return client.put("/api/registry", json=document, headers=HEADERS)


def _projects(*projects: Any) -> dict[str, Any]:
    """Документ из перечисленных проектов: для отказов уровня документа."""
    return {"version": 2, "projects": list(projects)}


def _with_department(**department: Any) -> dict[str, Any]:
    """Годный документ с дополненными полями отдела разработки."""
    return _document(department=department)


def _windows(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    """Окна работы отдела из пар «начало, конец»."""
    return [{"start": start, "stop": stop} for start, stop in pairs]


# Отдел разработки как он есть в минимальном годном проекте.
DEVELOPMENT: dict[str, str] = {"kind": "development"}

# Документ, у которого пары «начало, конец» на месте: `PUT` его принимает.
GOOD_WINDOW_DOCUMENT: dict[str, Any] = {
    **_with_department(windows=_windows(("13:00", "04:00"))),
    "default": "workflow",
}

# Два проекта с одним `id` — отказ на повторе, независимо от содержимого отделов.
DUPLICATE_ID_DOCUMENT = _projects(
    {"id": "a", "departments": [DEVELOPMENT]},
    {"id": "a", "departments": [DEVELOPMENT]},
)

# Отказы по боту всегда про проект «workflow» — так короче таблица кейсов.
INCOMPLETE_BOT = api.TELEGRAM_INCOMPLETE.format(id="workflow")

# Таблица отказов из контракта: по строке на случай, дословно как в задаче.
INVALID_DOCUMENTS: list[tuple[Any, str]] = [
    ({"version": 1, "projects": []}, api.VERSION_UNSUPPORTED),
    ({"version": "2", "projects": []}, api.VERSION_UNSUPPORTED),
    (["не объект"], api.VERSION_UNSUPPORTED),
    (None, api.VERSION_UNSUPPORTED),
    ({"version": 2}, api.NO_PROJECTS),
    ({"version": 2, "projects": {}}, api.NO_PROJECTS),
    (_projects(), api.NO_PROJECTS),
    # id проекта
    (_projects({"departments": [DEVELOPMENT]}), api.PROJECT_ID_REQUIRED),
    (_projects({"id": "  ", "departments": [DEVELOPMENT]}), api.PROJECT_ID_REQUIRED),
    (_projects({"id": 7, "departments": [DEVELOPMENT]}), api.PROJECT_ID_REQUIRED),
    (DUPLICATE_ID_DOCUMENT, api.PROJECT_ID_DUPLICATE.format(id="a")),
    # отделы проекта
    (_projects({"id": "a"}), api.PROJECT_NO_DEPARTMENTS.format(id="a")),
    (_projects({"id": "a", "departments": []}), api.PROJECT_NO_DEPARTMENTS.format(id="a")),
    (_projects({"id": "a", "departments": {}}), api.PROJECT_NO_DEPARTMENTS.format(id="a")),
    # годных отделов нет: отдел-не-объект и отдел без `kind` потребитель выбрасывает
    (_projects({"id": "a", "departments": [42]}), api.PROJECT_NO_DEPARTMENTS.format(id="a")),
    (
        _projects({"id": "a", "departments": [{"repo": "x"}]}),
        api.PROJECT_NO_DEPARTMENTS.format(id="a"),
    ),
    (
        _projects({"id": "a", "departments": [{"kind": "  "}]}),
        api.PROJECT_NO_DEPARTMENTS.format(id="a"),
    ),
    (
        _projects({"id": "a", "departments": [DEVELOPMENT, DEVELOPMENT]}),
        api.PROJECT_DUPLICATE_DEVELOPMENT.format(id="a"),
    ),
    # расписание
    (_with_department(windows=_windows(("25:00", "04:00"))), api.WINDOW_FORMAT),
    (_with_department(windows=_windows(("12:60", "13:00"))), api.WINDOW_FORMAT),
    (_with_department(windows=_windows(("9:00", "13:00"))), api.WINDOW_FORMAT),
    (_with_department(windows=_windows(("09:00", "9:00"))), api.WINDOW_FORMAT),
    (_with_department(windows=[{"start": "09:00"}]), api.WINDOW_FORMAT),
    (_with_department(windows=[{"stop": "09:00"}]), api.WINDOW_FORMAT),
    (_with_department(windows=[{"start": "", "stop": "13:00"}]), api.WINDOW_FORMAT),
    (_with_department(windows=["09:00-13:00"]), api.WINDOW_FORMAT),
    (_with_department(windows={"start": "09:00", "stop": "13:00"}), api.WINDOW_FORMAT),
    (_with_department(windows=_windows(("13:00", "13:00"))), api.WINDOW_CLOSED),
    # default и бот
    (_document(default="нет-такого"), api.DEFAULT_UNKNOWN.format(id="нет-такого")),
    (_with_department(telegram={"token": "t"}), INCOMPLETE_BOT),
    (_with_department(telegram={"chatId": 1}), INCOMPLETE_BOT),
    (_with_department(telegram={"token": "", "chatId": 1}), INCOMPLETE_BOT),
    (_with_department(telegram={"token": "t", "chatId": ""}), INCOMPLETE_BOT),
]


def _revisions(session_factory: sessionmaker[Session]) -> list[RegistryDocument]:
    """Строки ревизий напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(session.scalars(select(RegistryDocument).order_by(RegistryDocument.revision)))


def _kind_id(session: Session, code: str) -> int:
    """id вида отдела из справочника."""
    kind = session.scalars(select(DepartmentKind).where(DepartmentKind.code == code)).one()
    return kind.id


def _seed_project(
    session_factory: sessionmaker[Session],
    name: str,
    departments: list[dict[str, Any]],
    *,
    deleted: bool = False,
    code: str | None = None,
) -> int:
    """Завести проект и его отделы прямо в базе; вернуть id проекта.

    `code` — слаг проекта: если он задан, `rebuild` поставит его `id` проекта в документе.
    """
    with session_factory() as session:
        project = Project(
            name=name,
            description="",
            repo_url="gidvantus/" + name.lower(),
            code=code,
            deleted_at=datetime(2026, 11, 20, 10, 0, 0) if deleted else None,
        )
        session.add(project)
        session.flush()
        for spec in departments:
            kind_code = spec.pop("kind", "development")
            session.add(
                Department(
                    project_id=project.id,
                    kind_id=_kind_id(session, kind_code),
                    name=spec.pop("name", "Разработка"),
                    **spec,
                )
            )
        session.commit()
        return project.id


def _add_development(
    session_factory: sessionmaker[Session],
    projects: list[tuple[int, str]],
) -> None:
    """Добавить отдел разработки уже заведённым проектам: пары `(id проекта, код)`.

    Нужно тестам, где проект создан ручкой `POST /api/projects`: без отдела `rebuild`
    проект в документ не поставит, а ручки отделов требуют справочника видов.
    """
    with session_factory() as session:
        kind_id = _kind_id(session, "development")
        for project_id, code in projects:
            session.add(
                Department(
                    project_id=project_id,
                    kind_id=kind_id,
                    name="Разработка",
                    repo_path=f"gidvantus/{code}",
                    base_branch="main",
                )
            )
        session.commit()


def test_get_without_token_is_401(api_client: TestClient) -> None:
    """Без заголовка `X-Registry-Token` документ не отдаётся."""
    response = api_client.get("/api/registry")

    assert response.status_code == 401
    assert response.json()["detail"] == api.TOKEN_REJECTED


def test_put_and_rebuild_without_token_are_401(api_client: TestClient) -> None:
    """Сохранение и пересборка закрыты тем же токеном, что и чтение."""
    assert api_client.put("/api/registry", json=_document()).status_code == 401
    assert api_client.post("/api/registry/rebuild").status_code == 401


def test_wrong_token_is_401(api_client: TestClient) -> None:
    """Неверный токен — тот же отказ, что и отсутствующий."""
    response = api_client.get("/api/registry", headers={"X-Registry-Token": "other-token"})

    assert response.status_code == 401
    assert response.json()["detail"] == api.TOKEN_REJECTED


def test_unset_token_rejects_everyone(tokenless_client: TestClient) -> None:
    """Незаданный `REGISTRY_TOKEN` — отказ, а не «пускать всех»."""
    empty = {"X-Registry-Token": ""}

    assert tokenless_client.get("/api/registry").status_code == 401
    assert tokenless_client.get("/api/registry", headers=empty).status_code == 401


def test_get_on_empty_table_is_404(api_client: TestClient) -> None:
    """Ревизий ещё нет — «Реестр ещё не собран»."""
    response = api_client.get("/api/registry", headers=HEADERS)

    assert response.status_code == 404
    assert response.json()["detail"] == api.REGISTRY_NOT_BUILT


def test_put_returns_revision_and_stored_at(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """`200` и ровно пара полей контракта: номер ревизии и время записи."""
    response = _put(api_client, _document())

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"revision", "stored_at"}
    assert body["revision"] == 1
    datetime.fromisoformat(body["stored_at"])
    rows = _revisions(session_factory)
    assert [(row.revision, row.note) for row in rows] == [(1, api.NOTE_PUT)]


def test_get_returns_saved_document_unchanged(api_client: TestClient) -> None:
    """Документ отдаётся как прислан, вместе с ключами, живущими только в файле."""
    document = _document()
    document["default"] = "workflow"
    document["projects"][0]["departments"][0].update(
        {
            "frontendPort": 8095,
            "apiPort": 8096,
            "areas": {"backend": ["tools/"], "frontend": ["app/frontend"]},
            "labels": {"dev": "ready-for-dev"},
            "windows": [{"start": "13:00", "stop": "04:00"}],
        }
    )
    assert _put(api_client, document).status_code == 200

    response = api_client.get("/api/registry", headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == document


def test_revisions_are_append_only_and_get_returns_latest(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Каждый `PUT` добавляет ревизию, прошлые остаются, `GET` отдаёт последнюю."""
    first = _document(id="first")
    second = _document(id="second")
    assert _put(api_client, first).json()["revision"] == 1
    assert _put(api_client, second).json()["revision"] == 2

    assert api_client.get("/api/registry", headers=HEADERS).json()["projects"][0]["id"] == "second"
    rows = _revisions(session_factory)
    assert [row.revision for row in rows] == [1, 2]
    assert '"first"' in rows[0].body


@pytest.mark.parametrize(("document", "detail"), INVALID_DOCUMENTS)
def test_invalid_documents_are_rejected(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
    document: Any,
    detail: str,
) -> None:
    """Каждая строка таблицы отказов: `422` и дословный текст."""
    response = _put(api_client, document)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == detail
    assert _revisions(session_factory) == []


@pytest.mark.parametrize(
    "document",
    [
        GOOD_WINDOW_DOCUMENT,
        _with_department(telegram={"token": "t", "chatId": 0}),
        _with_department(telegram={"token": "t", "chatId": "1"}),
        _with_department(windows=None, telegram=None),
        _projects({"id": "a", "departments": [{"kind": "marketing"}]}),
        # негодные отделы рядом с годным не мешают: потребитель их просто выбрасывает
        _projects({"id": "a", "departments": [DEVELOPMENT, 42, {"repo": "x"}]}),
    ],
)
def test_good_documents_are_stored(api_client: TestClient, document: dict[str, Any]) -> None:
    """Границы допустимого: `chatId: 0`, строка вместо числа, `null`-ключи, только маркетинг."""
    assert _put(api_client, document).status_code == 200


def test_rebuild_builds_document_from_database(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """`rebuild` собирает v2 из `projects`/`departments` по правилам контракта."""
    _seed_project(
        session_factory,
        "Workflow",
        [
            {
                "repo_path": "gidvantus/workflow",
                "base_branch": "main",
                "workspace": "D:\\Agents\\Workflow",
                "human_workspace": "D:\\Development\\VideCoding\\Workflow",
                "artifacts_dir": "D:\\Agents\\workflow-artifacts",
                "compose_project": "workflow-agent",
                "windows": [
                    {"start_time": "13:00", "end_time": "04:00"},
                    {"start_time": "07:00", "end_time": "09:00"},
                ],
                "max_rework": 5,
                "notifications_enabled": True,
                "telegram_token": "bot-token",
                "telegram_chat_id": "294292338",
            }
        ],
    )
    _seed_project(
        session_factory,
        "Brain",
        [
            {"repo_path": "gidvantus/brain", "base_branch": "main", "notifications_enabled": False},
            {"kind": "marketing", "name": "Маркетинг", "repo_path": "gidvantus/brain"},
        ],
    )

    response = api_client.post("/api/registry/rebuild", headers=HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["revision"] == 1
    document = body["document"]
    assert document["version"] == 2
    assert "default" not in document
    first, second = document["projects"]
    # `id` — строка из `projects.id`, `title` — название проекта.
    assert (first["id"], first["title"]) == ("1", "Workflow")
    development = first["departments"][0]
    assert development == {
        "kind": "development",
        "title": "Разработка",
        "repo": "gidvantus/workflow",
        "base": "main",
        "workspace": "D:\\Agents\\Workflow",
        "humanClone": "D:\\Development\\VideCoding\\Workflow",
        "artifacts": "D:\\Agents\\workflow-artifacts",
        "composeProject": "workflow-agent",
        # Все окна отдела попадают в документ v2 и в том же порядке: ключи формы —
        # `start`/`stop`, а не `start_time`/`end_time`.
        "windows": [
            {"start": "13:00", "stop": "04:00"},
            {"start": "07:00", "stop": "09:00"},
        ],
        "maxRework": 5,
        # Флаг работы отдела попадает в документ всегда — даже включённым: отсутствие
        # ключа диспетчер читает как «включён», и опускать его нельзя.
        "enabled": True,
        "telegram": {"token": "bot-token", "chatId": 294292338},
    }
    # Второй проект: уведомления выключены — ключа бота нет; маркетинг в документе есть.
    assert second["departments"] == [
        {
            "kind": "development",
            "title": "Разработка",
            "repo": "gidvantus/brain",
            "base": "main",
            "maxRework": 3,
            "enabled": True,
        },
        {
            "kind": "marketing",
            "title": "Маркетинг",
            "repo": "gidvantus/brain",
            "maxRework": 3,
            "enabled": True,
        },
    ]
    assert api_client.get("/api/registry", headers=HEADERS).json() == document


def test_rebuild_gives_disabled_department_enabled_false(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Выключенный отдел уходит в документ с `enabled: false`, а не без ключа.

    Диспетчер читает `dept.enabled !== false`: опущенный ключ он поймёт как «включён», и
    выключение из веба до работы не доедет.
    """
    _seed_project(
        session_factory,
        "Workflow",
        [{"repo_path": "gidvantus/workflow", "enabled": False}],
    )

    document = api_client.post("/api/registry/rebuild", headers=HEADERS).json()["document"]

    assert document["projects"][0]["departments"][0]["enabled"] is False


def test_stored_document_keeps_non_boolean_enabled(
    api_client: TestClient,
) -> None:
    """`PUT` с небулевым `enabled` принимается и сохраняется как прислан.

    `validate_document` булево не проверяет: значение из базы всегда `bool`, а небулево
    значение в присланном документе диспетчер прочтёт как «включён» — это записанное
    решение, а не недоделка. Проверка здесь держит решение от случайного расширения.
    """
    document = _with_department(enabled="да")

    assert _put(api_client, document).status_code == 200
    assert api_client.get("/api/registry", headers=HEADERS).json() == document


def test_rebuild_bot_requires_both_fields(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Уведомления включены, но одно поле пустое — проект считается «без бота»."""
    _seed_project(
        session_factory,
        "Half",
        [{"notifications_enabled": True, "telegram_token": "bot-token", "telegram_chat_id": " "}],
    )

    document = api_client.post("/api/registry/rebuild", headers=HEADERS).json()["document"]

    assert "telegram" not in document["projects"][0]["departments"][0]


def test_rebuild_skips_project_without_departments(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Проект без отделов в реестр не попадает, а не роняет пересборку."""
    _seed_project(session_factory, "Empty", [])
    _seed_project(session_factory, "Full", [{"repo_path": "gidvantus/full"}])

    response = api_client.post("/api/registry/rebuild", headers=HEADERS)

    assert response.status_code == 200, response.text
    assert [p["title"] for p in response.json()["document"]["projects"]] == ["Full"]


def test_rebuild_skips_deleted_rows(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Мягко удалённый проект в реестр не попадает."""
    _seed_project(session_factory, "Gone", [{"repo_path": "gidvantus/gone"}], deleted=True)
    _seed_project(session_factory, "Alive", [{"repo_path": "gidvantus/alive"}])

    document = api_client.post("/api/registry/rebuild", headers=HEADERS).json()["document"]

    assert [p["title"] for p in document["projects"]] == ["Alive"]


def test_rebuild_without_projects_is_422(api_client: TestClient) -> None:
    """Пустая база — «В реестре нет ни одного проекта», и ревизии не появляется."""
    response = api_client.post("/api/registry/rebuild", headers=HEADERS)

    assert response.status_code == 422
    assert response.json()["detail"] == api.NO_PROJECTS


def test_rebuild_uses_code_as_project_id(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """У проекта с кодом `id` в документе — код, а не число: на этом держится склейка."""
    _seed_project(
        session_factory,
        "Workflow",
        [{"repo_path": "gidvantus/workflow"}],
        code="workflow",
    )

    document = api_client.post("/api/registry/rebuild", headers=HEADERS).json()["document"]

    assert document["projects"][0]["id"] == "workflow"
    assert document["projects"][0]["title"] == "Workflow"


def test_rebuild_keeps_numeric_id_for_project_without_code(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Проект без кода остаётся под `str(id)`: старые документы не ломаются.

    Обратная совместимость важна ровно до заполнения кодов: пока у проекта кода нет,
    `id` в реестре числовой, и это лучше, чем выдуманный код.
    """
    _seed_project(
        session_factory,
        "Workflow",
        [{"repo_path": "gidvantus/workflow"}],
        code="workflow",
    )
    brain_id = _seed_project(
        session_factory,
        "Brain",
        [{"repo_path": "gidvantus/brain"}],
    )

    document = api_client.post("/api/registry/rebuild", headers=HEADERS).json()["document"]

    assert [project["id"] for project in document["projects"]] == ["workflow", str(brain_id)]


def test_rebuild_with_codes_is_accepted_by_put(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Документ с кодами в `id` проходит проверку формы и становится ревизией."""
    _seed_project(
        session_factory,
        "CRMDormitory",
        [{"repo_path": "gidvantus/factory-dormitory-management"}],
        code="CRMDormitory",
    )
    rebuilt = api_client.post("/api/registry/rebuild", headers=HEADERS).json()

    response = _put(api_client, rebuilt["document"])

    assert response.status_code == 200, response.text
    assert (rebuilt["revision"], response.json()["revision"]) == (1, 2)


def test_rebuild_ids_are_the_codes_of_projects_created_by_api(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Приёмочный сценарий задачи: пять живых проектов → `id` реестра ровно эти коды.

    Проекты заводятся ручкой `POST /api/projects`, как их заведёт веб или человек, а
    отдел добавляется прямо в базу: ручки отделов требуют справочника видов и к маршруту
    задачи не относятся. Проверяется весь путь «код прошёл валидацию и записался →
    `rebuild` поставил его `id` проекта» — то есть ровно случай, из-за которого живой
    реестр терял локальные ключи (числовые `id` против слагов в файле), и то, что
    собранный документ потом принимается `PUT`.
    """
    codes = ["vahta", "cloudpass", "brain", "CRMDormitory", "workflow"]
    created: list[tuple[int, str]] = []
    for code in codes:
        response = api_client.post(
            "/api/projects",
            json={"name": code, "repo_url": f"gidvantus/{code}", "code": code},
        )
        assert response.status_code == 201, response.text
        assert response.json()["code"] == code
        created.append((response.json()["id"], code))

    _add_development(session_factory, created)

    rebuilt = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert rebuilt.status_code == 200, rebuilt.text
    document = rebuilt.json()["document"]
    assert [project["id"] for project in document["projects"]] == codes
    assert _put(api_client, document).status_code == 200


def test_rebuild_then_put_creates_next_revision(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Документ `rebuild` принимается `PUT` как есть и становится следующей ревизией."""
    _seed_project(session_factory, "Workflow", [{"repo_path": "gidvantus/workflow"}])
    rebuilt = api_client.post("/api/registry/rebuild", headers=HEADERS).json()

    response = _put(api_client, rebuilt["document"])

    assert response.status_code == 200, response.text
    assert (rebuilt["revision"], response.json()["revision"]) == (1, 2)
    assert api_client.get("/api/registry", headers=HEADERS).json() == rebuilt["document"]


def test_corrupted_body_is_500(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Битый текст ревизии — честный `500` с текстом, а не пустой документ."""
    assert _put(api_client, _document()).status_code == 200
    with session_factory() as session:
        row = session.scalars(select(RegistryDocument)).one()
        row.body = "{ это не json"
        session.commit()

    response = api_client.get("/api/registry", headers=HEADERS)

    assert response.status_code == 500
    assert response.json()["detail"] == api.REGISTRY_CORRUPTED


# ---------------------------------------------------------------------------------------
# Публикация реестра правкой в вебе (issue #68).
#
# Правка отделов и проектов обязана сама добавлять ревизию — в той же транзакции, что и
# саму правку. Иначе диспетчер до следующей пересборки работает по документу, которого в
# базе уже нет: ровно так выключенный в вебе отдел продолжал работать. Здесь проверяется
# весь набор правил публикации: первая ревизия на пустой таблице, видимость правки без
# `rebuild`, отсутствие ревизии у пустой правки, отказ `422` на правку, которую форма
# реестра выразить не может, повтор гонки за номером и подрез истории.
# ---------------------------------------------------------------------------------------


def _create_project(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Завести проект ручкой (как это делает веб) и вернуть тело ответа."""
    body: dict[str, Any] = {"name": "Workflow", "repo_url": "gidvantus/workflow"}
    body.update(overrides)
    response = client.post("/api/projects", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _create_department(client: TestClient, project_id: int) -> dict[str, Any]:
    """Завести отдел разработки ручкой и вернуть тело ответа (id вида — 1, «Разработка»)."""
    response = client.post(f"/api/projects/{project_id}/departments", json={"kind_id": 1})
    assert response.status_code == 201, response.text
    return response.json()


def _published(session_factory: sessionmaker[Session]) -> dict[str, Any]:
    """Документ последней ревизии, разобранный из базы, — в обход ручек."""
    rows = _revisions(session_factory)
    assert rows, "в таблице ревизий нет ни одной строки"
    document: dict[str, Any] = json.loads(rows[-1].body)
    return document


def test_edit_publishes_first_revision(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Пустая таблица: первая ревизия — от правки, а не `404` и не `PUT`.

    Проект без отдела в документ не попадает, поэтому `POST /api/projects` публиковать
    нечего; ревизия 1 появляется на создании отдела, и её документ совпадает с тем, что
    собрала бы пересборка.
    """
    project = _create_project(api_client)
    assert _revisions(session_factory) == []

    department = _create_department(api_client, project["id"])

    rows = _revisions(session_factory)
    assert [row.revision for row in rows] == [1]
    assert rows[0].note == api.NOTE_EDIT
    document = api_client.get("/api/registry", headers=HEADERS).json()
    assert document["projects"] == [
        {
            "id": str(project["id"]),
            "title": project["name"],
            "departments": [
                {
                    "kind": "development",
                    "title": department["name"],
                    "maxRework": department["max_rework"],
                    "enabled": True,
                }
            ],
        }
    ]
    with session_factory() as session:
        assert document == api.build_document(session)


def test_department_patch_is_visible_in_registry(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Приёмочный сценарий: `PATCH {"enabled": false}` виден в `GET` сразу, без `rebuild`."""
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])

    response = api_client.patch(
        f"/api/departments/{department['id']}",
        json={"enabled": False, "repo_path": "gidvantus/workflow"},
    )

    assert response.status_code == 200, response.text
    assert [row.revision for row in _revisions(session_factory)] == [1, 2]
    published = _published(session_factory)["projects"][0]["departments"][0]
    assert published["enabled"] is False
    assert published["repo"] == "gidvantus/workflow"
    # Документ ревизии — ровно текущая база, а не её прошлое состояние.
    with session_factory() as session:
        assert _published(session_factory) == api.build_document(session)


def test_edit_without_changes_adds_no_revision(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Повтор той же правки документ не меняет — номер ревизии не растёт.

    `updated_at` в документ не попадает, поэтому перезапись того же значения не должна
    раздувать историю и заставлять диспетчера перечитывать тот же документ.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    body = {"repo_path": "gidvantus/workflow"}
    url = f"/api/departments/{department['id']}"
    assert api_client.patch(url, json=body).status_code == 200
    revisions = [row.revision for row in _revisions(session_factory)]

    repeated = api_client.patch(url, json=body)

    assert repeated.status_code == 200, repeated.text
    assert [row.revision for row in _revisions(session_factory)] == revisions


def test_roles_edit_adds_no_revision(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Правка только ролей ревизию не поднимает: ролей в документе нет.

    Ручка честно сохраняет набор ролей (`role_ids` в ответе), но документ реестра от
    этого не меняется: `roles` в форму v2 не входят. Публиковать нечего — номер не растёт.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    revisions = [row.revision for row in _revisions(session_factory)]

    response = api_client.patch(f"/api/departments/{department['id']}", json={"role_ids": [1]})

    assert response.status_code == 200, response.text
    assert [role["id"] for role in response.json()["roles"]] == [1]
    assert [row.revision for row in _revisions(session_factory)] == revisions


def test_edit_the_registry_cannot_express_is_rejected(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """`422` дословным текстом формы, и ни правки, ни ревизии не остаётся.

    Два отдела разработки в одном проекте ручки не создают, но такая строка может лежать
    в базе (её завели руками или до появления проверки). Правка, после которой документ
    перестаёт проходить проверку формы, не сохраняется вовсе — иначе база и реестр
    разошлись бы молча.
    """
    project_id = _seed_project(
        session_factory,
        "Twins",
        [{"name": "Разработка"}, {"name": "Разработка 2"}],
    )
    with session_factory() as session:
        department = session.scalars(
            select(Department).where(Department.project_id == project_id).order_by(Department.id)
        ).first()
        assert department is not None
        department_id = department.id

    response = api_client.patch(
        f"/api/departments/{department_id}", json={"repo_path": "gidvantus/workflow"}
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": api.PROJECT_DUPLICATE_DEVELOPMENT.format(id=str(project_id))
    }
    assert _revisions(session_factory) == []
    with session_factory() as session:
        stored = session.get(Department, department_id)
        assert stored is not None
        assert stored.repo_path is None


def test_edit_that_empties_the_registry_publishes_empty_document(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Удаление последнего отдела публикует пустой документ, а не оставляет старый.

    Пустой реестр человек не может прислать через `PUT` (`422` «нет ни одного проекта»),
    но проекция из базы обязана быть честной: иначе диспетчер обслуживал бы удалённый
    отдел до следующей пересборки, которая на пустой базе тоже отказывает.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])

    response = api_client.delete(f"/api/departments/{department['id']}")

    assert response.status_code == 204
    assert _published(session_factory) == {"version": 2, "projects": []}
    assert api_client.get("/api/registry", headers=HEADERS).json() == {
        "version": 2,
        "projects": [],
    }


def test_revision_race_is_retried_without_losing_the_edit(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Занятый номер ревизии не теряет правку: savepoint откатывает только вставку."""
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    real_next_revision = api._next_revision
    calls: list[int] = []

    def flaky_next_revision(session: Session) -> int:
        calls.append(1)
        # Первая попытка получает уже занятый номер — как при одновременной записи.
        return 1 if len(calls) == 1 else real_next_revision(session)

    monkeypatch.setattr(api, "_next_revision", flaky_next_revision)

    response = api_client.patch(f"/api/departments/{department['id']}", json={"enabled": False})

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    assert [row.revision for row in _revisions(session_factory)] == [1, 2]
    assert _published(session_factory)["projects"][0]["departments"][0]["enabled"] is False


def test_exhausted_revision_race_rolls_the_edit_back(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Номер не достался ни за одну попытку — `409`, и правка откатывается целиком.

    Ответ `409` с текстом про одновременную запись — часть контракта; состояние «строка
    изменена, ревизии нет» после него недопустимо.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    attempts: list[int] = []

    def taken_next_revision(session: Session) -> int:
        attempts.append(1)
        return 1

    monkeypatch.setattr(api, "_next_revision", taken_next_revision)

    response = api_client.patch(f"/api/departments/{department['id']}", json={"enabled": False})

    assert response.status_code == 409
    assert response.json() == {"detail": api.REVISION_CONFLICT}
    assert len(attempts) == api.REVISION_ATTEMPTS
    assert [row.revision for row in _revisions(session_factory)] == [1]
    with session_factory() as session:
        stored = session.get(Department, department["id"])
        assert stored is not None
        assert stored.enabled is True


def test_history_is_pruned_to_keep_revisions(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """История держит последние `KEEP_REVISIONS` ревизий; `GET` работает на границе.

    Подрез идёт в той же транзакции, что и публикация: старые ревизии — журнал последних
    состояний, а не документы отката, и последняя ревизия не подрезается никогда.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    edits = api.KEEP_REVISIONS + 5
    for index in range(edits):
        response = api_client.patch(
            f"/api/departments/{department['id']}",
            json={"repo_path": f"gidvantus/repo-{index}"},
        )
        assert response.status_code == 200, response.text

    rows = _revisions(session_factory)

    assert len(rows) == api.KEEP_REVISIONS
    assert rows[-1].revision == edits + 1
    assert rows[0].revision == edits + 1 - api.KEEP_REVISIONS + 1
    document = api_client.get("/api/registry", headers=HEADERS)
    assert document.status_code == 200
    assert document.json()["projects"][0]["departments"][0]["repo"] == (
        f"gidvantus/repo-{edits - 1}"
    )


def test_revision_race_publishes_fresh_document(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Повтор пересобирает документ и перечитывает строки, а не берёт их из identity map.

    Гонка двух вкладок на одном отделе: соседняя выключает отдел `cloudpass`, наша
    меняет ему `repo`. Номер ревизии достаётся соседу, наша первая попытка вставки
    откатывается в savepoint, и повтор обязан опубликовать **его** состояние вместе с
    нашей правкой. Две вещи мешают этому сами по себе:

    - документ, собранный один раз до цикла попыток (замечание Б1);
    - identity map: `select()` вернёт уже загруженный объект с прежними колонками, хотя в
      базе они новые (замечание Б2). Соседнюю правку здесь делает `UPDATE` мимо ORM: в
      базе строка новая, объект в сессии — старый, ровно как после чужого коммита.

    Отдел в этой сессии уже загружен ручкой правки, поэтому объект живой и перечитывать
    его без `expire_all()` некому. Итог без исправления — ревизия, в которой отдел
    включён, хотя в базе он выключен: исходный инцидент из постановки.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    real_next_revision = api._next_revision
    calls: list[int] = []

    def racing_next_revision(session: Session) -> int:
        calls.append(1)
        if len(calls) == 1:
            session.execute(
                text("UPDATE departments SET enabled = :enabled WHERE id = :id"),
                {"enabled": False, "id": department["id"]},
            )
            return real_next_revision(session) - 1
        return real_next_revision(session)

    monkeypatch.setattr(api, "_next_revision", racing_next_revision)

    response = api_client.patch(
        f"/api/departments/{department['id']}", json={"repo_path": "gidvantus/workflow"}
    )

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    assert [row.revision for row in _revisions(session_factory)] == [1, 2]
    with session_factory() as session:
        fresh = api.build_document(session)
    published = _published(session_factory)
    assert published == fresh
    # Чужое изменение и наша правка — обе в опубликованном документе.
    assert published["projects"][0]["departments"][0]["enabled"] is False
    assert published["projects"][0]["departments"][0]["repo"] == "gidvantus/workflow"


def test_rebuild_rereads_rows_and_document_on_retry(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`rebuild` собирает документ на каждой попытке, а не публикует снимок до неё.

    Пересборка, запущенная одновременно с правкой в вебе, не должна публиковать проекцию
    без этой правки: номер занимает сосед, повтор обязан увидеть его изменение в базе.
    """
    project = _create_project(api_client)
    department = _create_department(api_client, project["id"])
    real_next_revision = api._next_revision
    calls: list[int] = []

    def racing_next_revision(session: Session) -> int:
        calls.append(1)
        if len(calls) == 1:
            session.execute(
                text("UPDATE departments SET enabled = :enabled WHERE id = :id"),
                {"enabled": False, "id": department["id"]},
            )
            return real_next_revision(session) - 1
        return real_next_revision(session)

    monkeypatch.setattr(api, "_next_revision", racing_next_revision)

    response = api_client.post("/api/registry/rebuild", headers=HEADERS)

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    assert response.json()["document"]["projects"][0]["departments"][0]["enabled"] is False
    assert _published(session_factory) == response.json()["document"]


def test_rebuild_prunes_history_like_edits(
    api_client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    """Подрез истории общий для всех записей: `rebuild` и `PUT` тоже держат 20 ревизий.

    Иначе «хранятся последние `KEEP_REVISIONS`» было бы верно только для правок из веба,
    а `rebuild` как инструмент наполнения и восстановления рос бы без предела. Текущая
    ревизия при подрезе не удаляется — `GET` продолжает работать на границе.
    """
    project = _create_project(api_client)
    _create_department(api_client, project["id"])
    rebuilds = api.KEEP_REVISIONS + 2
    for _ in range(rebuilds):
        response = api_client.post("/api/registry/rebuild", headers=HEADERS)
        assert response.status_code == 200, response.text

    rows = _revisions(session_factory)
    assert len(rows) == api.KEEP_REVISIONS
    assert rows[-1].revision == rebuilds + 1

    assert _put(api_client, _document()).status_code == 200

    rows = _revisions(session_factory)
    assert len(rows) == api.KEEP_REVISIONS
    assert rows[-1].revision == rebuilds + 2
    assert api_client.get("/api/registry", headers=HEADERS).status_code == 200
