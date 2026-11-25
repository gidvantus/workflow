"""Процесс отдела: умолчания, документ v2, ручки `GET`/`PUT` и тексты отказов.

Проверяется контракт постановки `#79` целиком, потому что половина его — тексты: экран
«Процесс» показывает `detail` ответа `422` дословно, тестировщик сверяет его по таблице
«Контракт половин», а диспетчер исполняет ровно то, что вернула ручка. Поэтому таблица
ступеней по умолчанию закреплена здесь **литералом** — расхождение Python-копии с
постановкой обязано падать в тесте, а не в конвейере.

Проверки идут в двух слоях. Первый — чистые функции (`default_process`,
`validate_process_document`): они не требуют клиента и дают точный текст отказа. Второй —
ручки на клиенте `conftest.py`: `GET` отдаёт умолчания и справочники, `PUT` пишет колонку,
пересобирает реестр и виден в его документе.
"""

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.api import departments as api
from app.config import Settings, get_settings
from app.models.agent import Agent
from app.models.department import Department
from app.models.role import DEFAULT_ROLES, Role
from app.process_defaults import (
    DEFAULT_LABEL_TITLES,
    DEFAULT_LABELS,
    DEFAULT_STEPS,
    GUARDS,
    LABEL_KEYS,
    PROCESS_VERSION,
    default_process,
)
from app.schemas.process import (
    SHAPE_INVALID,
    STEP_AGENTS_CONFLICT,
    STEP_GUARD_UNKNOWN,
    STEP_ID_DUPLICATE,
    STEP_KIND_UNKNOWN,
    STEP_LABEL_UNKNOWN,
    STEP_NO_WHEN,
    STEP_PRIORITY_INVALID,
    STEP_ROLE_UNKNOWN,
    STEP_ROUTE_GUARD,
    TAG_AGENT_UNKNOWN,
    TAG_NAME_DUPLICATE,
    TAG_NAME_EMPTY,
    TAG_TITLE_EMPTY,
    TAG_UNKNOWN,
    VERSION_UNSUPPORTED,
    ProcessError,
    validate_process_document,
)

TOKEN = "registry-test-token"
HEADERS = {"X-Registry-Token": TOKEN}

PROJECT = {"name": "Workflow", "description": "Отдел разработки", "repo_url": "gidvantus/workflow"}
DEVELOPMENT_KIND_ID = 1

# Роли справочника: ими ограничен `role` ступени. Резолверы конвейера (`by-area`,
# `by-findings`) в справочнике не живут — они правила выбора, а не роли.
ROLE_CODES = [code for code, _ in DEFAULT_ROLES]

# Живые агенты для проверки тегов: диспетчер, два гостя и выключенный агент.
AGENT_CODES = ["dsh", "opencode", "verify-ci", "off"]
# Владельцем ступени может быть только включённый гость; `dsh` и `off` им не считаются.
OWNER_AGENT_CODES = ["opencode", "verify-ci"]

