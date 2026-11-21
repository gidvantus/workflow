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
"""

from collections.abc import Iterator
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
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
