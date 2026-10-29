# APP — приложение «Проекты»

Стенд из трёх сервисов, который поднимается одной командой: экран «Проекты» (список,
создание, правка и мягкое удаление) и его API.

| Сервис | Что это | Порт на хосте |
|---|---|---|
| `db` | PostgreSQL 16 | не публикуется, доступен только внутри compose-сети |
| `api` | FastAPI на Python 3.12 (uvicorn) | `API_PORT`, по умолчанию `8096` |
| `web` | React на Vite под nginx, проксирует `/api/` в `api` | `FRONTEND_PORT`, по умолчанию `8095` |

Поднимать можно и по частям — например, только базу с API:

```bash
docker-compose -p workflow-agent up -d --build db api
```

## Как поднять

```bash
cd APP
docker-compose up -d --build
```

Именно `docker-compose`, а не `docker compose`: на этой машине плагин не работает
(`docker: unknown command: docker compose`), работает отдельный `docker-compose.exe`.

Первая сборка тянет pip и npm — это несколько минут. Дальше слои переиспользуются.

Проверки:

```bash
docker-compose -p workflow-agent ps                     # db healthy, api и web Up
curl.exe -s http://localhost:8096/api/health            # напрямую в api
curl.exe -s http://localhost:8095/api/health            # через nginx
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8095/   # страница отдаётся, 200
docker-compose -p workflow-agent exec api alembic current   # 0002_projects (head)
docker-compose -p workflow-agent exec web nginx -t          # конфиг nginx валиден
```

Остановить стенд, сохранив данные базы:

```bash
docker-compose -p workflow-agent stop
```

Снести вместе с томом базы:

```bash
docker-compose -p workflow-agent down -v
```

## Настройки и второй стенд

Значения по умолчанию лежат в `.env.example`; `.env` — личная копия, он в git не едет:

```bash
copy .env.example .env      # Windows
cp .env.example .env        # bash
```

Имя compose-проекта и порты у каждого стенда **свои**. Второй стенд того же
compose-файла (например клон человека) с общими значениями пересоздаст чужие
контейнеры и займёт чужие порты — ему в `.env` нужны, например,
`COMPOSE_PROJECT_NAME=workflow-local`, `FRONTEND_PORT=8091`, `API_PORT=8092`.

Секретов в репозитории нет: в `.env.example` только локальные заглушки.

## Что где лежит

```
APP/
├── docker-compose.yml   # db + api + web, том pgdata
├── .env.example         # настройки стенда: база, имя проекта, порты
├── backend/             # FastAPI
│   ├── Dockerfile       # python:3.12-slim, CMD — alembic upgrade head && uvicorn
│   ├── pyproject.toml   # зависимости + настройки ruff/mypy/pytest
│   ├── alembic.ini      # конфиг миграций, URL берётся из DATABASE_URL
│   ├── alembic/         # env.py и ревизии (0001_init — пустая стартовая)
│   ├── app/             # config.py, db.py, main.py — приложение
│   │   ├── models/      # ORM-модели (Project)
│   │   ├── schemas/     # pydantic-схемы запросов и ответов
│   │   └── api/         # роутеры (health, projects)
│   └── tests/           # pytest
└── frontend/            # React + Vite + nginx
    ├── Dockerfile       # node:22-alpine (deps → build) → nginx:1.27-alpine
    ├── nginx.conf       # SPA try_files + прокси /api/ на api:8000
    ├── package.json     # react, react-dom, vite, typescript
    └── src/             # main.tsx, App.tsx, index.css
        ├── api/         # клиент API проектов (projects.ts)
        └── components/  # ProjectList, ProjectFormDialog, ConfirmDialog, Dialog
```

## Маршрут по каталогам

Каталог `app/` не входит ни в одну половину работы из реестра проекта (`areas`:
backend = `tools/`, frontend = `agent-presets/`, `docs/`, `profiles/`). Постановка #32
называла файлы обеих половин (`.py` и `.tsx`/`.css`), поэтому маршрут был
`area:fullstack` с двумя ступенями: сначала бэкенд, затем фронтенд.

| Ступень | Где лежит | Что это |
|---|---|---|
| бэкенд | `app/backend/` | `models/`, `schemas/`, `api/`, миграции, тесты |
| фронтенд | `app/frontend/src/` | `api/`, `components/`, `App.tsx`, `index.css` |
| шов | `app/README.md` | описание ручек, экрана и soft delete |

Остальное в репозитории (`tools/`, `plugins/`, `profiles/`, `agent-presets/`, `docs/`,
`sync.mjs`) — не часть приложения `app/` и в задаче #32 не менялось.

## API

Пять ручек: `GET /api/health` и четыре ручки проектов.

### Живость сервиса

`GET /api/health` — единственная ручка каркаса.

```json
200 {"status":"ok","db":"ok","version":"0.1.0"}
503 {"status":"degraded","db":"fail","version":"0.1.0","message":"База данных недоступна"}
```

`503` — это контракт, а не сбой: база проверяется запросом `SELECT 1` с таймаутом
подключения 2 с, недоступность базы не роняет процесс и не даёт 500. Текст поля
`message` показывается пользователю дословно.

### Проекты

| Метод и путь | Тело запроса | Успех |
|---|---|---|
| `GET /api/projects` | нет | `200 [{id, name, description, repo_url, created_at, updated_at}]` — только живые, порядок по `id` |
| `POST /api/projects` | `{name, repo_url, description?}` | `201` тот же объект |
| `PATCH /api/projects/{id}` | любое непустое подмножество `{name, description, repo_url}` | `200` тот же объект |
| `DELETE /api/projects/{id}` | нет | `204` без тела (мягкое удаление) |

Отказы — часть контракта: экран показывает их текст дословно и своих формулировок не
добавляет.

