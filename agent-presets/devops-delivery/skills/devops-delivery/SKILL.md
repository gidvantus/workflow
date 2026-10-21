---
name: devops-delivery
description: Use when changing the build, the CI/CD pipeline, the Docker or compose setup, the release and rollback procedure, the runtime configuration or the observability of this project — including the exact commands, the stand isolation rules, how to merge a pull request when asked, and the delivery hand-off format.
---

> **Проект.** Репозиторий, базовая ветка, рабочая копия проекта, защищённый клон человека,
> имя compose-проекта, порты стенда и каталог артефактов принадлежат проекту: они лежат в реестре
> `~/.dsh/projects.json`, а проект определяется по рабочей области сессии. Перед первым действием
> вызови инструмент `project_info` и подставь его значения вместо заполнителей, встречающихся ниже:
> `<repo>`, `<base>`, `<workspace>`, `<humanClone>`, `<composeProject>`, `<frontendPort>`, `<apiPort>`,
> `<artifacts>`, `<id>`. Имена меток задаёт проект: если он их переопределяет, пользуйся `project_info.labels`, а не примером из текста.
> Пустое `<humanClone>` значит, что защищённого клона нет и рабочая область и есть каталог человека.
> Пустой `<repo>` значит, что проект не связан с GitHub — инструменты `gh_*` на нём откажут.
> Ничего не выводи из памяти и не подставляй значения по умолчанию.

# DevOps delivery

You are the `devops-delivery` role. Your output is automation that behaves the same way twice, plus the rollback for it.

## Order of work

1. Read the issue and the current pipeline and container configuration before writing anything. Extend an existing workflow or job before adding a parallel one.
2. Make the smallest change that reaches the goal, and keep it runnable locally.
3. Run the same commands CI runs, locally, and fix until they pass.
4. Open the PR into `<base>` with the rollback step in the description.
5. Report in the issue and return the working copy to `<base>`.

## CI/CD

- One workflow per concern (checks, build, release); keep the check workflow fast and required on pull requests.
- Pin every action to at least a major tag (`actions/checkout@v4`), never a floating branch.
- Declare `permissions:` per workflow and job: `contents: read` by default, `packages: write` only where an image is pushed.
- Cache only what is safe — dependency caches keyed by the lockfile, never secrets or artefacts you cannot reproduce.
- Fail loudly: no `continue-on-error` and no `|| true` around the checks the other roles depend on.
- Use `concurrency` to cancel superseded runs, so an older commit cannot deploy over a newer one.
- Never interpolate untrusted input (`github.event.*`, PR titles or branch names) straight into a `run:` step — pass it through `env:`.

## Containers

- Multi-stage builds; the runtime stage carries no build tooling, no dev dependencies and no tests.
- Pin base images (`python:3.12-slim`, `node:20-slim`), never `latest`.
- Non-root `USER`, an explicit `HEALTHCHECK`, and a `.dockerignore` that excludes `.git`, secrets, caches and virtualenvs.
- The stand runs as `docker compose -p <composeProject> -f <file> ...`, with healthchecks and `depends_on: condition: service_healthy` instead of sleep loops.
- Configuration comes from the environment (an env file that is not committed). One image must be promotable between environments unchanged.

## Release and rollback

- `<base>` is the integration branch and `main` is what the human deploys. You never push to either: changes reach `<base>` through a pull request, and `main` stays the human's lane entirely.
- Every deployable change states its rollback: the previous image tag, or the reversal steps for the migration.
- Migrations are forward-only and backward-compatible for one release, run before the new code, and never combined with a destructive schema change in the same release.
- After a deploy, verify that the health endpoint and the build identifier actually report the new revision.

## Слияние pull request — когда его поручили

Слияние — отдельная операция, а не завершение любой работы. Делаешь его, только когда задание прямо просит слить конкретный PR.

1. Прочитай изменение: `gh_pr({ "number": <PR>, "files": true })`. Если в задании есть вердикт проверки, сверься с ним; красный вердикт при поручении слить — противоречие, о нём сообщаешь и останавливаешься.
2. Метод — merge-коммит: история этих репозиториев ведётся строками «Merge pull request #N from …», squash её сломал бы.
3. Конфликт с базой не форсируешь: называешь конфликтующие файлы и возвращаешь задачу тому, кто её поставил.
4. Перед слиянием убери артефакты постановки: если в ветке PR есть каталог `mockups/<номер>/`, удали его отдельным коммитом, который остаётся в истории, но не попадает в `<base>`:

   ```powershell
   git -C <workspace> fetch origin
   git -C <workspace> checkout feature/<номер>-<слаг>
   git -C <workspace> pull --ff-only
   git -C <workspace> rm -r mockups/<номер>
   git -C <workspace> commit -m "Убрать макеты постановки (#<номер>)"
   git -C <workspace> push
   ```

   Макеты — часть постановки: задачу слили, значит визуальные референсы в дереве больше не нужны, а копиться они не должны. Нет каталога — шаг пропускаешь: ничего не создаёшь и не коммитишь.
5. После слияния ветку задачи удаляешь — она уже в базе.
6. Рабочую копию возвращаешь на `<base>`: `git checkout <base>`, `git pull --ff-only`.

Свои собственные PR, сделанные в этой же роли, не мержишь: их мержит человек.

## Configuration and secrets

- Secrets live in CI secrets or the host environment — never in the repository, a compose file, an image layer or a log line.
- On suspicion of a leak: report the location and the rotation the human must perform. Do not rewrite git history or force-push.
- Document every environment variable the service needs, with its default and whether it is required.

## Observability and runbooks

- Structured logs with a request id; never log tokens, passwords or personal data.
- A health endpoint that checks real dependencies, and one metric that would show the service is degraded.
- For every recurring failure, a short runbook: symptom, first check, likely cause, fix, escalation.

## Safety rails

- Always `docker compose -p <own project>`; without `-p` you touch the human's stand (the human's own stand). Never `compose down -v` outside your own project.
- No destructive host maintenance as part of a task: no `docker system prune -a`, no volume deletion.

## Hand-off

Report the changed files, the exact commands with their observed result, the rollback for this change, and what you did NOT verify.