# Таблица ступеней по умолчанию — **литерал из постановки** `#67`: id, приоритет, вид,
# роль, входящие теги, «кроме», ставит, снимает, страж. Порядок строк — порядок
# конвейера; приоритет растёт на 60 (1, 61, … 721), оставляя место для вставки.
DEFAULT_TABLE: list[
    tuple[
        str,
        int,
        str,
        str | None,
        tuple[str, ...],
        tuple[str, ...],
        tuple[str, ...],
        tuple[str, ...],
        str | None,
    ]
] = [
    (
        "mockup",
        1,
        "session",
        "design",
        ("mockup",),
        ("mockupsReady",),
        ("progress",),
        (),
        "mockup-stage",
    ),
    (
        "route",
        61,
        "route",
        None,
        ("dev",),
        (
            "progress",
            "review",
            "test",
            "ok",
            "failed",
            "areaBackend",
            "areaFrontend",
            "areaFullstack",
        ),
        (),
        (),
        "route",
    ),
    (
        "handoff-frontend",
        121,
        "auto",
        None,
        ("test", "areaFullstack"),
        ("phaseFrontend",),
        ("frontend",),
        ("test",),
        None,
    ),
    ("review", 181, "session", "code-review", ("review",), (), (), (), "no-code"),
    ("test", 241, "session", "tester", ("test",), (), (), (), None),
    ("merge", 301, "session", "devops-delivery", ("ok",), (), (), (), "merged-already"),
    (
        "rework-test",
        361,
        "session",
        "by-findings",
        ("failed",),
        (),
        ("progress",),
        ("failed",),
        "dispatch",
    ),
    (
        "dev-backend",
        421,
        "session",
        "dev-backend",
        ("dev", "areaBackend"),
        ("progress", "review", "test", "ok", "failed"),
        ("progress",),
        ("dev",),
        "dispatch",
    ),
    (
        "dev-frontend",
        481,
        "session",
        "dev-frontend",
        ("dev", "areaFrontend"),
        ("progress", "review", "test", "ok", "failed"),
        ("progress",),
        ("dev",),
        "dispatch",
    ),
    (
        "dev-fullstack-backend",
        541,
        "session",
        "dev-backend",
        ("dev", "areaFullstack"),
        ("progress", "review", "test", "ok", "failed"),
        ("progress",),
        ("dev",),
        "dispatch",
    ),
    (
        "dev-fullstack-frontend",
        601,
        "session",
        "dev-frontend",
        ("frontend",),
        ("progress", "review", "test", "ok", "failed"),
        ("progress", "phaseFrontend"),
        ("frontend",),
        "dispatch",
    ),
    (
        "dev-fullstack-default",
        661,
        "session",
        "dev-fullstack",
        ("dev",),
        ("progress", "review", "test", "ok", "failed"),
        ("progress",),
        ("dev",),
        "dispatch",
    ),
    ("continue", 721, "session", "by-area", ("progress",), (), (), (), "dispatch"),
]


@pytest.fixture(name="project_id")
def project_id_fixture(client: TestClient) -> int:
    """Живой проект: отдел заводится только внутри проекта."""
    response = client.post("/api/projects", json=PROJECT)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


@pytest.fixture(name="department_id")
def department_id_fixture(client: TestClient, project_id: int) -> int:
    """Отдел разработки: у него есть умолчания процесса и он виден в реестре."""
    response = client.post(
        f"/api/projects/{project_id}/departments",
        json={"kind_id": DEVELOPMENT_KIND_ID},
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


@pytest.fixture(name="api_client")
def api_client_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с заданным токеном реестра: документ реестра читается только с ним."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite+pysqlite:///:memory:",
        registry_token=TOKEN,
    )
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


@pytest.fixture(name="open_code_agent")
def open_code_agent_fixture(
    session_factory: sessionmaker[Session],
) -> Iterator[None]:
    """Живой агент `opencode` в справочнике: тег может на него сослаться."""
    with session_factory() as session:
        session.add(Agent(code="opencode", title="OpenCode", runtime="opencode"))
        session.commit()
    yield


def _process_url(department_id: int) -> str:
    return f"/api/departments/{department_id}/process"


def _document(**overrides: Any) -> dict[str, Any]:
    """Документ из умолчаний с точечными правками: тело `PUT` в тестах."""
    document = default_process()
    document.update(overrides)
    return document


def _first_step(document: dict[str, Any]) -> dict[str, Any]:
    return document["steps"][0]


def _tag(document: dict[str, Any], key: str) -> dict[str, Any]:
    return next(tag for tag in document["tags"] if tag["key"] == key)


def _rebuild(api_client: TestClient) -> None:
    """Пересобрать реестр из базы: до первой ревизии `GET /api/registry` отвечает `404`."""
    response = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert response.status_code == 200, response.text


def _registry_department(api_client: TestClient, department_id: int) -> dict[str, Any]:
    """Отдел из документа последней ревизии реестра: так его видит диспетчер."""
    response = api_client.get("/api/registry", headers=HEADERS)
    assert response.status_code == 200, response.text
    departments = [
        row for project in response.json()["projects"] for row in project.get("departments", [])
    ]
    for row in departments:
        if row.get("title") == "Разработка":
            return dict(row)
    raise AssertionError(f"в реестре нет отдела разработки (искали id {department_id})")


