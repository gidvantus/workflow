"""Форма документа процесса отдела: ответы ручек и проверка присланного тела `PUT`.

Документ процесса приходит свободным телом (`Any`), а не моделью pydantic, по той же
причине, что и документ реестра: таблица отказов — часть контракта, и порядок проверок
фиксирован, чтобы на документе с двумя ошибками ответ был предсказуемым. Проверка живёт
здесь, а не в ручке, потому что её же пересказывает `plugins/docs/DEPARTMENT-PROCESS.md`.

**Версия 2.** Сохранение принимает только v2: `{"version": 2, "tags": [...], "steps": [...]}`.
Тегов ровно 14 — по одному на ключ `LABEL_KEYS`, — и состав менять нельзя: ключи прошиты
в диспетчере. Меняются имя, подпись и агент. `agent` — `null` («ступень берёт диспетчер»)
или код живого агента справочника; агент, которого нет в справочнике, документом не
принимается, иначе ступень молча ждала бы несуществующего гостя.

**Порядок проверок** (нарушать нельзя, на нём держатся тесты):

1. версия — `Поддерживается только версия процесса 2`;
2. форма — объект с `version`, `tags`, `steps` (сюда же попадают тег не-объект, `key` не
   строка, пропущенный ключ тега, ступень не-объект, `id` не строка, `enabled` не `bool`);
3. `tags` — неизвестный ключ, затем пустое имя, повтор имени, пустая подпись, подпись
   длиннее 100, неизвестный агент;
4. `steps` — нет входящих тегов, дубль `id`, неизвестный ключ тега, вид, роль, страж,
   приоритет, «у маршрутной ступени должен быть страж route», потом владелец ступени:
   входящие теги двух разных агентов — отказ;
5. `steps` — владение: входящие теги ступени не могут принадлежать двум разным агентам.

Внутри `tags` неизвестный ключ называется **до** проверки полноты набора: иначе опечатка
в ключе выглядела бы как «документ не той формы». Внутри ступени порядок обратный
осторожности ради: сначала «нет входящих тегов», потом дубль id, потом ссылки на теги.

**Нормализация.** Проверенный документ возвращается каноническим: теги в порядке
`LABEL_KEYS`, ступени — в присланном порядке (порядок исполнения задаёт `priority`), у
каждой ступени ровно ключи контракта, `enabled` — `bool`, `priority` — `int`. Лишние
ключи в теле отбрасываются, а не попадают в колонку: документ — это контракт, и мусор в
нём читал бы диспетчер.

**Роль.** Код роли принимается только из живых ролей справочника (`roles`) плюс два
резолвера `by-area`/`by-findings`. Роль, которую завели и удалили, документом не
принимается: сессия по ней не поднялась бы молча.
"""

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

from app.process_defaults import (
    GUARD_IDS,
    LABEL_KEYS,
    PRIORITY_MAX,
    PRIORITY_MIN,
    PROCESS_VERSION,
    ROLE_RESOLVERS,
    STEP_KINDS,
)

# Тексты отказов — часть контракта: их показывает экран «Процесс» дословно, и тестировщик
# сверяет их по таблице «Контракт половин». Ни одна другая половина их не сочиняет.
VERSION_UNSUPPORTED = "Поддерживается только версия процесса 2"
SHAPE_INVALID = "Нужен объект процесса с полями version, tags, steps"
TAG_UNKNOWN = "Неизвестный ключ тега: «{key}»"
TAG_NAME_EMPTY = "Имя тега пустое: «{key}»"
TAG_NAME_DUPLICATE = "Имена тегов повторяются: «{name}»"
TAG_TITLE_EMPTY = "Подпись тега пустая: «{key}»"
TAG_TITLE_TOO_LONG = "Подпись тега длиннее 100 символов: «{key}»"
TAG_AGENT_UNKNOWN = "Агент не найден: «{code}»"
STEP_NO_WHEN = "У ступени «{id}» нет входящих тегов"
STEP_ID_DUPLICATE = "Дублируется id ступени: «{id}»"
STEP_LABEL_UNKNOWN = "Неизвестный ключ тега в ступени «{id}»: «{key}»"
STEP_KIND_UNKNOWN = "Неизвестный вид ступени у «{id}»: «{kind}»"
STEP_ROLE_UNKNOWN = "Неизвестная роль у ступени «{id}»: «{role}»"
STEP_GUARD_UNKNOWN = "Неизвестный страж у ступени «{id}»: «{guard}»"
STEP_PRIORITY_INVALID = "Ступень «{id}»: приоритет — целое от 1 до 999"
STEP_ROUTE_GUARD = "Ступень «{id}»: у маршрутной ступени должен быть страж route"
STEP_AGENTS_CONFLICT = "Ступень «{id}» берёт теги разных агентов: «{a}», «{b}»"

# Предел подписи тега — тот же, что у названия роли и агента.
TAG_TITLE_MAX_LENGTH = 100

