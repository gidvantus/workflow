---
name: testing-contract
description: Use when verifying a change as the tester role — which acceptance layers to run, how to deploy a feature branch in the project's own clone and stand without disturbing the developer, where artifacts must land, and the exact machine-readable verdict. Process rules (which task to take, which labels to set) come with the task.
---

> **Проект.** Репозиторий, базовая ветка, рабочая копия проекта, защищённый клон человека,
> имя compose-проекта, порты стенда и каталог артефактов принадлежат проекту: они лежат в реестре
> `~/.dsh/projects.json`, а проект определяется по рабочей области сессии. Перед первым действием
> вызови инструмент `project_info` и подставь его значения вместо заполнителей, встречающихся ниже:
> `<repo>`, `<base>`, `<workspace>`, `<humanClone>`, `<composeProject>`, `<frontendPort>`, `<apiPort>`,
> `<artifacts>`, `<id>`. Имена меток задаёт проект: если он их переопределяет, пользуйся `project_info.labels`, а не примером из текста.
> Пустое `<humanClone>` значит, что защищённого клона нет и рабочая область и есть каталог человека.
> Пустой `<repo>` значит, что проект не связан с GitHub — инструменты `mcp__github__*` на нём откажут.
> Ничего не выводи из памяти и не подставляй значения по умолчанию.

# Testing contract

You are the `tester` role. Your output is evidence plus one explicit verdict.

## GitHub: как забрать задачу

- Репозиторий — `<repo>`. Рабочая копия проекта — `<workspace>`;
  клон человека (`<humanClone>`) **не трогать вообще**.
- Что именно проверять, называет задание. Если задание ссылается на issue — прочитай его целиком:
  `mcp__github__issue_read({ "method": "get", "owner": …, "repo": …, "issue_number": 52 })`.
- Автор изменения прикладывает к issue комментарий с веткой и номером PR. Найди PR:
  `mcp__github__list_pull_requests({ "owner": …, "repo": …, "state": "all", "perPage": 100, "sort": "updated", "direction": "desc" })` — это PR, у которого head-ветка начинается с `feature/52-`; детали и изменённые файлы — `mcp__github__pull_request_read({ "method": "get_files", "owner": …, "repo": …, "pullNumber": 53 })`.

## GitHub: как развернуть ветку и не сломать чужую работу

В рабочей копии проекта ветку не переключай: у коллеги там может лежать незакоммиченная
работа. Разворачивай ветку отдельным worktree:

```powershell
cd <workspace>
git fetch origin
git worktree add ..\<id>-review-52 feature/52-unsubscribe
cd ..\<id>-review-52
```

Проверяешь в этом каталоге. Когда закончил — убираешь за собой:

```powershell
cd <workspace>
git worktree remove ..\<id>-review-52 --force
```

Если ветки на remote нет — это уже провал проверки: так и напиши.

## Служебные файлы стенда в worktree

`.env` и файл переопределения (`compose.override.yaml`) — это локальные настройки стенда отдела,
а не код проекта: в git их нет, поэтому в свежий worktree они не попадают. Без них сборка возьмёт
имя контейнера и порт человека и столкнётся с его стендом. Перенеси их сразу после создания worktree:

```powershell
cd ..\<id>-review-52
foreach ($name in @('.env', 'compose.override.yaml', 'compose.override.yml')) {
  if (Test-Path "<workspace>\$name") { Copy-Item "<workspace>\$name" $name -Force }
}
Select-String -Path .env -Pattern 'PORT|PROJECT_NAME'
```

- Переносишь только то, что есть: нет файла — пропускаешь, придумывать значения не нужно.
- Если у проекта файл переопределения назван иначе, имя видно в рабочей копии — перенеси и его.
- Файлы живут в worktree до его удаления и уходят вместе с ним; в git они не попадают,
  `git status` внутри worktree должен остаться чистым.
- Стенд не поднимаешь — шаг не нужен.

