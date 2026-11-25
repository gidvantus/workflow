"""Процесс отдела разработки по умолчанию: теги, ступени конвейера, стражи.

Процесс отдела — документ `{"version": 2, "tags": [...], "steps": [...]}`, который лежит
в колонке `departments.process`. `NULL` в колонке значит «своего процесса у отдела нет»:
диспетчер исполняет ровно эту таблицу, поэтому до первой правки в вебе конвейер работает
как раньше — на зашитом графе.

**Теги вместо имён.** До версии 2 имена меток лежали словарём `labels`; теперь на каждый
из 14 фиксированных ключей заведён тег `{key, name, title, agent}`. `name` — метка на
GitHub, `title` — подпись для глаза, `agent` — код агента, который забирает ступень
(или `null` — «её берёт диспетчер»). Ступень по-прежнему ссылается на **ключ**, поэтому
переименование тега не трогает таблицу ступеней.

**Почему копия, а не файл.** Образ `api` собирается из `app/backend`, диспетчер — из
`plugins/`: файл репозитория не читает ни один из них, а собирать документ из чужого
дерева на старте контейнера значило бы поставить работу отдела в зависимость от того, что
смонтировано. Копия вторая и это осознанная плата: расхождение двух копий видно в
`dev_department_status` полем `process.source` и в тесте на 13 ступеней.

**Ступень.** `id` (строка, уникальна), `title`, `kind` (`session` — поднимается сессия
роли, `route` — только маршрут по постановке, `auto` — только метки), `role` (`null`, код
роли, `by-area` — резолвер `implementer()`, `by-findings` — резолвер `roleForRework()`),
`when` (≥1 ключ тега), `unless`, `put`, `drop` (0..14 ключей), `guard` (`null` или id
стража из `GUARDS`), `priority` (1..999), `enabled`.

Лимитов (`maxAttempts`, `maxRework`, `stuckAfterMinutes`) в документе нет: они уже живут на
отделе и в общих настройках, и второй источник тех же чисел запрещён постановкой.

**Приоритет** — номер строки таблицы с шагом 60: 1, 61, … 721. Шаг оставлен для вставки
новой ступени между любыми двумя без перенумерации соседей.
"""

import copy
from typing import Any

# Версия формата документа. Поддерживается только вторая: первая читается диспетчером
# ради стендов с сохранённым процессом, но веб пишет всегда вторую.
PROCESS_VERSION = 2

# Ключи тегов — 14 штук, порядок фиксирован: он же порядок справочника тегов на экране
# «Процесс» и порядок тегов в документе. Ступень ссылается на **ключ**, поэтому
# переименование тега — правка `tags`, а не ступеней.
LABEL_KEYS: tuple[str, ...] = (
    "mockup",
    "mockupsReady",
    "progress",
    "dev",
    "frontend",
    "phaseFrontend",
    "review",
    "test",
    "ok",
    "failed",
    "merged",
    "areaBackend",
    "areaFrontend",
    "areaFullstack",
)

# Имена тегов по умолчанию: те же метки, что у зашитого графа диспетчера. Проект может
# переопределить любое из них в вебе; ступени при этом не меняются.
DEFAULT_LABELS: dict[str, str] = {
    "mockup": "needs-mockup",
    "mockupsReady": "mockups-ready",
    "progress": "in-progress",
    "dev": "ready-for-dev",
    "frontend": "ready-for-frontend",
    "phaseFrontend": "phase:frontend",
    "review": "for-code-review",
    "test": "ready-for-test",
    "ok": "tested",
    "failed": "test-failed",
    "merged": "merged",
    "areaBackend": "area:backend",
    "areaFrontend": "area:frontend",
    "areaFullstack": "area:fullstack",
}

# Подписи тегов для глаза: до версии 2 жили во фронте (`LABEL_TITLES`), теперь приходят
# с сервера и лежат в документе процесса — иначе экран и процессы разошлись бы.
DEFAULT_LABEL_TITLES: dict[str, str] = {
    "dev": "К разработке",
    "frontend": "Фронтенд",
    "areaBackend": "Половина: бэкенд",
    "areaFrontend": "Половина: фронтенд",
    "areaFullstack": "Половина: полный стек",
    "phaseFrontend": "Фаза фронтенда",
    "mockup": "Нужен макет",
    "mockupsReady": "Макет готов",
    "progress": "В работе",
    "review": "На код-ревью",
    "test": "На тестирование",
    "ok": "Проверено",
    "failed": "Тест не прошёл",
    "merged": "Слито",
}

# Вид ступени: что она делает, когда её условия выполнены.
STEP_KINDS: tuple[str, ...] = ("session", "route", "auto")

# Роли-резолверы: половину работы и владельца замечаний решает код, а не документ.
ROLE_BY_AREA = "by-area"
ROLE_BY_FINDINGS = "by-findings"
ROLE_RESOLVERS: tuple[str, ...] = (ROLE_BY_AREA, ROLE_BY_FINDINGS)

# Каталог стражей: `(id, заголовок)`. Страж — это код, а не данные: документ выбирает
# страж по id, написать новый в редакторе нельзя. Порядок — порядок таблицы «Стражи»
# в `plugins/docs/DEPARTMENT-PROCESS.md`.
GUARDS: tuple[tuple[str, str], ...] = (
    ("route", "Маршрут"),
    ("mockup-stage", "Макет"),
    ("dispatch", "Выдача"),
    ("no-code", "Есть что ревьюить"),
    ("same-head", "Та же ревизия"),
    ("checklist-gate", "Чеклист прошлого круга"),
    ("merged-already", "PR уже слит"),
)

