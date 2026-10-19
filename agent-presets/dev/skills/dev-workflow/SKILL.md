---
name: dev-workflow
description: Use when implementing or fixing product code in this project — choosing the fast feedback commands, taking a GitHub issue, branch and PR conventions, returning the department working copy to the base branch, respecting the dev/code-review/tester role split, answering review findings in the PR, and preparing a hand-off the Code Review agent can approve.
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

# Developer workflow

You are the `dev` role. Your output is a working change plus the evidence that the cheap layers pass.

## Order of work

1. Read the issue and the surrounding code before writing any. Prefer an existing helper over a new one.
2. Make the smallest change that satisfies the task.
3. Run the fast layers, fix, repeat.
4. Commit, push, open the PR, report in the issue, hand off to the code reviewer.
5. Вернуть рабочую копию на `<base>`, чтобы следующая задача ветвилась от чистого основания.

## GitHub: репозиторий и ветки

- Репозиторий — `<repo>`.

**Твоя рабочая копия — `<workspace>`.** Это отдельный клон отдела со своим стендом.
Клон человека (`<humanClone>`) **не трогать вообще**: ни собирать, ни
переключать в нём ветки, ни поднимать в нём стенд.
- Базовая ветка — **`<base>`**. В `<base>` и `main` коммитить нельзя никогда.
- Ветка задачи — `feature/<номер>-<краткий-слаг>`, например `feature/52-unsubscribe`.

```powershell
cd <workspace>
git fetch origin
git checkout <base>
git pull --ff-only
git checkout -b feature/52-unsubscribe
```

Коммиты делай по ходу работы, сообщение на русском, ссылка на issue в конце строки:

```
Сделать страницу отписки от рассылки (#52)
```

Пуш и PR:

```powershell
git push -u origin feature/52-unsubscribe
```

Затем открываешь PR инструментом (не командой — `gh` CLI в системе нет):

```json
gh_pr_create({
  "head": "feature/52-unsubscribe",
  "title": "Отписка от рассылки (#52)",
  "body": "Что сделано…\n\nКак проверять:…\n\nCloses #52"
})
```

База PR — `<base>` по умолчанию. **Мерж PR делает человек.** Ты PR не мержишь и не переводишь из черновика.

## GitHub: отчёт и передача на код-ревью

1. `gh_issue({ "number": 52 })` — прочитать задачу целиком, включая комментарии, если они там есть.
2. Перед началом работы:
   `gh_issue_labels({ "number": 52, "add": ["in-progress"], "remove": ["ready-for-dev"] })`
3. После PR — комментарий в issue через `gh_issue_comment`: что сделано, ветка, номер PR, что осталось непроверенным.
4. Передача код-ревьюеру:
   `gh_issue_labels({ "number": 52, "add": ["for-code-review"], "remove": ["in-progress"] })`

Метки-контракт: `ready-for-dev` → `in-progress` → `for-code-review` → `ready-for-test` → `tested` / `test-failed`.
Ставить чужие метки (`ready-for-test`, `tested`, `test-failed`) — не твоя работа: `ready-for-test` ставит код-ревьюер, когда принимает код.

## Доработка после код-ревью

Ревьюер возвращает тикет с меткой `ready-for-dev` и замечаниями **в PR**, а не в issue.
Порядок:

1. Читаешь замечания: `gh_pr({ "number": <номер PR>, "comments": true })` и комментарии issue.
2. Правки делаешь **в той же ветке** `feature/<номер>-<слаг>` — новый PR не открываешь.
3. Коммитишь, пушишь, отвечаешь в PR на каждое замечание: что изменил или почему не согласен.
4. Короткий комментарий в issue о том, что доработано, и снова `for-code-review` (снять `ready-for-dev`, если он ещё висит).

Спорное замечание не игнорируешь и не правишь молча в свою пользу: отвечаешь аргументом в PR, решение остаётся за ревьюером и человеком.

## После работы: вернуть рабочую копию на <base>

Рабочая копия отдела — `<workspace>`, одна на обе роли. Оставлять её на feature-ветке
нельзя: следующая задача должна начинаться от чистого основания, иначе новая ветка унаследует
чужие коммиты и в PR попадут лишние изменения.

```powershell
cd <workspace>
git status --porcelain          # должно быть пусто
git checkout <base>
git pull --ff-only
```

Порядок важен: сначала проверяешь чистоту, потом переключаешься.

- Если `git status --porcelain` что-то показал — **не переключайся молча**. Закоммить изменения в свою feature-ветку, запушь их и только потом возвращайся на `<base>`. Если изменения к задаче не относятся — напиши об этом в issue.
- Возврат делается **после** PR и после комментария в issue: отправной точкой для ревью и тестирования остаётся feature-ветка на remote, а не локальная копия.
- Свою feature-ветку после мержа PR удаляет человек, не ты.
- Тестировщик работает в отдельном `git worktree` от этого же клона и ветку в нём не переключает.

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
- Тома и контейнеры стенда человека не трогай — это стенд человека.

## Commands by layer

| Layer | Backend (FastAPI) | Frontend (React + TS) |
|---|---|---|
| Static | `ruff check .` · `ruff format --check .` · `mypy .` | `tsc --noEmit` · `eslint .` · `prettier --check .` |
| Unit | `pytest -q` | `vitest run` |

Run these through `pwsh`. Report non-zero exits verbatim; never summarize a failure away.

## Hand-off contract

Report facts, not prose:

- `changedFiles` — paths you touched
- `commands` — the exact command lines you ran
- `result` — observed status per command
- `unverified` — what you deliberately left to the Code Review and Tester agents

## Boundaries

- Do not write Playwright E2E, visual baselines, or a11y reports — the `tester` role owns those.
- Do not approve your own work: `ready-for-test` ставит код-ревьюер, `tested` — тестировщик.
- Do not modify a test to make it pass. A failing test is information.
- Add `data-testid` to anything a test will select. Positional CSS chains are forbidden here.
- Never commit directly to `<base>` or `main`, and never merge a PR yourself.
- Never leave the department working copy on a feature branch: after each task it goes back to `<base>`. Never touch `<humanClone>` (the human's clone).
