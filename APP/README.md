# APP — каркас приложения

Минимальный стенд из трёх сервисов, который поднимается одной командой:

| Сервис | Что это | Порт на хосте |
|---|---|---|
| `db` | PostgreSQL 16 | не публикуется, доступен только внутри compose-сети |
| `api` | FastAPI на Python 3.12 (uvicorn) | `API_PORT`, по умолчанию `8096` |
| `web` | React на Vite под nginx, проксирует `/api/` в `api` | `FRONTEND_PORT`, по умолчанию `8095` |

Сервис `web` собирается из `frontend/`; исходники фронтенда добавляет вторая половина
задачи. До её слияния собираются и проверяются `db` и `api`:

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
docker-compose -p workflow-agent exec api alembic current   # 0001_init (head)
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
│   └── tests/           # pytest
└── frontend/            # React + Vite + nginx
```

## API

Единственная ручка каркаса — `GET /api/health`.

```json
200 {"status":"ok","db":"ok","version":"0.1.0"}
503 {"status":"degraded","db":"fail","version":"0.1.0","message":"База данных недоступна"}
```

`503` — это контракт, а не сбой: база проверяется запросом `SELECT 1` с таймаутом
подключения 2 с, недоступность базы не роняет процесс и не даёт 500. Текст поля
`message` показывается пользователю дословно.

Полная схема — в `/openapi.json` и `/docs` того же сервиса.

## Проверки в контейнере

```bash
docker-compose -p workflow-agent exec api ruff check .
docker-compose -p workflow-agent exec api ruff format --check .
docker-compose -p workflow-agent exec api mypy .
docker-compose -p workflow-agent exec api pytest
```

Юнит-тесты базы не требуют: проверка БД в них подменяется заглушкой.

## Миграции

Схему ведёт alembic, ревизии лежат в `backend/alembic/versions/`. Применяются самим
`api` на старте (`alembic upgrade head`), вручную — так:

```bash
docker-compose -p workflow-agent exec api alembic upgrade head
docker-compose -p workflow-agent exec api alembic downgrade -1
```

Строка подключения в `alembic.ini` пустая: её подставляет `alembic/env.py` из
`DATABASE_URL`.
