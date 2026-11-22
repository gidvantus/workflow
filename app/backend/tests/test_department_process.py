"""Процесс отдела: умолчания, документ, ручки `GET`/`PUT` и тексты отказов.

Проверяется контракт постановки `#67` целиком, потому что половина его — тексты: экран
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
from app.models.role import DEFAULT_ROLES, Role
from app.process_defaults import (
    DEFAULT_LABELS,
    DEFAULT_STEPS,
    GUARDS,
    LABEL_KEYS,
    PROCESS_VERSION,
    default_process,
)
from app.schemas.process import (
    LABEL_EMPTY,
    LABEL_UNKNOWN,
    SHAPE_INVALID,
    STEP_GUARD_UNKNOWN,
    STEP_ID_DUPLICATE,
    STEP_KIND_UNKNOWN,
    STEP_LABEL_UNKNOWN,
    STEP_NO_WHEN,
    STEP_PRIORITY_INVALID,
    STEP_ROLE_UNKNOWN,
    STEP_ROUTE_GUARD,
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

# Таблица ступеней по умолчанию — **литерал из постановки** `#67`: id, приоритет, вид,
# роль, входящие метки, «кроме», ставит, снимает, страж. Порядок строк — порядок
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


def _process_url(department_id: int) -> str:
    return f"/api/departments/{department_id}/process"


def _document(**overrides: Any) -> dict[str, Any]:
    """Документ из умолчаний с точечными правками: тело `PUT` в тестах."""
    document = default_process()
    document.update(overrides)
    return document


def _first_step(document: dict[str, Any]) -> dict[str, Any]:
    return document["steps"][0]


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
    """13 ступеней ровно из постановки: id, приоритет, метки, роли, стражи."""
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


def test_default_labels_cover_every_key_in_contract_order() -> None:
    """Имена меток: 14 ключей, порядок контракта, имена прежние."""
    document = default_process()
    assert list(document["labels"]) == list(LABEL_KEYS)
    assert document["labels"] == DEFAULT_LABELS
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
    assert validate_process_document(document, ROLE_CODES) == document


def test_defaults_do_not_leak_between_calls() -> None:
    """`default_process()` отдаёт копию: правка ответа не меняет образец."""
    first = default_process()
    _first_step(first)["put"].append("test")
    first["labels"]["test"] = "чужое-имя"
    assert _first_step(default_process())["put"] == ["progress"]
    assert default_process()["labels"]["test"] == "ready-for-test"


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
    document["labels"]["test"] = "qa-ready"
    assert client.put(_process_url(department_id), json=document).status_code == 200

    response = client.get(_process_url(department_id))
    assert response.status_code == 200, response.text
    assert response.json()["document"] == document


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


def test_put_grows_registry_revision(client: TestClient, department_id: int) -> None:
    """Каждое сохранение процесса — новая ревизия реестра, а не та же строка."""
    first = client.put(_process_url(department_id), json=default_process()).json()["revision"]
    second = client.put(_process_url(department_id), json=default_process()).json()["revision"]
    assert second > first


def test_put_renames_label_and_registry_shows_it(
    api_client: TestClient,
    department_id: int,
) -> None:
    """Переименование метки доезжает до документа реестра: это и есть путь до диспетчера."""
    _rebuild(api_client)
    before = _registry_department(api_client, department_id)
    assert before["process"] is None

    document = default_process()
    document["labels"]["test"] = "qa-ready"
    response = api_client.put(_process_url(department_id), json=document)
    assert response.status_code == 200, response.text

    after = _registry_department(api_client, department_id)
    assert after["process"] == document
    assert after["process"]["labels"]["test"] == "qa-ready"


def test_put_without_saved_process_sends_null_to_registry(
    api_client: TestClient,
    department_id: int,
) -> None:
    """Ключ `process` есть всегда, а «своего процесса нет» — это `null`.

    Пропущенный ключ `plugins/registry.mjs` читает как «веб про процесс молчит» и оставляет
    в файле прежнюю таблицу: снятый в вебе процесс продолжал бы исполняться диспетчером.
    """
    _rebuild(api_client)
    department = _registry_department(api_client, department_id)
    assert "process" in department
    assert department["process"] is None


def test_put_normalizes_document(client: TestClient, department_id: int) -> None:
    """Канон: лишние ключи ступени отброшены, `enabled` по умолчанию, имена обрезаны."""
    document = default_process()
    for step in document["steps"]:
        step.pop("enabled")
    _first_step(document)["лишний"] = "мусор"
    document["labels"]["dev"] = "  ready-for-dev  "

    body = client.put(_process_url(department_id), json=document).json()
    saved = body["document"]
    assert "лишний" not in _first_step(saved)
    assert _first_step(saved)["enabled"] is True
    assert saved["labels"]["dev"] == "ready-for-dev"
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


def test_put_hides_deleted_department(client: TestClient, department_id: int) -> None:
    """В удалённый отдел процесс не записать."""
    assert client.delete(f"/api/departments/{department_id}").status_code == 204
    assert client.put(_process_url(department_id), json=default_process()).status_code == 404


# --- PUT: таблица отказов --------------------------------------------------


def _rejects(document: Any) -> str:
    """Текст отказа на документе: `ProcessError` из чистой проверки."""
    with pytest.raises(ProcessError) as caught:
        validate_process_document(document, ROLE_CODES)
    return str(caught.value)


def test_rejects_unknown_version() -> None:
    assert _rejects(_document(version=2)) == VERSION_UNSUPPORTED
    assert _rejects(_document(version="1")) == VERSION_UNSUPPORTED
    # `True == 1` в Python: флаг версией не считается.
    assert _rejects(_document(version=True)) == VERSION_UNSUPPORTED


@pytest.mark.parametrize(
    "value",
    [None, "process", 42, [], {"version": 1, "steps": []}, {"version": 1, "labels": {}}],
    ids=["null", "text", "number", "array", "no-labels", "no-steps"],
)
def test_rejects_wrong_shape(value: Any) -> None:
    assert _rejects(value) == SHAPE_INVALID


def test_rejects_unknown_label_key() -> None:
    document = default_process()
    document["labels"]["какая-то"] = "метка"
    assert _rejects(document) == LABEL_UNKNOWN.format(key="какая-то")


@pytest.mark.parametrize("name", ["", "   ", None], ids=["empty", "spaces", "null"])
def test_rejects_empty_label_name(name: Any) -> None:
    document = default_process()
    document["labels"]["merged"] = name
    assert _rejects(document) == LABEL_EMPTY.format(key="merged")


def test_rejects_step_without_incoming_labels() -> None:
    document = default_process()
    _first_step(document)["when"] = []
    assert _rejects(document) == STEP_NO_WHEN.format(id="mockup")


def test_rejects_duplicate_step_id() -> None:
    document = default_process()
    document["steps"][1]["id"] = "mockup"
    assert _rejects(document) == STEP_ID_DUPLICATE.format(id="mockup")


def test_rejects_unknown_label_key_in_step() -> None:
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


def test_labels_are_checked_before_steps() -> None:
    """Порядок отказов: опечатка в ключе метки называется раньше ошибки ступени."""
    document = default_process()
    document["labels"]["какая-то"] = "метка"
    _first_step(document)["when"] = []
    assert _rejects(document) == LABEL_UNKNOWN.format(key="какая-то")


def test_step_when_is_checked_before_duplicate_id() -> None:
    """Внутри ступени «нет входящих меток» называется раньше дубля id."""
    document = default_process()
    document["steps"][1]["id"] = "mockup"
    document["steps"][1]["when"] = []
    assert _rejects(document) == STEP_NO_WHEN.format(id="mockup")


@pytest.mark.parametrize(
    "document,text",
    [
        (_document(version=2), VERSION_UNSUPPORTED),
        ("мусор", SHAPE_INVALID),
        (
            _document(labels={**DEFAULT_LABELS, "лишний": "ключ"}),
            LABEL_UNKNOWN.format(key="лишний"),
        ),
    ],
    ids=["version", "shape", "label"],
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
