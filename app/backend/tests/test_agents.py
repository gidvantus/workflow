"""Ручки `/api/agents`: справочник, мягкое удаление и машинный heartbeat.

Тексты отказов — часть контракта: их показывает окно «Новый агент» дословно, поэтому
проверяются по строкам. Heartbeat проверяется вместе с реестром: `PUT .../status`
обязан быть виден и в `GET /api/agents`, и в документе `GET /api/registry` — иначе
экран и диспетчер разошлись бы.
"""

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app import main
from app.api import agents as api
from app.config import Settings, get_settings
from app.models.registry import RegistryDocument

TOKEN = "registry-test-token"
HEADERS = {"X-Registry-Token": TOKEN}


@pytest.fixture(name="api_client")
def api_client_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с заданным токеном реестра: heartbeat читается только с ним."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite+pysqlite:///:memory:",
        registry_token=TOKEN,
    )
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


def _create(
    client: TestClient,
    code: str = "opencode",
    title: str = "OpenCode",
    runtime: str = "opencode",
    enabled: bool = True,
) -> dict:
    response = client.post(
        "/api/agents",
        json={"code": code, "title": title, "runtime": runtime, "enabled": enabled},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _project_ready_for_registry(client: TestClient) -> None:
    """Минимальный проект с отделом: без него `rebuild` не соберёт документ."""
    project = client.post(
        "/api/projects",
        json={"name": "Workflow", "description": "", "repo_url": "gidvantus/workflow"},
    ).json()
    created = client.post(f"/api/projects/{project['id']}/departments", json={"kind_id": 1})
    assert created.status_code == 201, created.text


def _revisions(session_factory: sessionmaker[Session]) -> list[RegistryDocument]:
    """Строки ревизий напрямую из базы — в обход ручек."""
    with session_factory() as session:
        return list(
            session.scalars(select(RegistryDocument).order_by(RegistryDocument.revision)).all()
        )


def test_list_is_empty_without_agents(client: TestClient) -> None:
    response = client.get("/api/agents")
    assert response.status_code == 200
    assert response.json() == []


def test_create_returns_agent_with_empty_status(client: TestClient) -> None:
    agent = _create(client)
    assert agent["code"] == "opencode"
    assert agent["title"] == "OpenCode"
    assert agent["runtime"] == "opencode"
    assert agent["enabled"] is True
    assert agent["status"] == {"state": None, "issue_number": None, "seen_at": None}
    assert isinstance(agent["id"], int)


def test_create_defaults_runtime_and_enabled(client: TestClient) -> None:
    response = client.post("/api/agents", json={"code": "verify-ci", "title": "Verify CI"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["runtime"] == "http"
    assert body["enabled"] is True


def test_list_returns_live_agents_by_id(client: TestClient) -> None:
    first = _create(client, code="verify-ci", title="Verify CI")
    second = _create(client, code="opencode", title="OpenCode")
    ids = [row["id"] for row in client.get("/api/agents").json()]
    assert ids == sorted([first["id"], second["id"]])


@pytest.mark.parametrize(
    "payload,text",
    [
        ({"title": "Без кода"}, api.CODE_REQUIRED),
        ({"code": "  ", "title": "Пустой код"}, api.CODE_REQUIRED),
        ({"code": "Open Code", "title": "Пробел"}, api.CODE_FORMAT),
        ({"code": "код", "title": "Кириллица"}, api.CODE_FORMAT),
        ({"code": "-start", "title": "Дефис"}, api.CODE_FORMAT),
        ({"code": "x" * 51, "title": "Длинный"}, api.CODE_TOO_LONG),
        ({"code": "ok", "title": "  "}, api.TITLE_REQUIRED),
        ({"code": "ok", "title": "x" * 101}, api.TITLE_TOO_LONG),
        ({"code": "ok", "title": "Среда", "runtime": "docker"}, api.RUNTIME_INVALID),
    ],
    ids=[
        "no-code",
        "blank-code",
        "space",
        "cyrillic",
        "leading-dash",
        "too-long",
        "no-title",
        "title-too-long",
        "runtime",
    ],
)
def test_create_rejects_invalid_payload(client: TestClient, payload: dict, text: str) -> None:
    response = client.post("/api/agents", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == text


def test_create_rejects_taken_code(client: TestClient) -> None:
    _create(client)
    response = client.post("/api/agents", json={"code": "opencode", "title": "Другой"})
    assert response.status_code == 409
    assert response.json()["detail"] == api.CODE_TAKEN


def test_deleted_code_stays_taken(client: TestClient) -> None:
    """Мягко удалённый код не переиспользуется: строка видна уникальному индексу."""
    agent = _create(client)
    assert client.delete(f"/api/agents/{agent['id']}").status_code == 204
    assert client.get("/api/agents").json() == []
    response = client.post("/api/agents", json={"code": "opencode", "title": "Снова"})
    assert response.status_code == 409
    assert response.json()["detail"] == api.CODE_TAKEN


def test_patch_updates_title_runtime_and_enabled(client: TestClient) -> None:
    agent = _create(client)
    response = client.patch(
        f"/api/agents/{agent['id']}",
        json={"title": "OpenCode CI", "runtime": "http", "enabled": False},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["title"], body["runtime"], body["enabled"]) == ("OpenCode CI", "http", False)


def test_patch_rejects_code_and_empty_body(client: TestClient) -> None:
    agent = _create(client)
    response = client.patch(f"/api/agents/{agent['id']}", json={"code": "other"})
    assert response.status_code == 422
    assert response.json()["detail"] == api.CODE_IMMUTABLE
    response = client.patch(f"/api/agents/{agent['id']}", json={})
    assert response.status_code == 422
    assert response.json()["detail"] == api.NO_FIELDS_TO_UPDATE


def test_patch_and_delete_hide_deleted_agent(client: TestClient) -> None:
    agent = _create(client)
    assert client.delete(f"/api/agents/{agent['id']}").status_code == 204
    assert client.patch(f"/api/agents/{agent['id']}", json={"title": "x"}).status_code == 404
    assert client.delete(f"/api/agents/{agent['id']}").status_code == 404
    assert client.get("/api/agents").json() == []


def test_status_requires_token(client: TestClient) -> None:
    agent = _create(client)
    response = client.put(
        f"/api/agents/{agent['code']}/status",
        json={"state": "idle", "issue_number": None},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Токен реестра не принят"


def test_status_is_visible_in_list_and_registry(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """Heartbeat пишет состояние; его видят `GET /api/agents` и документ реестра."""
    agent = _create(api_client)
    response = api_client.put(
        f"/api/agents/{agent['code']}/status",
        json={"state": "busy", "issue_number": 81},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["code"] == "opencode"
    assert body["state"] == "busy"
    assert body["issue_number"] == 81
    assert body["seen_at"]

    status = api_client.get("/api/agents").json()[0]["status"]
    assert status["state"] == "busy"
    assert status["issue_number"] == 81
    # SQLite отдаёт время без зоны, ответ heartbeat — с `Z`: сравниваем момент, а не форму.
    assert status["seen_at"].replace("Z", "") == body["seen_at"].replace("Z", "")

    # Реестр требует хотя бы один проект с отделом — заводим минимальный.
    _project_ready_for_registry(api_client)
    published = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert published.status_code == 200, published.text
    registry = published.json()["document"]
    assert registry["agents"] == [
        {
            "code": "opencode",
            "title": "OpenCode",
            "runtime": "opencode",
            "enabled": True,
            "status": {
                "state": "busy",
                "issue_number": 81,
                "seen_at": body["seen_at"].replace("Z", ""),
            },
        }
    ]


def test_registry_agents_are_sorted_by_code_and_always_present(
    api_client: TestClient,
) -> None:
    _create(api_client, code="verify-ci", title="Verify CI")
    _create(api_client, code="opencode", title="OpenCode")
    _project_ready_for_registry(api_client)

    response = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert response.status_code == 200, response.text
    assert [row["code"] for row in response.json()["document"]["agents"]] == [
        "opencode",
        "verify-ci",
    ]


def test_registry_agents_are_live_even_without_new_revision(api_client: TestClient) -> None:
    """`GET /api/registry` подставляет живой справочник: heartbeat не пишет ревизию."""
    agent = _create(api_client, code="verify-ci", title="Verify CI")
    _project_ready_for_registry(api_client)
    rebuilt = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert rebuilt.status_code == 200, rebuilt.text
    before = api_client.get("/api/registry", headers=HEADERS).json()
    assert before["agents"][0]["status"]["state"] is None

    response = api_client.put(
        f"/api/agents/{agent['code']}/status",
        json={"state": "busy", "issue_number": 7},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text

    after = api_client.get("/api/registry", headers=HEADERS).json()
    assert after["agents"][0]["status"]["state"] == "busy"
    assert after["agents"][0]["status"]["issue_number"] == 7
    assert after["projects"] == before["projects"]


def test_revision_body_keeps_no_heartbeat(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """Heartbeat живёт только в ответе `GET`: в ревизию он не попадает.

    Иначе две публикации, между которыми человек ничего не правил, различались бы
    текстом из-за одного сердцебиения — а история хранила бы состояние, верное ровно
    в момент записи.
    """
    _create(api_client)
    _project_ready_for_registry(api_client)
    first = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert first.status_code == 200, first.text

    heartbeat = api_client.put(
        "/api/agents/opencode/status",
        json={"state": "busy", "issue_number": 81},
        headers=HEADERS,
    )
    assert heartbeat.status_code == 200, heartbeat.text
    second = api_client.post("/api/registry/rebuild", headers=HEADERS)
    assert second.status_code == 200, second.text

    rows = _revisions(session_factory)
    assert len(rows) >= 2
    # Между двумя последними ревизиями менялось только сердцебиение — текст тот же.
    assert rows[-2].body == rows[-1].body
    stored = json.loads(rows[-1].body)["agents"][0]
    assert stored["status"] == {"state": None, "issue_number": None, "seen_at": None}

    # Живой статус по-прежнему виден в документе реестра.
    live = api_client.get("/api/registry", headers=HEADERS).json()
    assert live["agents"][0]["status"]["state"] == "busy"
    assert live["agents"][0]["status"]["issue_number"] == 81


def test_put_cannot_store_heartbeat(
    api_client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """`PUT` документа из того же `GET` не записывает heartbeat в историю."""
    _create(api_client)
    _project_ready_for_registry(api_client)
    assert api_client.post("/api/registry/rebuild", headers=HEADERS).status_code == 200
    live = api_client.get("/api/registry", headers=HEADERS).json()
    live["agents"][0]["status"] = {
        "state": "busy",
        "issue_number": 7,
        "seen_at": "2026-11-25T12:00:00Z",
    }

    saved = api_client.put("/api/registry", json=live, headers=HEADERS)
    assert saved.status_code == 200, saved.text

    stored = json.loads(_revisions(session_factory)[-1].body)["agents"][0]
    assert stored["status"] == {"state": None, "issue_number": None, "seen_at": None}


def test_status_rejects_unknown_agent_and_state(api_client: TestClient) -> None:
    response = api_client.put(
        "/api/agents/nobody/status",
        json={"state": "idle", "issue_number": None},
        headers=HEADERS,
    )
    assert response.status_code == 404
    assert response.json()["detail"] == api.AGENT_NOT_FOUND

    agent = _create(api_client)
    for state in ("active", "", None, 1):
        response = api_client.put(
            f"/api/agents/{agent['code']}/status",
            json={"state": state, "issue_number": None},
            headers=HEADERS,
        )
        assert response.status_code == 422
        assert response.json()["detail"] == api.STATE_INVALID


def test_status_rejects_deleted_agent(api_client: TestClient) -> None:
    agent = _create(api_client)
    assert api_client.delete(f"/api/agents/{agent['id']}").status_code == 204
    response = api_client.put(
        f"/api/agents/{agent['code']}/status",
        json={"state": "idle", "issue_number": None},
        headers=HEADERS,
    )
    assert response.status_code == 404
    assert response.json()["detail"] == api.AGENT_NOT_FOUND