| Код | `detail` | Когда |
|---|---|---|
| `409` | `Проект с таким названием уже есть` | имя занято живым проектом (сравнение без учёта регистра) |
| `404` | `Проект не найден` | проекта нет или он уже удалён — в том числе для `PATCH` |
| `422` | `Укажите название проекта` | имя пустое после `strip()` |
| `422` | `Название длиннее 200 символов` | имя длиннее 200 символов |
| `422` | `Укажите адрес репозитория` | адрес пустой после `strip()` |
| `422` | `Адрес репозитория должен быть ссылкой или вида owner/repo` | адрес не подходит под формат или длиннее 500 символов |
| `422` | `Описание длиннее 2000 символов` | описание длиннее 2000 символов |
| `422` | `Нет полей для изменения` | `PATCH` с пустым телом |

Остальные отказы (`5xx`, `422` от невалидного JSON) контрактом не считаются.

**Soft delete.** `DELETE` не удаляет строку: он ставит `deleted_at = now()`, и строка
остаётся в таблице `projects` навсегда. В списке её больше нет, повторный `DELETE` и
`PATCH` по ней отвечают `404`, восстановить проект через интерфейс нельзя. Имя
удалённого проекта свободно — его можно занять заново. Физического удаления строк в
приложении нет, и очистки таблицы в задаче тоже нет: она растёт, политики хранения
пока не существует.

Полная схема — в `/openapi.json` и `/docs` того же сервиса.

## Экран «Проекты»

Одна страница: оболочка с меню (единственный раздел «Проекты»), шапка с крошками,
заголовок «Проекты» с кнопкой «Добавить проект», карточка списка, полоса состояния
сервиса под ней и подвал. Макет — `mockups/32/` в ветке задачи.

- Список читается с сервера: `GET /api/projects` относительным путём, запрос
  проксирует nginx на том же origin, поэтому CORS не нужен. Адрес API в коде не
  зашит — его задаёт окружение стенда.
- Каждая строка: название, описание (пустое описание — пустая строка, без заглушки),
  адрес репозитория моноширинным, дата обновления и действия под кнопкой «⋯» —
  «Изменить» и «Удалить».
- Одно окно на создание и правку: «Название», «Описание», «Адрес репозитория»,
  «Сохранить» и «Отмена»; `role="dialog"`, `aria-modal`, Esc и подложка закрывают
  окно, Tab удерживается внутри, фокус возвращается на кнопку, которая окно открыла.
- Удаление — подтверждение с названием проекта; во время запроса кнопки неактивны.
- После создания, правки и удаления список перечитывается с сервера. Оптимистичных
  обновлений нет: на экране только то, что вернул сервер.

| Что видно | Когда |
|---|---|
| `Загрузка…` | список читается |
| `Пока нет проектов` | сервер вернул пустой массив |
| текст отказа и кнопка `Повторить` | список не загрузился |
| `Сохраняю…`, кнопки неактивны | запрос формы в полёте, окно открыто |
| текст отказа дословно из `detail` | `409`/`422` при сохранении, окно открыто |
| `Удаляю…`, кнопки неактивны | запрос удаления в полёте |
| текст отказа дословно из `detail` | ошибка удаления, в окне подтверждения |
| `Сервер не отвечает` | api недоступен: сеть, остановленный контейнер, прокси |

Панель состояния сервиса переехала под список, но её контракт прежний: кнопка
«Проверить» делает `GET /api/health` относительным путём, строка состояния показывает
ответ, ошибка — дословный `message`.

| Что видно | Когда |
|---|---|
| строка состояния «не проверено» | до первой проверки |
| кнопка неактивна, текст «Проверяю…» | запрос в полёте |
| строка состояния `API: ok · БД: ok` | ответ `200`, блок ошибки не отрисован |
| блок ошибки с текстом `message` дословно | ответ `503` (база недоступна) |
| блок ошибки «Сервер не отвечает» | api недоступен: контейнер остановлен, сеть, прокси |

Элементы для тестов помечены `data-testid`: `app-status`, `app-check`, `app-error`,
`projects-list`, `projects-state`, `projects-empty`, `projects-retry`, `project-error`,
`project-create`, `project-item`, `project-item-name`, `project-item-description`,
`project-edit`, `project-delete`, `project-form`, `project-form-name`,
`project-form-description`, `project-form-repo`, `project-form-submit`,
`project-form-cancel`, `project-form-error`, `project-delete-confirm`,
`project-delete-confirm-submit`, `project-delete-confirm-cancel`,
`project-delete-confirm-error`. Своих тестов и линтеров у фронтенда в этой задаче нет;
типы проверяет `tsc --noEmit` внутри `npm run build`, то есть при сборке образа `web`.

Пересобрать только фронтенд после правок:

```bash
docker-compose -p workflow-agent up -d --build web
```

## Проверки в контейнере

```bash
docker-compose -p workflow-agent exec api ruff check .
docker-compose -p workflow-agent exec api ruff format --check .
docker-compose -p workflow-agent exec api mypy .
docker-compose -p workflow-agent exec api pytest
```

Юнит-тесты живой PostgreSQL не требуют: `tests/test_health.py` подменяет проверку БД
заглушкой, `tests/test_projects.py` подменяет сессию на SQLite в памяти через
`dependency_overrides`.

## Миграции

Схему ведёт alembic, ревизии лежат в `backend/alembic/versions/`. Применяются самим
`api` на старте (`alembic upgrade head`), вручную — так:

```bash
docker-compose -p workflow-agent exec api alembic upgrade head
docker-compose -p workflow-agent exec api alembic downgrade -1
```

Строка подключения в `alembic.ini` пустая: её подставляет `alembic/env.py` из
`DATABASE_URL`.