# --- умолчания -------------------------------------------------------------


def test_default_table_is_the_reference_table() -> None:
    """13 ступеней ровно из постановки: id, приоритет, теги, роли, стражи."""
    actual = [
        (
            step["id"],
            step["priority"],
            step["kind"],
            step["role"],
            tuple(step["when"]),
            tuple(step["unless"]),
            tuple(step["put"]),
            tuple(step["drop"]),
            step["guard"],
        )
        for step in default_process()["steps"]
    ]
    assert actual == DEFAULT_TABLE


def test_default_priorities_leave_room_between_steps() -> None:
    """Шаг 60 между ступенями: вставить новую можно между любыми двумя."""
    priorities = [step["priority"] for step in DEFAULT_STEPS]
    assert priorities == list(range(1, 1 + 60 * len(priorities), 60))


def test_default_tags_cover_every_key_in_contract_order() -> None:
    """Теги: 14 ключей, порядок контракта, имя и подпись прежние, агента нет."""
    document = default_process()
    assert [tag["key"] for tag in document["tags"]] == list(LABEL_KEYS)
    assert {tag["key"]: tag["name"] for tag in document["tags"]} == DEFAULT_LABELS
    assert {tag["key"]: tag["title"] for tag in document["tags"]} == DEFAULT_LABEL_TITLES
    assert {tag["agent"] for tag in document["tags"]} == {None}
    assert list(document) == ["version", "tags", "steps"]
    assert document["version"] == PROCESS_VERSION


def test_guards_catalogue_is_fixed() -> None:
    """Каталог стражей — код, а не данные: семь id с заголовками по-русски."""
    assert [guard_id for guard_id, _ in GUARDS] == [
        "route",
        "mockup-stage",
        "dispatch",
        "no-code",
        "same-head",
        "checklist-gate",
        "merged-already",
    ]
    assert [title for _, title in GUARDS] == [
        "Маршрут",
        "Макет",
        "Выдача",
        "Есть что ревьюить",
        "Та же ревизия",
        "Чеклист прошлого круга",
        "PR уже слит",
    ]


def test_defaults_pass_their_own_validation_unchanged() -> None:
    """Документ по умолчанию — уже канонический: проверка не двигает и не теряет ключей."""
    document = default_process()
    assert validate_process_document(document, ROLE_CODES, AGENT_CODES, OWNER_AGENT_CODES) == document


def test_defaults_do_not_leak_between_calls() -> None:
    """`default_process()` отдаёт копию: правка ответа не меняет образец."""
    first = default_process()
    _first_step(first)["put"].append("test")
    _tag(first, "test")["name"] = "чужое-имя"
    assert _first_step(default_process())["put"] == ["progress"]
    assert _tag(default_process(), "test")["name"] == "ready-for-test"


# --- GET -------------------------------------------------------------------


def test_get_returns_defaults_roles_and_guards(client: TestClient, department_id: int) -> None:
    """Своего процесса нет — `document: null`, умолчания и оба справочника на месте."""
    response = client.get(_process_url(department_id))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["document"] is None
    assert body["defaults"] == default_process()
    assert body["roles"] == ROLE_CODES
    assert body["guards"] == [{"id": guard_id, "title": title} for guard_id, title in GUARDS]


def test_get_returns_saved_document(client: TestClient, department_id: int) -> None:
    """Сохранённый документ возвращается как сохранён, а не пересобранным."""
    document = _document()
    _tag(document, "test")["name"] = "qa-ready"
    assert client.put(_process_url(department_id), json=document).status_code == 200

    response = client.get(_process_url(department_id))
    assert response.status_code == 200, response.text
    assert response.json()["document"] == document