# Страж маршрутной ступени: ступень вида `route` без него ничего не делает, и принять такой
# документ значило бы молча потерять входную ступень конвейера.
ROUTE_GUARD = "route"


class ProcessError(ValueError):
    """Отказ проверки документа процесса: текст исключения — `detail` ответа `422`."""


class ProcessGuard(BaseModel):
    """Страж в каталоге: id для документа и заголовок для списка в редакторе."""

    id: str
    title: str


class ProcessResponse(BaseModel):
    """`GET /api/departments/{id}/process`: сохранённый документ, умолчания, роли, стражи.

    `document: null` — своего процесса у отдела нет, диспетчер исполняет `defaults`.
    `roles` и `guards` приходят с сервера: своей копии справочников у фронта нет, иначе
    следующая роль появлялась бы в редакторе только после выкатки веба. Документ
    отдаётся как лежит: у стендов с версией 1 в колонке он придёт версией 1, а фронт
    нормализует его в памяти.
    """

    document: dict[str, Any] | None
    defaults: dict[str, Any]
    roles: list[str]
    guards: list[ProcessGuard]


class ProcessSaveResponse(BaseModel):
    """`PUT .../process`: номер действующей ревизии реестра и сохранённый документ.

    Ревизия — это ревизия `registry_documents`, а не отдельный счётчик процесса: история
    процесса и есть история реестра, отдельной таблицы у неё нет. Новая строка появляется,
    только если сохранение изменило документ реестра; повтор того же документа отдаёт
    номер прежней ревизии.
    """

    revision: int
    document: dict[str, Any]


def _reject(text: str) -> ProcessError:
    return ProcessError(text)


def _label_key(value: Any) -> str | None:
    """Ключ тега из ссылки ступени: строка из `LABEL_KEYS` или `None`."""
    return value if isinstance(value, str) else None


def _label_list(step_id: str, value: Any) -> list[str]:
    """Список ключей тегов ступени: все ключи должны быть из каталога."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise _reject(SHAPE_INVALID)
    keys: list[str] = []
    for item in value:
        key = _label_key(item)
        if key is None:
            raise _reject(SHAPE_INVALID)
        if key not in LABEL_KEYS:
            raise _reject(STEP_LABEL_UNKNOWN.format(id=step_id, key=key))
        if key not in keys:
            keys.append(key)
    return keys


def _tags(value: Any, agent_codes: Sequence[str]) -> list[dict[str, Any]]:
    """Теги проекта: полный набор ключей, имена, подписи и агенты.

    Возвращает теги в порядке `LABEL_KEYS`; каждый — ровно `{key, name, title, agent}`.
    Агент проверяется только по живым кодам справочника: тег с удалённым агентом дал бы
    ступень, которую никто не берёт, и это выяснилось бы уже в конвейере.
    """
    if not isinstance(value, list):
        raise _reject(SHAPE_INVALID)
    raw_by_key: dict[str, dict[str, Any]] = {}
    for raw in value:
        if not isinstance(raw, dict):
            raise _reject(SHAPE_INVALID)
        key = raw.get("key")
        if not isinstance(key, str) or not key.strip():
            raise _reject(SHAPE_INVALID)
        key = key.strip()
        if key not in LABEL_KEYS:
            raise _reject(TAG_UNKNOWN.format(key=key))
        if key in raw_by_key:
            raise _reject(SHAPE_INVALID)
        raw_by_key[key] = raw
    missing = [key for key in LABEL_KEYS if key not in raw_by_key]
    if missing:
        # Пропущенный ключ — не «умолчание», а неполный документ: имена, подписи и агенты
        # задают все 14 ключей, и подставлять недостающие значило бы смешать два источника.
        raise _reject(SHAPE_INVALID)

    names: dict[str, str] = {}
    for key in LABEL_KEYS:
        name = raw_by_key[key].get("name")
        if not isinstance(name, str) or not name.strip():
            raise _reject(TAG_NAME_EMPTY.format(key=key))
        names[key] = name.strip()
    seen_names: set[str] = set()
    for key in LABEL_KEYS:
        if names[key] in seen_names:
            raise _reject(TAG_NAME_DUPLICATE.format(name=names[key]))
        seen_names.add(names[key])

    titles: dict[str, str] = {}
    for key in LABEL_KEYS:
        title = raw_by_key[key].get("title")
        if not isinstance(title, str) or not title.strip():
            raise _reject(TAG_TITLE_EMPTY.format(key=key))
        titles[key] = title.strip()
        if len(titles[key]) > TAG_TITLE_MAX_LENGTH:
            raise _reject(TAG_TITLE_TOO_LONG.format(key=key))

    live = set(agent_codes)
    agents: dict[str, str | None] = {}
    for key in LABEL_KEYS:
        agent = raw_by_key[key].get("agent")
        if agent is None:
            agents[key] = None
            continue
        if not isinstance(agent, str):
            raise _reject(SHAPE_INVALID)
        agent = agent.strip()
        if agent not in live:
            raise _reject(TAG_AGENT_UNKNOWN.format(code=agent))
        agents[key] = agent

    return [
        {"key": key, "name": names[key], "title": titles[key], "agent": agents[key]}
        for key in LABEL_KEYS
    ]


def _priority(step_id: str, value: Any) -> int:
    """Приоритет ступени: целое от 1 до 999. `True`/`False` — не число."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise _reject(STEP_PRIORITY_INVALID.format(id=step_id))
    if value < PRIORITY_MIN or value > PRIORITY_MAX:
        raise _reject(STEP_PRIORITY_INVALID.format(id=step_id))
    return value