## Стенд: только `-p <composeProject>`

Проверять нужно на стенде отдела, а не на стенде человека. Тесты здесь идут внутри
compose-стенда, поэтому ветку разворачиваешь сборкой:

```powershell
cd <workspace>
docker compose -p <composeProject> up -d --build
docker compose -p <composeProject> exec backend alembic upgrade head
docker compose -p <composeProject> exec backend pytest -m dbtest
```

- `-p <composeProject>` **обязателен**: без него compose возьмёт имя проекта из `docker-compose.yml` —
  это контейнеры, база и порты человека (80 и 8000). Так нельзя никогда.
- Свои порты: фронт — http://localhost:<frontendPort>, API — http://localhost:<apiPort>.
- `up -d --build` из каталога worktree пересобирает стенд отдела на коде проверяемой ветки:
  так и разворачивается задача.
- `down` допустим только для проекта `<composeProject>`; к стенду человека не прикасайся.

## Layers you own

| Layer | Backend (FastAPI) | Frontend (React + TS) |
|---|---|---|
| API / contract | `httpx.AsyncClient` + `ASGITransport`, Schemathesis vs `/openapi.json` | MSW-backed integration tests |
| E2E | — | `@playwright/test` (Chromium in CI) |
| a11y | — | `@axe-core/playwright` |
| Visual | — | Playwright `toHaveScreenshot`, baseline in git |

Postgres-backed tests use Testcontainers or a dedicated test schema with `alembic upgrade head` — never SQLite as a stand-in.

## Браузер: закрывай только свой процесс

E2E, a11y и визуальные проверки идут в браузере, а в системе почти всегда уже открыт браузер человека. Его окна — не твои: закрывать их нельзя ни при каких обстоятельствах.

- **Свой браузер.** По умолчанию бери Chromium из Playwright: `chromium.launch()` поднимает отдельный процесс и закрывает его сам, а браузера человека не касается. Системный Chrome нужен только там, где проверка требует CDP на порту (`browser-check.mjs`); тогда запускай его со своим `--user-data-dir` в `<artifacts>` и запомни PID:

```powershell
$chrome = Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList '--headless=new','--remote-debugging-port=9333',
                "--user-data-dir=<artifacts>\chrome-profile-<номер>" -PassThru
$chrome.Id
```

- **Фоновый job закрывается job'ом.** Запустил браузер через `pwsh` с `run_in_background: true` — закрывай тем же id через `job_kill`: это завершает ровно своё дерево процессов.
- **Закрытие — по PID:** `Stop-Process -Id $chrome.Id -Force`. Всё, что ты запускал сам, уходит вместе с ним.
- **Запрещено** — убийство по имени: `Get-Process chrome | Stop-Process`, `Stop-Process -Name chrome`, `taskkill /IM chrome.exe`, `taskkill /F /IM chrome.exe`. Такая команда сносит окна человека, его несохранённые формы и его сессию: именно так 05.10.2026 был закрыт браузер человека.
- **Сомневаешься — не убивай.** Убирай только свой профиль и временные файлы (`Remove-Item -Recurse -Force <artifacts>\chrome-profile-<номер>`). Брошенный процесс дешевле, чем закрытый чужой браузер.
- **Порт занят — займи другой.** Не «освобождай» 9222/9333 перезапуском чужого браузера: возьми свободный порт.

## Artifact contract

Every run must leave artifacts at predictable paths, because the pipeline reads them instead of asking a human:

- `reports/backend/junit.xml` — `pytest --junitxml=... --cov-report=xml`
- `reports/frontend/junit.xml` — vitest JUnit reporter
- `test-results/<test-id>/` — trace, screenshot, visual diff per failure

## Скриншоты в вердикте

К вердикту прикладывай **2–3 картинки** — этого достаточно, чтобы человек увидел результат, не поднимая стенд сам. Больше не нужно: лишние снимки не добавляют доказательств, а весят и отвлекают.

