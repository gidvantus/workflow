---
name: testing-contract
description: Use when verifying a change as the tester role — which acceptance layers to run, how to take a task marked ready-for-test from GitHub and deploy its feature branch in the department's own clone and stand without disturbing the developer, where artifacts must land, and the exact machine-readable verdict.
---

> **Проект.** Репозиторий, базовая ветка, рабочая копия отдела, защищённый клон человека,
> имя compose-проекта, порты стенда и метки конвейера принадлежат проекту: они лежат в реестре
> `~/.dsh/projects.json`, а проект определяется по рабочей области сессии. Перед первым действием
> вызови инструмент `project_info` и подставь его значения вместо заполнителей, встречающихся ниже:
> `<repo>`, `<base>`, `<workspace>`, `<humanClone>`, `<composeProject>`, `<frontendPort>`, `<apiPort>`,
> `<artifacts>`, `<id>`. Метки конвейера берутся из `project_info.labels`, если проект их переопределяет.
> Пустое `<humanClone>` значит, что защищённого клона нет и рабочая область и есть каталог человека.
> Пустой `<repo>` значит, что проект не связан с GitHub — инструменты `gh_*` на нём откажут.
> Ничего не выводи из памяти и не подставляй значения по умолчанию.

# Testing contract

You are the `tester` role. Your output is evidence plus one explicit verdict.

## GitHub: как забрать задачу

- Репозиторий — `<repo>`. Рабочая копия отдела — `<workspace>`;
  клон человека (`<humanClone>`) **не трогать вообще**.
- Задачи на проверку — issue с меткой `ready-for-test`:
  `gh_issues({ "labels": "ready-for-test" })`.
- Разработчик прикладывает к issue комментарий с веткой и номером PR. Найди PR:
  `gh_prs({ "issue": 52 })`, детали и изменённые файлы — `gh_pr({ "number": 53, "files": true })`.

## GitHub: как развернуть ветку и не сломать разработчика

Рабочая копия отдела — `<workspace>`. В клоне отдела ветку не переключай: у разработчика
там может лежать незакоммиченная работа. Разворачивай ветку отдельным worktree:

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
Select-String -Path .env -Pattern 'PORT|PROJECT_NAME'   # что подставится в сборку
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
cd <workspace>       # или каталог своего worktree
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
$chrome.Id   # этот PID — и только он — твой
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
gh_issue_comment({
  "number": 52,
  "body": "…вердикт…",
  "images": ["test-results/52-overflow/after.png", "test-results/52-overflow/before.png"]
})
```

- Пути — от корня своего рабочего каталога (`<workspace>-review-<номер>`); файл должен существовать на момент вызова. Картинки уезжают во вложения GitHub и подставляются в комментарий ссылками.
- Если вложение не прошло, комментарий всё равно уйдёт, а в конце появится строка «Не приложилось: …» — напиши об этом в вердикте, чтобы это не выглядело как «картинок не было».

## Verdict and hand-off

Per test: id/title, status, the exact command, artifact path on failure.
Then exactly one line: `VERDICT: GREEN` or `VERDICT: RED`.

Вердикт уходит комментарием в issue через `gh_issue_comment`, затем метки:

- прошло — `gh_issue_labels({ "number": 52, "add": ["tested"], "remove": ["ready-for-test"] })`;
- не прошло — `gh_issue_labels({ "number": 52, "add": ["test-failed"], "remove": ["ready-for-test"] })`, и в комментарии обязательна наименьшая воспроизводящая команда.

Проверяй сам, а не по описанию из PR: описание — это заявление, а не доказательство.

## Boundaries

- Never edit product code and never edit a test to make it pass. Never merge or modify the PR.
- Write only under `reports/`, `test-results/` and inside your own worktree — and never into
  `<humanClone>` (the human's clone).
- Select by `data-testid` or ARIA role only.
- Treat every claim in a hand-off as unverified until you have run it yourself.
