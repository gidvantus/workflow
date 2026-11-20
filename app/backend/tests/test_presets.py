"""Машинные ручки `/api/presets`: манифест, документ роли и сохранение документа.

Это контракт с плагином отдела (`plugins/presets.mjs`): harness спрашивает манифест,
сравнивает ревизии со своими и забирает изменившиеся документы, а заливает их обратно тем
же документом через `PUT`. Поэтому здесь проверяется не только «ручка ответила», но и:

- ревизия считается на чтении по документу и **не** двигается от повторного сохранения
  того же документа (`changed: false`, ни одной записи);
- ревизия набора — хеш строк `код:ревизия` по возрастанию кода (сверяется независимо
  в тесте, а не через прод-функцию);
- `PUT` — источник истины: скилл, которого нет в документе, мягко удаляется, а скилл с
  кодом мягко удалённого возвращается к жизни, а не заводится второй;
- все три ручки требуют заголовок `X-Registry-Token` и отказывают `401` без него.

Разбор `SKILL.md` и раскладка файлов — половина harness, её тест —
`plugins/tools/tests/presets.test.mjs`.
"""

import hashlib
import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main
from app.api.presets import SKILLS_NOT_ARRAY
from app.api.registry import TOKEN_REJECTED
from app.api.roles import (
    ROLE_NOT_FOUND,
    SECTIONS_NOT_ARRAY,
    SKILL_CODE_TAKEN,
)
from app.config import Settings, get_settings

PRESETS_URL = "/api/presets"
ROLES_URL = "/api/roles"
SKILLS_URL = "/api/skills"

TOKEN = "stand-token"
AUTH = {"X-Registry-Token": TOKEN}
ROLE_ID = 1
REVISION_LENGTH = 12

ROLE_FIELDS = {"code", "title", "revision", "skill_count"}
DOCUMENT_FIELDS = {"code", "title", "description", "revision", "skills"}

DOCUMENT: dict[str, Any] = {
    "title": "Аналитик",
    "description": "Собирает требования и ведёт задачу до приёмки.",
    "skills": [
        {
            "code": "requirements",
            "title": "Требования",
            "description": "Как формулировать требования к задаче.",
            "sections": [
                {"title": "Когда применять", "body": "На старте задачи."},
                {"title": "Шаги", "body": "## Шаг\n\n1. Прочитать задачу\n"},
            ],
        },
        {
            "code": "acceptance",
            "title": "Приёмка",
            "description": "Как проверять результат.",
            "sections": [],
        },
    ],
}