GUARD_IDS: tuple[str, ...] = tuple(guard_id for guard_id, _ in GUARDS)

# Приоритет ступени: целое от 1 до 999. Верхняя граница держит редактируемое поле ввода
# в разумных рамках, нижняя — не даёт поставить ступень «раньше первой».
PRIORITY_MIN = 1
PRIORITY_MAX = 999

# Сколько ключей меток можно поставить в одно поле ступени: больше, чем ключей, не бывает.
LABELS_MAX = len(LABEL_KEYS)


def _step(
    priority: int,
    step_id: str,
    title: str,
    when: tuple[str, ...],
    *,
    kind: str = "session",
    role: str | None = None,
    unless: tuple[str, ...] = (),
    put: tuple[str, ...] = (),
    drop: tuple[str, ...] = (),
    guard: str | None = None,
    enabled: bool = True,
) -> dict[str, Any]:
    """Одна ступень документа: все ключи контракта, пустые — пустыми списками."""
    return {
        "id": step_id,
        "title": title,
        "kind": kind,
        "role": role,
        "when": list(when),
        "unless": list(unless),
        "put": list(put),
        "drop": list(drop),
        "guard": guard,
        "priority": priority,
        "enabled": enabled,
    }


# Ступени по умолчанию — сегодняшний конвейер строка в строку: порядок строк таблицы
# §4.5 `plugins/docs/DEPARTMENT-PROCESS.md` и есть порядок `priority`. Порядок ветвлений
# диспетчера (макет → маршрут → передача фронтенду → ревью → тест → слияние → доработка →
# выдача) сохранён: ступень макета идёт первой, потому что постановка первична, а выдача
# задачи — последней.
DEFAULT_STEPS: tuple[dict[str, Any], ...] = (
    _step(
        1,
        "mockup",
        "Макет постановки",
        ("mockup",),
        role="design",
        unless=("mockupsReady",),
        put=("progress",),
        guard="mockup-stage",
    ),
    _step(
        61,
        "route",
        "Маршрут по постановке",
        ("dev",),
        kind="route",
        unless=(
            "progress",
            "review",
            "test",
            "ok",
            "failed",
            "areaBackend",
            "areaFrontend",
            "areaFullstack",
        ),
        guard="route",
    ),
    _step(
        121,
        "handoff-frontend",
        "Передача фронтенду",
        ("test", "areaFullstack"),
        kind="auto",
        unless=("phaseFrontend",),
        put=("frontend",),
        drop=("test",),
    ),
    _step(
        181,
        "review",
        "Код-ревью",
        ("review",),
        role="code-review",
        guard="no-code",
    ),
    _step(
        241,
        "test",
        "Тестирование",
        ("test",),
        role="tester",
    ),
    _step(
        301,
        "merge",
        "Слияние",
        ("ok",),
        role="devops-delivery",
        guard="merged-already",
    ),
    _step(
        361,
        "rework-test",
        "Доработка после тестировщика",
        ("failed",),
        role=ROLE_BY_FINDINGS,
        put=("progress",),
        drop=("failed",),
        guard="dispatch",
    ),
    _step(
        421,
        "dev-backend",
        "Бэкенд",
        ("dev", "areaBackend"),
        role="dev-backend",
        unless=("progress", "review", "test", "ok", "failed"),
        put=("progress",),
        drop=("dev",),
        guard="dispatch",
    ),
    _step(
        481,
        "dev-frontend",
        "Фронтенд",
        ("dev", "areaFrontend"),
        role="dev-frontend",
        unless=("progress", "review", "test", "ok", "failed"),
        put=("progress",),
        drop=("dev",),
        guard="dispatch",
    ),
    _step(
        541,
        "dev-fullstack-backend",
        "Полный стек: бэкенд",
        ("dev", "areaFullstack"),
        role="dev-backend",
        unless=("progress", "review", "test", "ok", "failed"),
        put=("progress",),
        drop=("dev",),
        guard="dispatch",
    ),
    _step(
        601,
        "dev-fullstack-frontend",
        "Полный стек: фронтенд",
        ("frontend",),
        role="dev-frontend",
        unless=("progress", "review", "test", "ok", "failed"),
        put=("progress", "phaseFrontend"),
        drop=("frontend",),
        guard="dispatch",
    ),
    _step(
        661,
        "dev-fullstack-default",
        "Полный стек без маршрута",
        ("dev",),
        role="dev-fullstack",
        unless=("progress", "review", "test", "ok", "failed"),
        put=("progress",),
        drop=("dev",),
        guard="dispatch",
    ),
    _step(
        721,
        "continue",
        "Продолжение взятой работы",
        ("progress",),
        role=ROLE_BY_AREA,
        guard="dispatch",
    ),
)


def default_process() -> dict[str, Any]:
    """Документ процесса по умолчанию: новый словарь на каждый вызов.

    Копия, а не ссылка на константы: ответ ручки и «Сбросить к умолчанию» на экране
    отдают документ наружу, и правка пришедшего объекта не должна менять образец.

    Теги собираются в порядке `LABEL_KEYS`, у каждого агент `null` — «ступень берёт
    диспетчер». Состав тегов фиксирован: ключи — семантика конвейера, их нельзя
    добавить или убрать из веба.
    """
    return {
        "version": PROCESS_VERSION,
        "tags": [
            {
                "key": key,
                "name": DEFAULT_LABELS[key],
                "title": DEFAULT_LABEL_TITLES[key],
                "agent": None,
            }
            for key in LABEL_KEYS
        ],
        "steps": copy.deepcopy(list(DEFAULT_STEPS)),
    }