def _step(raw: Any, roles: Sequence[str], seen: set[str]) -> dict[str, Any]:
    """Одна ступень: проверки в порядке таблицы отказов и канонический вид."""
    if not isinstance(raw, dict):
        raise _reject(SHAPE_INVALID)
    step_id = raw.get("id")
    if not isinstance(step_id, str) or not step_id.strip():
        raise _reject(SHAPE_INVALID)
    step_id = step_id.strip()
    when = _label_list(step_id, raw.get("when"))
    if not when:
        raise _reject(STEP_NO_WHEN.format(id=step_id))
    if step_id in seen:
        raise _reject(STEP_ID_DUPLICATE.format(id=step_id))
    seen.add(step_id)
    unless = _label_list(step_id, raw.get("unless"))
    put = _label_list(step_id, raw.get("put"))
    drop = _label_list(step_id, raw.get("drop"))
    kind = raw.get("kind", "session")
    if kind not in STEP_KINDS:
        raise _reject(STEP_KIND_UNKNOWN.format(id=step_id, kind=kind))
    role = raw.get("role")
    if role is not None:
        if not isinstance(role, str):
            raise _reject(SHAPE_INVALID)
        if role not in roles:
            raise _reject(STEP_ROLE_UNKNOWN.format(id=step_id, role=role))
    guard = raw.get("guard")
    if guard is not None:
        if not isinstance(guard, str):
            raise _reject(SHAPE_INVALID)
        if guard not in GUARD_IDS:
            raise _reject(STEP_GUARD_UNKNOWN.format(id=step_id, guard=guard))
    priority = _priority(step_id, raw.get("priority"))
    if kind == "route" and guard != ROUTE_GUARD:
        raise _reject(STEP_ROUTE_GUARD.format(id=step_id))
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise _reject(SHAPE_INVALID)
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        # Заголовок — подпись ступени в таблице; пустой он оставил бы пустую строку экрана.
        raise _reject(SHAPE_INVALID)
    return {
        "id": step_id,
        "title": title.strip(),
        "kind": kind,
        "role": role,
        "when": when,
        "unless": unless,
        "put": put,
        "drop": drop,
        "guard": guard,
        "priority": priority,
        "enabled": enabled,
    }


def _check_step_owners(steps: Sequence[dict[str, Any]], tags: Sequence[dict[str, Any]]) -> None:
    """Входящие теги ступени не могут принадлежать двум разным агентам.

    Правило то же, что у диспетчера: владелец ступени выводится из её входящих тегов.
    Если теги указывают на двух агентов, ступень не знает, кому её отдать, и сохранение
    отклоняется — иначе выдача и карточка статуса разошлись бы в толковании.
    """
    agents = {tag["key"]: tag["agent"] for tag in tags}
    for step in steps:
        owners: list[str] = []
        for key in step["when"]:
            code = agents.get(key)
            if code is not None and code not in owners:
                owners.append(code)
        if len(owners) > 1:
            raise _reject(STEP_AGENTS_CONFLICT.format(id=step["id"], a=owners[0], b=owners[1]))


def validate_process_document(
    value: Any,
    role_codes: Sequence[str],
    agent_codes: Sequence[str],
) -> dict[str, Any]:
    """Проверить документ процесса и вернуть его каноническим.

    `role_codes` — коды живых ролей справочника: ими ограничен `role` ступени, потому что
    документ с несуществующей ролью дал бы отказ при подъёме сессии уже в диспетчере.
    Исключение — резолверы `by-area` и `by-findings`: они не роли, а правила выбора.
    `agent_codes` — коды живых агентов: ими ограничен `agent` тега.
    """
    if not isinstance(value, dict):
        raise _reject(SHAPE_INVALID)
    # `True == 1` в Python: версия должна быть числом-версией, а не флагом.
    version = value.get("version")
    if isinstance(version, bool) or version != PROCESS_VERSION:
        raise _reject(VERSION_UNSUPPORTED)
    raw_tags = value.get("tags")
    raw_steps = value.get("steps")
    if not isinstance(raw_tags, list) or not isinstance(raw_steps, list):
        raise _reject(SHAPE_INVALID)
    tags = _tags(raw_tags, agent_codes)
    roles = list(role_codes) + list(ROLE_RESOLVERS)
    seen: set[str] = set()
    steps = [_step(raw, roles, seen) for raw in raw_steps]
    _check_step_owners(steps, tags)
    return {"version": PROCESS_VERSION, "tags": tags, "steps": steps}