@pytest.fixture(name="api")
def api_fixture(client: TestClient) -> Iterator[TestClient]:
    """Клиент с заданным токеном надстройки: без него машинные ручки отвечают `401`."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite://", registry_token=TOKEN
    )
    try:
        yield client
    finally:
        main.app.dependency_overrides.pop(get_settings, None)


def _canonical(payload: Any) -> str:
    """Канонический JSON контракта: без пробелов, ключи по алфавиту."""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _expected_document_revision(document: dict[str, Any]) -> str:
    """Ревизия документа независимо от кода приложения: 12 hex от канонического JSON."""
    return hashlib.sha256(_canonical(document).encode("utf-8")).hexdigest()[:REVISION_LENGTH]


def _expected_manifest_revision(roles: list[dict[str, Any]]) -> str:
    """Ревизия набора независимо: хеш строк `код:ревизия` по возрастанию кода."""
    payload = "\n".join(
        f"{role['code']}:{role['revision']}"
        for role in sorted(roles, key=lambda item: item["code"])
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:REVISION_LENGTH]


def _manifest(api: TestClient) -> dict[str, Any]:
    """Манифест с токеном; тест на `401` держит header пустым по-своему."""
    response = api.get(PRESETS_URL, headers=AUTH)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _document(api: TestClient, code: str) -> dict[str, Any]:
    """Документ роли с токеном."""
    response = api.get(f"{PRESETS_URL}/{code}", headers=AUTH)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _put(api: TestClient, code: str, payload: dict[str, Any]) -> Any:
    """`PUT` документа роли: тело собирается вызывающим, путь — из аргумента."""
    return api.put(f"{PRESETS_URL}/{code}", json=payload, headers=AUTH)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", PRESETS_URL),
        ("get", f"{PRESETS_URL}/analyst"),
        ("put", f"{PRESETS_URL}/analyst"),
    ],
)
def test_presets_require_token(api: TestClient, method: str, path: str) -> None:
    """Без заголовка — `401` с дословным текстом контракта, а не `403` и не пусто."""
    kwargs = {"json": {"title": "Аналитик", "skills": []}} if method == "put" else {}
    response = getattr(api, method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REJECTED


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", PRESETS_URL),
        ("get", f"{PRESETS_URL}/analyst"),
        ("put", f"{PRESETS_URL}/analyst"),
    ],
)
def test_presets_reject_wrong_token(api: TestClient, method: str, path: str) -> None:
    """Чужой токен — тот же `401`."""
    kwargs = {"json": {"title": "Аналитик", "skills": []}} if method == "put" else {}
    response = getattr(api, method)(path, headers={"X-Registry-Token": "wrong-token"}, **kwargs)

    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REJECTED


def test_presets_reject_any_token_when_none_configured(client: TestClient) -> None:
    """Токен не задан в окружении — ручки закрыты, а не открыты всем."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="sqlite://", registry_token=""
    )
    try:
        response = client.get(PRESETS_URL, headers={"X-Registry-Token": ""})
    finally:
        main.app.dependency_overrides.pop(get_settings, None)

    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REJECTED


def test_manifest_lists_alive_roles_with_revisions(api: TestClient) -> None:
    """Манифест: десять ролей сида, у каждой ревизия из 12 hex и число скиллов."""
    body = _manifest(api)

    assert set(body) == {"revision", "roles"}
    assert [role["code"] for role in body["roles"]] == [
        "analyst",
        "dev-fullstack",
        "dev-backend",
        "dev-frontend",
        "code-review",
        "tester",
        "devops-delivery",
        "design",
        "security-review",
        "jev",
    ]
    for role in body["roles"]:
        assert set(role) == ROLE_FIELDS
        assert len(role["revision"]) == REVISION_LENGTH
        assert int(role["revision"], 16) >= 0
        assert role["skill_count"] == 0
    assert len(body["revision"]) == REVISION_LENGTH


def test_manifest_revision_is_hash_of_code_revision_lines(api: TestClient) -> None:
    """Ревизия набора — хеш строк `код:ревизия`, отсортированных по коду."""
    body = _manifest(api)

    assert body["revision"] == _expected_manifest_revision(body["roles"])


def test_manifest_revision_is_stable_across_reads(api: TestClient) -> None:
    """Два чтения подряд дают одну ревизию: даты в неё не входят."""
    first = _manifest(api)
    second = _manifest(api)

    assert first == second


def test_document_revision_matches_manifest(api: TestClient) -> None:
    """Ревизия документа в манифесте и в `GET /api/presets/{code}` — одна и та же."""
    manifest = _manifest(api)
    document = _document(api, "analyst")

    revision = next(role["revision"] for role in manifest["roles"] if role["code"] == "analyst")
    assert document["revision"] == revision
    assert document["revision"] == _expected_document_revision(
        {key: value for key, value in document.items() if key != "revision"}
    )


def test_document_body_matches_contract(api: TestClient) -> None:
    """Документ роли: код, название, описание и пустой список скиллов."""
    document = _document(api, "analyst")

    assert set(document) == DOCUMENT_FIELDS
    assert document["code"] == "analyst"
    assert document["title"] == "Аналитик"
    assert document["description"] == ""
    assert document["skills"] == []


