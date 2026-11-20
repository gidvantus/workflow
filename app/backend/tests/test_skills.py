"""Скиллы ролей: создание, правка разделов, мягкое удаление и счётчик у роли.

Скилл — это файл `SKILL.md` пресета: заголовок, `description` frontmatter и разделы `##`.
Поэтому здесь проверяется не только «сохранилось», но и **порядок** разделов, точный
markdown в теле (переводы строк и блок кода не нормализуются) и то, что число скиллов в
`GET /api/roles` считается по живым строкам.

Тексты отказов сравниваются дословно: их показывает фронт, они же часть контракта.
Машинные ручки документа роли — в `test_presets.py`.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.roles import (
    NO_FIELDS_TO_UPDATE,
    SECTION_BODY_NOT_TEXT,
    SECTION_BODY_TOO_LONG,
    SECTION_TITLE_REQUIRED,
    SECTION_TITLE_TOO_LONG,
    SECTIONS_NOT_ARRAY,
    SECTIONS_TOO_MANY,
    SKILL_CODE_FORMAT,
    SKILL_CODE_IMMUTABLE,
    SKILL_CODE_REQUIRED,
    SKILL_CODE_TAKEN,
    SKILL_CODE_TOO_LONG,
    SKILL_DESCRIPTION_REQUIRED,
    SKILL_DESCRIPTION_TOO_LONG,
    SKILL_NOT_FOUND,
    SKILL_TITLE_REQUIRED,
    SKILL_TITLE_TOO_LONG,
)
from app.models.role_skill import RoleSkill

ROLES_URL = "/api/roles"
SKILLS_URL = "/api/skills"

# Роль сида: `analyst`, `id` 1. Скиллы в тестах живут у неё.
ROLE_ID = 1

MARKDOWN_BODY = "## Шаг\n\n1. Открыть отчёт\n2. Сверить числа\n\n```sql\nselect 1;\n```\n"

SKILL: dict[str, Any] = {
    "code": "pdf-report",
    "title": "Отчёт в PDF",
    "description": "Как собрать ежемесячный отчёт в PDF: шаги и проверки.",
    "sections": [
        {"title": "Когда применять", "body": "Когда нужен отчёт за месяц."},
        {"title": "Как собрать", "body": MARKDOWN_BODY},
        {"title": "Проверки", "body": ""},
    ],
}


@pytest.fixture(name="open_session")
def open_session_fixture(
    session_factory: sessionmaker[Session],
) -> Iterator[Session]:
    """Сессия к той же базе, что у клиента: ею в тестах смотрится строка в обход API."""
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def _create_skill(client: TestClient, role_id: int = ROLE_ID, **payload: Any) -> dict[str, Any]:
    """Живой скилл через API: поля берутся из `SKILL`, присланные — поверх."""
    body: dict[str, Any] = {**SKILL, "sections": [dict(section) for section in SKILL["sections"]]}
    body.update(payload)
    response = client.post(f"{ROLES_URL}/{role_id}/skills", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _skills(client: TestClient, role_id: int = ROLE_ID) -> list[dict[str, Any]]:
    """Скиллы роли так, как их видит фронт."""
    return client.get(f"{ROLES_URL}/{role_id}/skills").json()


def _role(client: TestClient, role_id: int = ROLE_ID) -> dict[str, Any]:
    """Строка роли из `GET /api/roles`."""
    return next(item for item in client.get(ROLES_URL).json() if item["id"] == role_id)


def test_create_returns_created_skill(client: TestClient) -> None:
    """`201` и полная строка скилла: поля ровно по контракту."""
    response = client.post(f"{ROLES_URL}/{ROLE_ID}/skills", json=SKILL)

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {
        "id",
        "code",
        "title",
        "description",
        "sections",
        "created_at",
        "updated_at",
    }
    assert body["id"] == 1
    assert body["code"] == "pdf-report"
    assert body["title"] == "Отчёт в PDF"
    assert body["description"] == SKILL["description"]
    assert body["sections"] == SKILL["sections"]
    assert _skills(client) == [body]


def test_sections_keep_order_and_markdown(client: TestClient) -> None:
    """Разделы едут массивом в том же порядке, markdown в теле — байт в байт."""
    _create_skill(client)

    sections = _skills(client)[0]["sections"]

    assert [section["title"] for section in sections] == [
        "Когда применять",
        "Как собрать",
        "Проверки",
    ]
    assert sections[1]["body"] == MARKDOWN_BODY
    assert sections[2]["body"] == ""


def test_empty_sections_are_allowed(client: TestClient) -> None:
    """Скилл без разделов — нормальное состояние: `sections: []` сохраняется как есть."""
    body = _create_skill(client, sections=[])

    assert body["sections"] == []
    assert _skills(client)[0]["sections"] == []


def test_section_without_body_gets_empty_string(client: TestClient) -> None:
    """Раздел-заголовок без текста: `body` приезжает пустой строкой, а не `null`."""
    body = _create_skill(client, sections=[{"title": "Заготовка"}])

    assert body["sections"] == [{"title": "Заготовка", "body": ""}]


def test_create_trims_code_and_section_titles(client: TestClient) -> None:
    """Пробелы по краям кода и заголовка раздела срезаются, тело не трогается."""
    body = _create_skill(
        client,
        code="  pdf-report  ",
        sections=[{"title": "  Когда применять  ", "body": "  текст  "}],
    )

    assert body["code"] == "pdf-report"
    assert body["sections"] == [{"title": "Когда применять", "body": "  текст  "}]


def test_create_with_existing_code_conflicts(client: TestClient) -> None:
    """Код скилла у роли занят: `409` с текстом контракта."""
    _create_skill(client)

    response = client.post(f"{ROLES_URL}/{ROLE_ID}/skills", json=SKILL)

    assert response.status_code == 409
    assert response.json()["detail"] == SKILL_CODE_TAKEN
    assert len(_skills(client)) == 1


def test_same_code_is_allowed_in_another_role(client: TestClient) -> None:
    """Один и тот же код у разных ролей — не конфликт: уникальность по паре."""
    _create_skill(client)
    other = _create_skill(client, role_id=2)

    assert other["code"] == "pdf-report"
    assert len(_skills(client, 2)) == 1


def test_create_with_code_of_deleted_skill_conflicts(client: TestClient) -> None:
    """Код мягко удалённого скилла не переиспользуется: `409`."""
    body = _create_skill(client)
    assert client.delete(f"{SKILLS_URL}/{body['id']}").status_code == 204

    response = client.post(f"{ROLES_URL}/{ROLE_ID}/skills", json=SKILL)

    assert response.status_code == 409
    assert response.json()["detail"] == SKILL_CODE_TAKEN


def test_create_for_unknown_role(client: TestClient) -> None:
    """Неизвестная роль — `404`."""
    response = client.post(f"{ROLES_URL}/999/skills", json=SKILL)

    assert response.status_code == 404
    assert response.json()["detail"] == "Роль не найдена"


def test_create_for_deleted_role(client: TestClient) -> None:
    """Мягко удалённая роль скиллов не принимает: `404`."""
    created = client.post(ROLES_URL, json={"code": "data-analyst", "title": "Дата-аналитик"})
    role_id = created.json()["id"]
    assert client.delete(f"{ROLES_URL}/{role_id}").status_code == 204

    response = client.post(f"{ROLES_URL}/{role_id}/skills", json=SKILL)

    assert response.status_code == 404
    assert response.json()["detail"] == "Роль не найдена"


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"title": SKILL["title"], "description": SKILL["description"]}, SKILL_CODE_REQUIRED),
        ({"code": "", "title": SKILL["title"]}, SKILL_CODE_REQUIRED),
        ({"code": "Pdf-Report", "title": SKILL["title"]}, SKILL_CODE_FORMAT),
        ({"code": "pdf_report", "title": SKILL["title"]}, SKILL_CODE_FORMAT),
        ({"code": "a" * 65, "title": SKILL["title"]}, SKILL_CODE_TOO_LONG),
        ({"code": "pdf-report", "description": SKILL["description"]}, SKILL_TITLE_REQUIRED),
        ({"code": "pdf-report", "title": " "}, SKILL_TITLE_REQUIRED),
        ({"code": "pdf-report", "title": "я" * 201}, SKILL_TITLE_TOO_LONG),
        ({"code": "pdf-report", "title": SKILL["title"]}, SKILL_DESCRIPTION_REQUIRED),
        (
            {"code": "pdf-report", "title": SKILL["title"], "description": ""},
            SKILL_DESCRIPTION_REQUIRED,
        ),
        (
            {"code": "pdf-report", "title": SKILL["title"], "description": "я" * 1001},
            SKILL_DESCRIPTION_TOO_LONG,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": "раздел",
            },
            SECTIONS_NOT_ARRAY,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": {"a": 1},
            },
            SECTIONS_NOT_ARRAY,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": [{}],
            },
            SECTION_TITLE_REQUIRED,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": [{"title": " "}],
            },
            SECTION_TITLE_REQUIRED,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": [{"title": "я" * 201, "body": ""}],
            },
            SECTION_TITLE_TOO_LONG,
        ),
        (
            {
                "code": "pdf-report",
                "title": SKILL["title"],
                "description": SKILL["description"],
                "sections": [{"title": "Раздел", "body": "я" * 20001}],
            },
            SECTION_BODY_TOO_LONG,
        ),
    ],
)
def test_create_validates_skill_fields(
    client: TestClient,
    payload: dict[str, Any],
    detail: str,
) -> None:
    """Пределы и обязательность полей скилла: `422` с дословным текстом контракта."""
    response = client.post(f"{ROLES_URL}/{ROLE_ID}/skills", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert _skills(client) == []


def test_too_many_sections_are_rejected(client: TestClient) -> None:
    """Больше 50 разделов — `422`: это правило обеих половин."""
    sections = [{"title": f"Раздел {index}", "body": ""} for index in range(51)]

    response = client.post(
        f"{ROLES_URL}/{ROLE_ID}/skills",
        json={
            "code": "pdf-report",
            "title": SKILL["title"],
            "description": SKILL["description"],
            "sections": sections,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == SECTIONS_TOO_MANY


@pytest.mark.parametrize("body", [{"a": 1}, 42, True, ["строка"], 3.5])
def test_non_text_section_body_is_rejected(client: TestClient, body: Any) -> None:
    """Нестроковый `body` — `422`, а не приведение к тексту.

    `str({"a": 1})` уехал бы в `SKILL.md` как `{'a': 1}`, и модель прочитала бы мусор
    вместо раздела. `null` — отдельный случай: он читается как пустой текст.
    """
    response = client.post(
        f"{ROLES_URL}/{ROLE_ID}/skills",
        json={
            "code": "pdf-report",
            "title": SKILL["title"],
            "description": SKILL["description"],
            "sections": [{"title": "Раздел", "body": body}],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == SECTION_BODY_NOT_TEXT
    assert _skills(client) == []


def test_limit_values_are_accepted(client: TestClient) -> None:
    """Ровно 50 разделов и предельные длины принимаются: граница включительная."""
    sections = [{"title": "я" * 200, "body": "я" * 20000} for _index in range(50)]

    body = _create_skill(
        client,
        code="a" * 64,
        title="я" * 200,
        description="я" * 1000,
        sections=sections,
    )

    assert len(body["sections"]) == 50
    assert len(body["sections"][0]["body"]) == 20000


def test_skill_count_grows_and_shrinks(client: TestClient) -> None:
    """`skill_count` в списке ролей — число живых скиллов, а не число строк."""
    assert _role(client)["skill_count"] == 0

    body = _create_skill(client)
    assert _role(client)["skill_count"] == 1

    assert client.delete(f"{SKILLS_URL}/{body['id']}").status_code == 204
    assert _role(client)["skill_count"] == 0


def test_patch_replaces_sections_entirely(client: TestClient) -> None:
    """`sections` заменяет массив целиком: раздел, которого нет в теле, исчезает."""
    body = _create_skill(client)

    response = client.patch(
        f"{SKILLS_URL}/{body['id']}",
        json={"sections": [{"title": "Только один", "body": "текст"}]},
    )

    assert response.status_code == 200
    assert response.json()["sections"] == [{"title": "Только один", "body": "текст"}]
    assert _skills(client)[0]["sections"] == [{"title": "Только один", "body": "текст"}]


def test_patch_reorders_sections(client: TestClient) -> None:
    """Порядок разделов задаётся массивом: «Выше»/«Ниже» — это перестановка в теле."""
    body = _create_skill(client)
    reordered = [body["sections"][2], body["sections"][0], body["sections"][1]]

    response = client.patch(f"{SKILLS_URL}/{body['id']}", json={"sections": reordered})

    assert response.status_code == 200
    assert response.json()["sections"] == reordered


def test_patch_field_absent_is_untouched(client: TestClient) -> None:
    """Правка названия не трогает разделы."""
    body = _create_skill(client)

    response = client.patch(f"{SKILLS_URL}/{body['id']}", json={"title": "Отчёт в PDF за месяц"})

    assert response.status_code == 200
    assert response.json()["title"] == "Отчёт в PDF за месяц"
    assert response.json()["sections"] == SKILL["sections"]


def test_patch_code_is_rejected(client: TestClient) -> None:
    """Код скилла неизменяем: `422`."""
    body = _create_skill(client)

    response = client.patch(f"{SKILLS_URL}/{body['id']}", json={"code": "pdf"})

    assert response.status_code == 422
    assert response.json()["detail"] == SKILL_CODE_IMMUTABLE
    assert _skills(client)[0]["code"] == "pdf-report"


def test_patch_empty_body_is_rejected(client: TestClient) -> None:
    """Пустое тело — `422`."""
    body = _create_skill(client)

    response = client.patch(f"{SKILLS_URL}/{body['id']}", json={})

    assert response.status_code == 422
    assert response.json()["detail"] == NO_FIELDS_TO_UPDATE


def test_patch_unknown_skill(client: TestClient) -> None:
    """Неизвестный `id` — `404`."""
    response = client.patch(f"{SKILLS_URL}/999", json={"title": "Отчёт"})

    assert response.status_code == 404
    assert response.json()["detail"] == SKILL_NOT_FOUND


def test_patch_deleted_skill_is_not_found(client: TestClient) -> None:
    """Мягко удалённый скилл не правится: `404`."""
    body = _create_skill(client)
    client.delete(f"{SKILLS_URL}/{body['id']}")

    response = client.patch(f"{SKILLS_URL}/{body['id']}", json={"title": "Отчёт"})

    assert response.status_code == 404
    assert response.json()["detail"] == SKILL_NOT_FOUND


def test_delete_is_soft_and_hides_skill(client: TestClient, open_session: Session) -> None:
    """`204`: скилл уходит из списка, строка в базе остаётся с `deleted_at`."""
    body = _create_skill(client)

    response = client.delete(f"{SKILLS_URL}/{body['id']}")

    assert response.status_code == 204
    assert response.content == b""
    assert _skills(client) == []
    row = open_session.get(RoleSkill, body["id"])
    assert row is not None
    assert row.deleted_at is not None
    assert client.delete(f"{SKILLS_URL}/{body['id']}").status_code == 404


def test_delete_unknown_skill(client: TestClient) -> None:
    """Неизвестный `id` — `404`."""
    response = client.delete(f"{SKILLS_URL}/999")

    assert response.status_code == 404
    assert response.json()["detail"] == SKILL_NOT_FOUND


def test_skills_of_unknown_role(client: TestClient) -> None:
    """Список скиллов неизвестной роли — `404`, а не пустой массив."""
    response = client.get(f"{ROLES_URL}/999/skills")

    assert response.status_code == 404
    assert response.json()["detail"] == "Роль не найдена"


def test_skills_are_ordered_by_id(client: TestClient) -> None:
    """Порядок скиллов роли — по `id`, он же порядок каталогов в пакете."""
    for code in ("alpha", "beta", "gamma"):
        _create_skill(client, code=code, title=code)

    assert [skill["code"] for skill in _skills(client)] == ["alpha", "beta", "gamma"]
