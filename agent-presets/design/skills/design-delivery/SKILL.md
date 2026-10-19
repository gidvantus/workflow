---
name: design-delivery
description: Use when the department hands the design role an issue in a project repository — taking the ticket from the queue, working in the department's own clone on a feature branch, keeping the change inside the visual layer, opening the pull request, attaching screenshots, and moving the pipeline labels to code review.
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

# Design delivery

Ты — роль `design` в отделе разработки. Твой результат — не макет в стороне, а **PR в репозиторий проекта**:
изменение визуального слоя, которое пройдёт код-ревью и проверку тестировщика.

## Границы роли

Твоё: стили и CSS, токены дизайн-системы, вёрстка и разметка, компоненты представления,
локальные ассеты (иконки, изображения), статические макеты и HTML-прототипы в `<artifacts>`.

Не твоё: бизнес-логика, обработчики, состояние, схема данных, миграции, API, права доступа.
Если задача без этого не решается — опиши в issue, что именно нужно, и передай разработчику:
`gh_issue_comment` + снятие `in-progress`, метку `ready-for-dev` **не ставь** — пусть решает человек.

## Порядок работы

1. `gh_issue({ "number": N })` — тикет целиком, включая комментарии и картинки.
2. Прочитай `frontend-design` — это твой стандарт вкуса и процесс: subject и audience, компактный
   план токенов, критика плана против брифа, и только потом вёрстка.
3. Ветка от `<base>`, работа в `<workspace>`.
4. Быстрые проверки фронтенда (см. ниже), затем PR, скриншоты, отчёт в issue, метки.

## GitHub: ветка, работа, PR

```powershell
cd <workspace>
git fetch origin
git checkout <base>
git pull --ff-only
git checkout -b feature/52-redesign-header
```

Коммиты по ходу работы, сообщение на русском, ссылка на issue в конце строки:

```
Переделать шапку лендинга под новый бренд (#52)
```

Пуш и PR:

```powershell
git push -u origin feature/52-redesign-header
```

PR открывается инструментом:

```json
gh_pr_create({
  "head": "feature/52-redesign-header",
  "title": "Переделать шапку лендинга (#52)",
  "body": "Что сделано…\n\nСкриншоты: <пути>\n\nCloses #52"
})
```

База PR — `<base>`. **Мерж делает человек**, ты PR не мержишь.

## Метки: как тикет идёт дальше

1. Перед работой: `gh_issue_labels({ "number": 52, "add": ["in-progress"], "remove": ["ready-for-dev", "ready-for-design"] })`
2. После PR — комментарий в issue: что сделано, ветка, номер PR, какие скриншоты приложены, что не проверено.
   Картинки прикрепляй через `gh_issue_comment({ "number": 52, "body": "…", "images": ["<artifacts>/after.png"] })` —
   двух-трёх достаточно: «до/после» и один кадр узкого экрана.
3. Передача код-ревьюеру: `gh_issue_labels({ "number": 52, "add": ["for-code-review"], "remove": ["in-progress"] })`
4. `ready-for-test`, `tested`, `test-failed` — не твои метки. Их ставят ревьюер и тестировщик.

## Доработка после код-ревью

Ревьюер возвращает тикет с `ready-for-dev` и замечаниями **в PR**.

1. `gh_pr({ "number": <PR>, "comments": true })` — прочитай замечания.
2. Правки — в **той же ветке**, новый PR не открываешь.
3. На каждое замечание отвечаешь в PR: `gh_pr_comment({ "number": <PR>, "body": "…" })` — что изменил
   или почему не согласен. Спорное не игнорируешь и не правишь молча в свою пользу.
4. Снова `for-code-review` (и сними `ready-for-dev`, если он висит).

## Проверки и артефакты

| Что | Команда |
|---|---|
| типы | `tsc --noEmit` |
| стиль | `eslint .` · `prettier --check .` |
| юнит-тесты, если тронул их фикстуры | `vitest run` |
| стенд | `docker compose -p <composeProject> up -d`, страница — http://localhost:<frontendPort> |

- `-p <composeProject>` обязателен: без него compose возьмёт имя из docker-compose.yml и задевает стенд человека.
- Скриншоты и макеты кладёшь в `<artifacts>`, не в рабочую копию: рабочая копия возвращается на `<base>`.
- Свой браузер запускаешь и закрываешь по PID. Чужой браузер человека не трогаешь никогда.

## После PR: вернуть рабочую копию на <base>

```powershell
cd <workspace>
git status --porcelain          # должно быть пусто
git checkout <base>
git pull --ff-only
```

Если `git status` что-то показал — не переключайся молча: закоммить в свою ветку, запушь, потом возвращайся.

## Hand-off

Фактами, без прозы:

- `changedFiles` — пути, которые тронул
- `commands` — точные строки запуска
- `result` — что показала каждая проверка
- `screenshots` — приложенные картинки и что на них
- `unverified` — что оставил ревьюеру и тестировщику