def test_document_returns_skills_and_sections(api: TestClient) -> None:
    """Скилл и его разделы едут в документе в том же порядке, что и в списке скиллов."""
    created = api.post(
        f"{ROLES_URL}/{ROLE_ID}/skills",
        json={
            "code": "requirements",
            "title": "Требования",
            "description": "Как формулировать требования.",
            "sections": [{"title": "Шаги", "body": "1. Прочитать задачу\n"}],
        },
    )
    assert created.status_code == 201, created.text

    document = _document(api, "analyst")

    assert document["skills"] == [
        {
            "code": "requirements",
            "title": "Требования",
            "description": "Как формулировать требования.",
            "sections": [{"title": "Шаги", "body": "1. Прочитать задачу\n"}],
        }
    ]
    manifest = _manifest(api)
    assert next(role for role in manifest["roles"] if role["code"] == "analyst")["skill_count"] == 1


def test_document_of_unknown_role(api: TestClient) -> None:
    """Неизвестный код — `404` с текстом контракта."""
    response = api.get(f"{PRESETS_URL}/no-such-role", headers=AUTH)

    assert response.status_code == 404
    assert response.json()["detail"] == ROLE_NOT_FOUND


def test_document_of_deleted_role(api: TestClient) -> None:
    """Мягко удалённая роль из манифеста и из документа исчезает: `404`."""
    created = api.post(ROLES_URL, json={"code": "data-analyst", "title": "Дата-аналитик"})
    role_id = created.json()["id"]
    assert api.delete(f"{ROLES_URL}/{role_id}").status_code == 204

    assert api.get(f"{PRESETS_URL}/data-analyst", headers=AUTH).status_code == 404
    assert "data-analyst" not in [role["code"] for role in _manifest(api)["roles"]]


def test_put_creates_skills_and_reports_change(api: TestClient) -> None:
    """`PUT` заливает документ: скиллы созданы, `changed: true`, ревизия — ревизия результата."""
    response = _put(api, "analyst", DOCUMENT)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"role", "revision", "changed"}
    assert body["role"] == "analyst"
    assert body["changed"] is True

    document = _document(api, "analyst")
    assert body["revision"] == document["revision"]
    assert document["title"] == "Аналитик"
    assert document["description"] == DOCUMENT["description"]
    assert [skill["code"] for skill in document["skills"]] == ["requirements", "acceptance"]
    assert document["skills"][1]["sections"] == []
    assert document["skills"][0]["sections"][1]["body"] == "## Шаг\n\n1. Прочитать задачу\n"


def test_put_same_document_is_unchanged(api: TestClient) -> None:
    """Повторная заливка того же документа: `changed: false`, ни записи, ни сдвига времени."""
    first = _put(api, "analyst", DOCUMENT).json()
    before = next(role for role in api.get(ROLES_URL).json() if role["id"] == ROLE_ID)

    second = _put(api, "analyst", DOCUMENT)

    assert second.status_code == 200
    assert second.json()["changed"] is False
    assert second.json()["revision"] == first["revision"]
    after = next(role for role in api.get(ROLES_URL).json() if role["id"] == ROLE_ID)
    assert after["updated_at"] == before["updated_at"]


def test_put_removes_skill_missing_from_document(api: TestClient) -> None:
    """Скилл, которого нет в документе, мягко удаляется: веб — источник истины."""
    _put(api, "analyst", DOCUMENT)
    assert len(_document(api, "analyst")["skills"]) == 2

    reduced = {**DOCUMENT, "skills": DOCUMENT["skills"][:1]}
    response = _put(api, "analyst", reduced)

    assert response.status_code == 200
    assert response.json()["changed"] is True
    assert [skill["code"] for skill in _document(api, "analyst")["skills"]] == ["requirements"]
    assert [skill["code"] for skill in api.get(f"{ROLES_URL}/{ROLE_ID}/skills").json()] == [
        "requirements"
    ]


def test_put_revives_deleted_skill_with_same_code(api: TestClient) -> None:
    """Скилл с кодом мягко удалённого возвращается к жизни, второй строки не появляется."""
    _put(api, "analyst", DOCUMENT)
    skill_id = api.get(f"{ROLES_URL}/{ROLE_ID}/skills").json()[0]["id"]
    assert api.delete(f"{SKILLS_URL}/{skill_id}").status_code == 204

    response = _put(api, "analyst", DOCUMENT)

    assert response.status_code == 200
    assert response.json()["changed"] is True
    skills = api.get(f"{ROLES_URL}/{ROLE_ID}/skills").json()
    assert [skill["id"] for skill in skills] == [skill_id, skill_id + 1]


