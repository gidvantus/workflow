---
name: dev-workflow
description: Use when implementing or fixing product code in this project — choosing the fast feedback commands, sizing the change, committing a readable history, running the stand without touching anyone else's, and preparing a hand-off with the files, commands and unverified parts. Process rules (branch, labels, PR, final step) are not here: they come with the task.
---

> **Проект.** Репозиторий, базовая ветка, рабочая копия, защищённый клон человека,
> имя compose-проекта, порты стенда и каталог артефактов принадлежат проекту: они лежат в реестре
> `~/.dsh/projects.json`, а проект определяется по рабочей области сессии. Перед первым действием
> вызови инструмент `project_info` и подставь его значения вместо заполнителей, встречающихся ниже:
> `<repo>`, `<base>`, `<workspace>`, `<humanClone>`, `<composeProject>`, `<frontendPort>`, `<apiPort>`,
> `<artifacts>`, `<id>`.
> Пустое `<humanClone>` значит, что защищённого клона нет и рабочая область и есть каталог человека.
> Пустой `<repo>` значит, что проект не связан с GitHub — инструменты `gh_*` на нём откажут.
> Ничего не выводи из памяти и не подставляй значения по умолчанию.

# Developer workflow

You are the `dev-backend` role — the backend half of the developer work. Your output is a working change plus the evidence that the cheap layers pass.

## Order of work

1. Read the task and the surrounding code before writing any. Prefer an existing helper over a new one.
2. Make the smallest change that satisfies the task.
3. Run the fast layers, fix, repeat.
4. Leave the repository in a state another person can verify: a readable history and a report that names the files, the commands and what is still unverified.

## Репозиторий и рабочая копия

- Репозиторий — `<repo>`, базовая ветка — `<base>`.
- **Твоя рабочая копия — `<workspace>`.** Клон человека (`<humanClone>`) **не трогать вообще**: ни собирать, ни переключать в нём ветки, ни поднимать в нём стенд.
- В `<base>` и `main` коммитить нельзя никогда.
- Если копия занята чужой незакоммиченной работой, не переключай ветку поверх неё и не делай `reset`: сообщи об этом в отчёте.

Коммиты делай по ходу работы; сообщение на русском, по существу изменения:

```
Сделать страницу отписки от рассылки (#52)
```

## Ветка и PR — когда задание их просит

Без задания ветку не создаёшь и PR не открываешь. Если задание просит ветку и PR, обычный порядок такой:

```powershell
cd <workspace>
git fetch origin
git checkout <base>
git pull --ff-only
git checkout -b feature/52-unsubscribe
```

Пуш и PR — инструментом, не командой (`gh` CLI в системе нет):

```json
gh_pr_create({
  "head": "feature/52-unsubscribe",
  "title": "Отписка от рассылки (#52)",
  "body": "Что сделано…\n\nКак проверять:…\n\nCloses #52"
})
```

**PR не мержишь** и из черновика не переводишь, если задание не говорит иное. Замечания ревьюера читаешь через `gh_pr({ "number": <номер PR>, "comments": true })`, отвечаешь на каждое в том же PR: что изменил или почему не согласен. Спорное замечание не игнорируешь и не правишь молча в свою пользу — отвечаешь аргументом.

### Тело PR — часть отчёта

Тело PR приводится в соответствие с диффом **до** метки `for-code-review`, а не после замечания. Порядок обязательный:

1. прочитать текущее тело: `gh_pr({ "number": N })` — тело приходит в поле `body`;
2. передать прочитанное тело с правкой: `gh_pr_edit({ "number": N, "body": "<прочитанное тело с правкой>" })`.

Тело передаётся **целиком**: разделы, которые не меняешь, переносишь как есть — правка «по памяти» их потеряет. `gh_pr_edit` меняет только `title` и/или `body`, и хотя бы одно из полей должно быть передано, иначе инструмент отказывает до сетевого запроса. Метки, состояние и мерж он не трогает и трогать не должен.

Замечание ревьюера «тело PR описывает прежнюю ревизию» закрывается правкой тела тем же `gh_pr_edit`, а не ответным комментарием: `gh_pr_comment` пишет в обсуждение, тело PR он не меняет, и замечание таким ответом не закрывается.

## Возврат рабочей копии

Если задание требует вернуть копию на `<base>` — сначала проверь чистоту, потом переключайся:

```powershell
cd <workspace>
git status --porcelain
git checkout <base>
git pull --ff-only
```

Если `git status --porcelain` что-то показал — **не переключайся молча**: закоммить изменения в свою ветку и запушь их. Коммиты, не относящиеся к задаче, упомяни в отчёте.

## Стенд: только свой и только со своим именем проекта

Тесты и проверки в этом проекте идут **внутри compose-стенда** (`docker compose exec backend pytest`),
поэтому стенд нужно поднимать — но свой, а не чужой:

```powershell
cd <workspace>
docker compose -p <composeProject> up -d --build
docker compose -p <composeProject> exec backend pytest -m "not dbtest"
docker compose -p <composeProject> ps
```

- `-p <composeProject>` **обязателен**. Без него compose возьмёт имя проекта из `docker-compose.yml`,
  и это будет стенд человека: его контейнеры, его база `pgdata`, его порты человека. Так нельзя никогда.
- Свои порты: фронт — http://localhost:<frontendPort>, API — http://localhost:<apiPort>.
- Своя база — в отдельном томе `<composeProject>_pgdata`; данные человека не затрагиваются.
- Первый `up --build` в свежем клоне собирает образы: это долго, зато один раз.

## Commands by layer

| Layer | Backend (FastAPI) | Frontend (React + TS) |
|---|---|---|
| Static | `ruff check .` · `ruff format --check .` · `mypy .` | `tsc --noEmit` · `eslint .` · `prettier --check .` |
| Unit | `pytest -q` | `vitest run` |

Run these through `pwsh`. Report non-zero exits verbatim; never summarize a failure away.

## Заголовок комментария

Первая строка каждого комментария в issue и PR — `**Роль:** <имя> · <о чём>`:

```
**Роль:** разработчик (бэкенд) · что сделано и что не проверено
```

Имя роли — ровно `разработчик (бэкенд)`, без сокращений и переводов: по заголовку диспетчер отличает комментарии ролей от своих и находит круг ревью. После имени — ` · ` и 3–12 слов о том, зачем комментарий. `gh_issue_comment` и `gh_pr_comment` проверяют первую строку **до** сетевого запроса: тело без заголовка не уходит, а в ошибке приходит образец строки.

## Hand-off contract

Report facts, not prose:

- `changedFiles` — paths you touched
- `commands` — the exact command lines you ran
- `result` — observed status per command
- `unverified` — what you deliberately left unchecked

## Boundaries

- Do not write Playwright E2E, visual baselines, or a11y reports — the `tester` role owns those.
- Do not approve your own work: a green run of your own tests is evidence, not acceptance.
- Do not modify a test to make it pass. A failing test is information.
- Add `data-testid` to anything a test will select. Positional CSS chains are forbidden here.
- Never commit directly to `<base>` or `main`, and never merge a PR yourself unless the task says so.
- Never touch `<humanClone>` (the human's clone).