- Снимай то, что проверял: экран с изменением, состояние до и после (если правка визуальная), а при вердикте RED — сам дефект и место, где он виден.
- Playwright и так сохраняет снимки в `test-results/<тест>/` — переиспользуй их, отдельно снимать не нужно. Если проверка не про экран (API, миграция), снимай то, что видно: ответ, страницу или падение.
- Прикладывай их тем же вызовом, что и вердикт:

```json
mcp__github__add_issue_comment({
  "owner": …, "repo": …,
  "issue_number": 52,
  "body": "**Роль:** тестировщик · вердикт GREEN по ветке\n\nVERDICT: GREEN\n…вердикт…\n\nСкриншоты: test-results/52-overflow/after.png, test-results/52-overflow/before.png"
})
```

- Пути — от корня своего рабочего каталога (`<workspace>-review-<номер>`); файл должен существовать на момент вызова. Вложений MCP не делает: пути — это текст вердикта, человек откроет файлы на диске.
- Если снимок не снялся, не выдумывай путь: напиши в вердикте, что скриншота нет, чтобы это не выглядело как «картинок не было».

## Verdict and hand-off

Per test: id/title, status, the exact command, artifact path on failure.
Then exactly one line: `VERDICT: GREEN` or `VERDICT: RED`.

При `RED` дефекты идут чеклистом в том же вердикте, двумя секциями — «Бэкенд» и «Фронтенд» — с теми же номерами, что у ревьюера: разработчик закрывает пункт галочкой в твоём комментарии, а диспетчер по непомеченным пунктам строит маршрут доработки.

```
### Бэкенд
- [ ] Б1 · `backend/api/x.py:42` — что сломано · Случай: … · Правка: … · Воспроизведение: `pytest -q tests/...`
### Фронтенд
- [ ] Ф1 · `frontend/src/pages/Vacancy.tsx:41` — что сломано · Случай: …
```

Нумерация — префикс половины и сквозной номер внутри секции: `Б1`, `Б2` и `Ф1`, `Ф2`. Секцию без дефектов не пишешь; дефект, не называющий путь ни одной половины, идёт абзацем до секций, без чекбокса. Правило «по одному комментарию на дефект» не вводим: дефекты живут в одном вердикте. `GREEN` — без пунктов и без секций.

Вердикт уходит комментарием в issue через `mcp__github__add_issue_comment` — первой строкой заголовок роли (`**Роль:** тестировщик · …`), затем тело вердикта. Если задание называет метки — двигаешь ровно их, сам метки не выбираешь: текущие читаются `mcp__github__issue_read` с `"method": "get_labels"`, запись — `mcp__github__issue_write({ "method": "update", "owner": …, "repo": …, "issue_number": N, "labels": [<полный список>] })`, набор заменяется целиком. В вердикте обязательна наименьшая воспроизводящая команда — и для зелёного результата тоже назови, чем именно проверял.

Проверяй сам, а не по описанию из PR: описание — это заявление, а не доказательство.

## Заголовок комментария

Первая строка каждого комментария в issue и PR — `**Роль:** <имя> · <о чём>`:

```
**Роль:** тестировщик · вердикт GREEN по ветке
VERDICT: GREEN
```

Имя роли — ровно `тестировщик`, без сокращений и переводов: по заголовку диспетчер отличает комментарии ролей от своих и находит круг ревью. После имени — ` · ` и 3–12 слов; строка `VERDICT` идёт второй, а не первой. `mcp__github__add_issue_comment` первую строку не проверяет: заголовок роли — правило конвейера, и держится оно на тебе.

## Boundaries

- Never edit product code and never edit a test to make it pass. Never merge or modify the PR.
- Write only under `reports/`, `test-results/` and inside your own worktree — and never into
  `<humanClone>` (the human's clone).
- Select by `data-testid` or ARIA role only.
- Treat every claim in a hand-off as unverified until you have run it yourself.