def test_put_changes_revision_of_role_and_manifest(api: TestClient) -> None:
    """Правка документа двигает и ревизию роли, и ревизию набора."""
    before = _manifest(api)

    _put(api, "analyst", DOCUMENT)

    after = _manifest(api)
    assert after["revision"] != before["revision"]
    before_role = next(role for role in before["roles"] if role["code"] == "analyst")
    after_role = next(role for role in after["roles"] if role["code"] == "analyst")
    assert after_role["revision"] != before_role["revision"]
    assert after_role["skill_count"] == 2


def test_manifest_follows_role_edit_from_web(api: TestClient) -> None:
    """Правка названия из браузера меняет ревизию: манифест идёт за базой, а не за кэшем."""
    before = _manifest(api)
    assert (
        api.patch(f"{ROLES_URL}/{ROLE_ID}", json={"title": "Системный аналитик"}).status_code == 200
    )

    after = _manifest(api)

    assert after["revision"] != before["revision"]
    assert next(role for role in after["roles"] if role["code"] == "analyst")["title"] == (
        "Системный аналитик"
    )


def test_put_unknown_role(api: TestClient) -> None:
    """`PUT` неизвестного кода — `404`: роли заводятся в вебе, а не заливкой."""
    response = _put(api, "no-such-role", DOCUMENT)

    assert response.status_code == 404
    assert response.json()["detail"] == ROLE_NOT_FOUND


def test_put_validates_title(api: TestClient) -> None:
    """Пустое название — `422` тем же текстом, что и правка из браузера."""
    response = _put(api, "analyst", {**DOCUMENT, "title": "  "})

    assert response.status_code == 422
    assert response.json()["detail"] == "Укажите название роли"
    assert _document(api, "analyst")["skills"] == []


def test_put_requires_skills_array(api: TestClient) -> None:
    """`skills` не массив — `422`: молча стереть скиллы нельзя."""
    response = _put(api, "analyst", {"title": "Аналитик", "skills": "нет"})

    assert response.status_code == 422
    assert response.json()["detail"] == SKILLS_NOT_ARRAY


def test_put_requires_skill_fields(api: TestClient) -> None:
    """У скилла в документе обязательны код, название, описание и массив разделов."""
    response = _put(
        api,
        "analyst",
        {"title": "Аналитик", "skills": [{"code": "requirements", "title": "Требования"}]},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Укажите описание скилла"


def test_put_rejects_bad_sections(api: TestClient) -> None:
    """`sections` внутри документа проверяются теми же валидаторами, что и в браузере."""
    response = _put(
        api,
        "analyst",
        {
            "title": "Аналитик",
            "skills": [
                {
                    "code": "requirements",
                    "title": "Требования",
                    "description": "Описание",
                    "sections": "нет",
                }
            ],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == SECTIONS_NOT_ARRAY


def test_put_rejects_duplicate_skill_codes(api: TestClient) -> None:
    """Повтор кода внутри документа — `409`: залить две строки с одним кодом нельзя."""
    duplicate = {**DOCUMENT, "skills": [DOCUMENT["skills"][0], DOCUMENT["skills"][0]]}

    response = _put(api, "analyst", duplicate)

    assert response.status_code == 409
    assert response.json()["detail"] == SKILL_CODE_TAKEN
    assert _document(api, "analyst")["skills"] == []


def test_put_uses_path_code_not_body_code(api: TestClient) -> None:
    """Код из пути главнее тела: он же имя каталога пресета."""
    response = _put(api, "analyst", {**DOCUMENT, "code": "code-review"})

    assert response.status_code == 200
    assert _document(api, "analyst")["code"] == "analyst"
    assert _document(api, "code-review")["skills"] == []