def test_get_returns_v1_document_as_is(
    client: TestClient,
    department_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Стенд с процессом версии 1 получает документ как лежит: конвертирует фронт."""
    v1 = {
        "version": 1,
        "labels": dict(DEFAULT_LABELS),
        "steps": default_process()["steps"],
    }
    with session_factory() as session:
        department = session.get(Department, department_id)
        assert department is not None
        department.process = v1
        session.commit()

    response = client.get(_process_url(department_id))
    assert response.status_code == 200, response.text
    assert response.json()["document"] == v1


def test_put_rejects_v1_document(client: TestClient, department_id: int) -> None:
    """Сохранение принимает только v2: старый документ обязан пройти через фронт."""
    v1 = {
        "version": 1,
        "labels": dict(DEFAULT_LABELS),
        "steps": default_process()["steps"],
    }
    response = client.put(_process_url(department_id), json=v1)
    assert response.status_code == 422
    assert response.json()["detail"] == VERSION_UNSUPPORTED


def test_get_hides_deleted_role_from_roles(
    client: TestClient,
    department_id: int,
    session_factory: sessionmaker[Session],
) -> None:
    """Мягко удалённая роль в справочник не попадает: сессию по ней не поднять."""
    with session_factory() as session:
        session.add(Role(code="ghost", title="Призрак", deleted_at=datetime.now(UTC)))
        session.commit()

    roles = client.get(_process_url(department_id)).json()["roles"]
    assert "ghost" not in roles


def test_get_reports_missing_department(client: TestClient) -> None:
    """Отдела нет — `404` с общим текстом, а не пустой процесс."""
    response = client.get(_process_url(999))
    assert response.status_code == 404
    assert response.json()["detail"] == api.DEPARTMENT_NOT_FOUND


def test_get_hides_deleted_department(client: TestClient, department_id: int) -> None:
    """Удалённый отдел процесса не отдаёт: воскрешения через процесс не бывает."""
    assert client.delete(f"/api/departments/{department_id}").status_code == 204
    assert client.get(_process_url(department_id)).status_code == 404


# --- PUT: сохранение -------------------------------------------------------


def test_put_saves_document_and_returns_revision(client: TestClient, department_id: int) -> None:
    """`PUT` возвращает номер ревизии реестра и сохранённый документ."""
    response = client.put(_process_url(department_id), json=default_process())
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body["revision"], int)
    assert body["revision"] > 0
    assert body["document"] == default_process()


def test_put_process_publishes_registry_revision(client: TestClient, department_id: int) -> None:
    """Сохранение процесса публикует реестр; повтор того же документа ревизии не даёт."""
    first = client.put(_process_url(department_id), json=default_process()).json()["revision"]
    repeat = client.put(_process_url(department_id), json=default_process()).json()["revision"]
    assert repeat == first

    changed = default_process()
    _tag(changed, "test")["name"] = "qa-ready"
    renamed = client.put(_process_url(department_id), json=changed).json()["revision"]
    assert renamed > first


def test_put_renames_tag_and_registry_shows_it(
    api_client: TestClient,
    department_id: int,
) -> None:
    """Переименование тега доезжает до документа реестра: это и есть путь до диспетчера."""
    _rebuild(api_client)
    before = _registry_department(api_client, department_id)
    assert before["process"] is None

    document = default_process()
    _tag(document, "test")["name"] = "qa-ready"
    response = api_client.put(_process_url(department_id), json=document)
    assert response.status_code == 200, response.text

    after = _registry_department(api_client, department_id)
    assert after["process"] == document
    assert _tag(after["process"], "test")["name"] == "qa-ready"


def test_put_without_saved_process_sends_null_to_registry(
    api_client: TestClient,
    department_id: int,
) -> None:
    """Ключ `process` есть всегда, а «своего процесса нет» — это `null`."""
    _rebuild(api_client)
    department = _registry_department(api_client, department_id)
    assert "process" in department
    assert department["process"] is None


def test_put_normalizes_document(client: TestClient, department_id: int) -> None:
    """Канон: лишние ключи ступени и тега отброшены, `enabled` по умолчанию, строки обрезаны."""
    document = default_process()
    for step in document["steps"]:
        step.pop("enabled")
    _first_step(document)["лишний"] = "мусор"
    _tag(document, "dev")["name"] = "  ready-for-dev  "
    _tag(document, "dev")["лишний"] = "мусор"

    body = client.put(_process_url(department_id), json=document).json()
    saved = body["document"]
    assert "лишний" not in _first_step(saved)
    assert _first_step(saved)["enabled"] is True
    assert _tag(saved, "dev")["name"] == "ready-for-dev"
    assert set(_tag(saved, "dev")) == {"key", "name", "title", "agent"}
    assert set(_first_step(saved)) == {
        "id",
        "title",
        "kind",
        "role",
        "when",
        "unless",
        "put",
        "drop",
        "guard",
        "priority",
        "enabled",
    }


def test_put_keeps_order_of_steps_as_sent(client: TestClient, department_id: int) -> None:
    """Порядок строк — присланный: исполнение задаёт `priority`, а не место в массиве."""
    document = default_process()
    document["steps"] = list(reversed(document["steps"]))
    saved = client.put(_process_url(department_id), json=document).json()["document"]
    assert [step["id"] for step in saved["steps"]] == [
        step["id"] for step in reversed(default_process()["steps"])
    ]


def test_put_rejects_invalid_document_and_keeps_previous_one(
    client: TestClient,
    department_id: int,
) -> None:
    """Отказ не трогает сохранённое: битый документ процессом не становится."""
    document = default_process()
    assert client.put(_process_url(department_id), json=document).status_code == 200

    broken = default_process()
    broken["steps"][0]["when"] = []
    response = client.put(_process_url(department_id), json=broken)
    assert response.status_code == 422
    assert client.get(_process_url(department_id)).json()["document"] == document


def test_put_accepts_roles_resolvers(client: TestClient, department_id: int) -> None:
    """`by-area` и `by-findings` — правила выбора, а не роли справочника."""
    document = default_process()
    assert {step["role"] for step in document["steps"]} >= {"by-area", "by-findings"}
    assert client.put(_process_url(department_id), json=document).status_code == 200


def test_put_accepts_live_agent_on_tag(
    client: TestClient,
    department_id: int,
    open_code_agent: None,
) -> None:
    """Тег с кодом живого агента сохраняется и возвращается документом."""
    document = default_process()
    _tag(document, "review")["agent"] = "opencode"
    response = client.put(_process_url(department_id), json=document)
    assert response.status_code == 200, response.text
    assert _tag(response.json()["document"], "review")["agent"] == "opencode"


def test_put_accepts_step_with_disabled_agent_tag(
    client: TestClient,
    department_id: int,
) -> None:
    """Выключенный агент остаётся допустимым кодом тега, но не владеет ступенью."""
    for code, enabled in (("opencode", True), ("verify-ci", False)):
        created = client.post(
            "/api/agents", json={"code": code, "title": code, "enabled": enabled}
        )
        assert created.status_code == 201, created.text
    document = default_process()
    _tag(document, "review")["agent"] = "opencode"
    _tag(document, "test")["agent"] = "verify-ci"
    document["steps"][3]["when"] = ["review", "test"]
    response = client.put(_process_url(department_id), json=document)
    assert response.status_code == 200, response.text
    assert response.json()["document"]["steps"][3]["when"] == ["review", "test"]


def test_put_hides_deleted_department(client: TestClient, department_id: int) -> None:
    """В удалённый отдел процесс не записать."""
    assert client.delete(f"/api/departments/{department_id}").status_code == 204
    assert client.put(_process_url(department_id), json=default_process()).status_code == 404


# --- PUT: таблица отказов --------------------------------------------------


def _rejects(document: Any) -> str:
    """Текст отказа на документе: `ProcessError` из чистой проверки."""
    with pytest.raises(ProcessError) as caught:
        validate_process_document(document, ROLE_CODES, AGENT_CODES, OWNER_AGENT_CODES)
    return str(caught.value)


def test_rejects_unknown_version() -> None:
    assert _rejects(_document(version=1)) == VERSION_UNSUPPORTED
    assert _rejects(_document(version="2")) == VERSION_UNSUPPORTED
    # `True == 1` в Python: флаг версией не считается.
    assert _rejects(_document(version=True)) == VERSION_UNSUPPORTED


@pytest.mark.parametrize(
    "value",
    [None, "process", 42, [], {"version": 2, "steps": []}, {"version": 2, "tags": []}],
    ids=["null", "text", "number", "array", "no-tags", "no-steps"],
)
def test_rejects_wrong_shape(value: Any) -> None:
    assert _rejects(value) == SHAPE_INVALID


def test_rejects_unknown_tag_key() -> None:
    document = default_process()
    document["tags"].append({"key": "какая-то", "name": "метка", "title": "Метка", "agent": None})
    assert _rejects(document) == TAG_UNKNOWN.format(key="какая-то")


def test_rejects_missing_tag_key() -> None:
    document = default_process()
    document["tags"].pop()
    assert _rejects(document) == SHAPE_INVALID


@pytest.mark.parametrize("name", ["", "   ", None], ids=["empty", "spaces", "null"])
def test_rejects_empty_tag_name(name: Any) -> None:
    document = default_process()
    _tag(document, "merged")["name"] = name
    assert _rejects(document) == TAG_NAME_EMPTY.format(key="merged")


def test_rejects_duplicate_tag_name() -> None:
    document = default_process()
    _tag(document, "merged")["name"] = "ready-for-test"
    assert _rejects(document) == TAG_NAME_DUPLICATE.format(name="ready-for-test")


@pytest.mark.parametrize("title", ["", "   ", None], ids=["empty", "spaces", "null"])
def test_rejects_empty_tag_title(title: Any) -> None:
    document = default_process()
    _tag(document, "merged")["title"] = title
    assert _rejects(document) == TAG_TITLE_EMPTY.format(key="merged")


def test_rejects_unknown_tag_agent() -> None:
    document = default_process()
    _tag(document, "review")["agent"] = "нет-такого"
    assert _rejects(document) == TAG_AGENT_UNKNOWN.format(code="нет-такого")


def test_rejects_step_without_incoming_tags() -> None:
    document = default_process()
    _first_step(document)["when"] = []
    assert _rejects(document) == STEP_NO_WHEN.format(id="mockup")


def test_rejects_duplicate_step_id() -> None:
    document = default_process()
    document["steps"][1]["id"] = "mockup"
    assert _rejects(document) == STEP_ID_DUPLICATE.format(id="mockup")


def test_rejects_unknown_tag_key_in_step() -> None:
    document = default_process()
    _first_step(document)["put"] = ["какая-то"]
    assert _rejects(document) == STEP_LABEL_UNKNOWN.format(id="mockup", key="какая-то")


def test_rejects_unknown_kind() -> None:
    document = default_process()
    _first_step(document)["kind"] = "магия"
    assert _rejects(document) == STEP_KIND_UNKNOWN.format(id="mockup", kind="магия")


def test_rejects_unknown_role() -> None:
    document = default_process()
    _first_step(document)["role"] = "нет-такой"
    assert _rejects(document) == STEP_ROLE_UNKNOWN.format(id="mockup", role="нет-такой")


def test_rejects_deleted_role() -> None:
    """Роль, которой нет в живом справочнике, документом не принимается."""
    document = default_process()
    _first_step(document)["role"] = "ghost"
    assert _rejects(document) == STEP_ROLE_UNKNOWN.format(id="mockup", role="ghost")


def test_rejects_unknown_guard() -> None:
    document = default_process()
    _first_step(document)["guard"] = "свой-страж"
    assert _rejects(document) == STEP_GUARD_UNKNOWN.format(id="mockup", guard="свой-страж")


@pytest.mark.parametrize(
    "priority",
    [0, -1, 1000, 61.5, "61", None, True],
    ids=["zero", "negative", "too-big", "float", "text", "null", "bool"],
)
def test_rejects_bad_priority(priority: Any) -> None:
    document = default_process()
    _first_step(document)["priority"] = priority
    assert _rejects(document) == STEP_PRIORITY_INVALID.format(id="mockup")


def test_rejects_route_step_without_route_guard() -> None:
    document = default_process()
    route = document["steps"][1]
    route["guard"] = "dispatch"
    assert _rejects(document) == STEP_ROUTE_GUARD.format(id="route")


@pytest.mark.parametrize("other_agent", [None, "dsh", "off"], ids=["no-agent", "dsh", "disabled"])
def test_accepts_step_with_at_most_one_guest_owner(other_agent: str | None) -> None:
    """Диспетчер, пустой тег и выключенный агент не создают конфликт с гостем."""
    document = default_process()
    _tag(document, "review")["agent"] = "opencode"
    _tag(document, "test")["agent"] = other_agent
    document["steps"][3]["when"] = ["review", "test"]
    saved = validate_process_document(document, ROLE_CODES, AGENT_CODES, OWNER_AGENT_CODES)
    assert saved["steps"][3]["when"] == ["review", "test"]


def test_rejects_step_with_tags_of_two_agents() -> None:
    """Входящие теги двух включённых гостей: ступень не знает, кому её отдать."""
    document = default_process()
    _tag(document, "review")["agent"] = "opencode"
    _tag(document, "test")["agent"] = "verify-ci"
    document["steps"][3]["when"] = ["review", "test"]
    assert _rejects(document) == STEP_AGENTS_CONFLICT.format(
        id="review", a="opencode", b="verify-ci"
    )


def test_tags_are_checked_before_steps() -> None:
    """Порядок отказов: опечатка в ключе тега называется раньше ошибки ступени."""
    document = default_process()
    document["tags"].append({"key": "какая-то", "name": "метка", "title": "Метка", "agent": None})
    _first_step(document)["when"] = []
    assert _rejects(document) == TAG_UNKNOWN.format(key="какая-то")


def test_step_when_is_checked_before_duplicate_id() -> None:
    """Внутри ступени «нет входящих тегов» называется раньше дубля id."""
    document = default_process()
    document["steps"][1]["id"] = "mockup"
    document["steps"][1]["when"] = []
    assert _rejects(document) == STEP_NO_WHEN.format(id="mockup")


def test_put_rejects_step_with_two_agents_and_keeps_everything(
    api_client: TestClient, department_id: int
) -> None:
    """422 по ступени с двумя агентами не пишет ни процесс, ни ревизию реестра."""
    for code, title in (("opencode", "OpenCode"), ("verify-ci", "Verify CI")):
        created = api_client.post("/api/agents", json={"code": code, "title": title})
        assert created.status_code == 201, created.text

    _rebuild(api_client)
    before = api_client.get("/api/registry", headers=HEADERS)
    assert before.status_code == 200, before.text
    document = default_process()
    _tag(document, "review")["agent"] = "opencode"
    _tag(document, "test")["agent"] = "verify-ci"
    document["steps"][3]["when"] = ["review", "test"]

    response = api_client.put(_process_url(department_id), json=document)
    assert response.status_code == 422
    assert response.json()["detail"] == STEP_AGENTS_CONFLICT.format(
        id="review", a="opencode", b="verify-ci"
    )
    assert api_client.get(_process_url(department_id)).json()["document"] is None
    after = api_client.get("/api/registry", headers=HEADERS)
    assert after.status_code == 200, after.text
    assert after.json() == before.json()


@pytest.mark.parametrize(
    "document,text",
    [
        (_document(version=1), VERSION_UNSUPPORTED),
        ("мусор", SHAPE_INVALID),
        (
            _document(
                tags=[
                    *default_process()["tags"],
                    {"key": "лишний", "name": "x", "title": "X", "agent": None},
                ]
            ),
            TAG_UNKNOWN.format(key="лишний"),
        ),
    ],
    ids=["version", "shape", "tag"],
)
def test_put_answers_422_with_contract_text(
    client: TestClient,
    department_id: int,
    document: Any,
    text: str,
) -> None:
    """Ручка отвечает `422` и тем же текстом, что чистая проверка."""
    response = client.put(_process_url(department_id), json=document)
    assert response.status_code == 422
    assert response.json()["detail"] == text
