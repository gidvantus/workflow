"""Форма документа процесса отдела: ответы ручек и проверка присланного тела `PUT`.

Документ процесса приходит свободным телом (`Any`), а не моделью pydantic, по той же
причине, что и документ реестра: таблица отказов — часть контракта, и порядок проверок
фиксирован, чтобы на документе с двумя ошибками ответ был предсказуемым. Проверка живёт
здесь, а не в ручке, потому что её же пересказывает `plugins/docs/DEPARTMENT-PROCESS.md`.

**Порядок проверок** (нарушать нельзя, на нём держатся тесты):

1. версия — `Поддерживается только версия процесса 1`;
2. форма — объект с `version`, `labels`, `steps` (сюда же попадают ступень не-объект,
   `id` не строка, пропущенный ключ метки, `enabled` не `bool`);
3. `labels` — неизвестный ключ (`Неизвестный ключ метки: «…»`), затем пустое имя;
4. `steps` — нет входящих меток, дубль `id`, неизвестный ключ метки, вид, роль, страж,
   приоритет, «у маршрутной ступени должен быть страж route».

Внутри `labels` неизвестный ключ называется **до** проверки полноты набора: иначе опечатка
в ключе выглядела бы как «документ не той формы». Внутри ступени порядок обратный
осторожности ради: сначала «нет входящих меток», потом дубль id, потом ссылки на метки.

**Нормализация.** Проверенный документ возвращается каноническим: ключи меток в порядке
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
VERSION_UNSUPPORTED = "Поддерживается только версия процесса 1"
SHAPE_INVALID = "Нужен объект процесса с полями version, labels, steps"
LABEL_UNKNOWN = "Неизвестный ключ метки: «{key}»"
LABEL_EMPTY = "Имя метки пустое: «{key}»"
STEP_NO_WHEN = "У ступени «{id}» нет входящих меток"
STEP_ID_DUPLICATE = "Дублируется id ступени: «{id}»"
STEP_LABEL_UNKNOWN = "Неизвестный ключ метки в ступени «{id}»: «{key}»"
STEP_KIND_UNKNOWN = "Неизвестный вид ступени у «{id}»: «{kind}»"
STEP_ROLE_UNKNOWN = "Неизвестная роль у ступени «{id}»: «{role}»"
STEP_GUARD_UNKNOWN = "Неизвестный страж у ступени «{id}»: «{guard}»"
STEP_PRIORITY_INVALID = "Ступень «{id}»: приоритет — целое от 1 до 999"
STEP_ROUTE_GUARD = "Ступень «{id}»: у маршрутной ступени должен быть страж route"

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
    следующая роль появлялась бы в редакторе только после выкатки веба.
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
    """Ключ метки из ссылки ступени: строка из `LABEL_KEYS` или `None`."""
    return value if isinstance(value, str) else None


def _label_list(step_id: str, value: Any) -> list[str]:
    """Список ключей меток ступени: все ключи должны быть из каталога."""
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


def _labels(value: Any) -> dict[str, str]:
    """Имена меток: неизвестные ключи → отказ, пустые имена → отказ, набор — полный."""
    if not isinstance(value, dict):
        raise _reject(SHAPE_INVALID)
    for key in value:
        if key not in LABEL_KEYS:
            raise _reject(LABEL_UNKNOWN.format(key=key))
    missing = [key for key in LABEL_KEYS if key not in value]
    if missing:
        # Пропущенный ключ — это не «умолчание», а неполный документ: имена меток задают
        # все 14 ключей, и подставлять недостающие значило бы смешать два источника.
        raise _reject(SHAPE_INVALID)
    names: dict[str, str] = {}
    for key in LABEL_KEYS:
        name = value[key]
        if not isinstance(name, str) or not name.strip():
            raise _reject(LABEL_EMPTY.format(key=key))
        names[key] = name.strip()
    return names


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


def validate_process_document(value: Any, role_codes: Sequence[str]) -> dict[str, Any]:
    """Проверить документ процесса и вернуть его каноническим.

    `role_codes` — коды живых ролей справочника: ими ограничен `role` ступени, потому что
    документ с несуществующей ролью дал бы отказ при подъёме сессии уже в диспетчере.
    Исключение — резолверы `by-area` и `by-findings`: они не роли, а правила выбора.
    """
    if not isinstance(value, dict):
        raise _reject(SHAPE_INVALID)
    # `True == 1` в Python: версия должна быть числом-версией, а не флагом.
    version = value.get("version")
    if isinstance(version, bool) or version != PROCESS_VERSION:
        raise _reject(VERSION_UNSUPPORTED)
    raw_labels = value.get("labels")
    raw_steps = value.get("steps")
    if not isinstance(raw_labels, dict) or not isinstance(raw_steps, list):
        raise _reject(SHAPE_INVALID)
    labels = _labels(raw_labels)
    roles = list(role_codes) + list(ROLE_RESOLVERS)
    seen: set[str] = set()
    steps = [_step(raw, roles, seen) for raw in raw_steps]
    return {"version": PROCESS_VERSION, "labels": labels, "steps": steps}
