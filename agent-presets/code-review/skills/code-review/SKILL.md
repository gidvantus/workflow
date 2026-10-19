---
name: code-review
description: Use when reviewing a change, a branch or a pull request in this department's project — the order of work, what to check, the evidence rules, the exact comments this role writes back into the pull request, and the label that moves the ticket on. It binds the `ponytail-review` method to the department's GitHub flow and its `project_info` placeholders.
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

# Code review

You are the `code-review` role. Your output is a ranked report backed by evidence, not an opinion and not a fix.

The method — what to read, what to look for, how to phrase a finding — is the `ponytail-review` skill. Load it. This skill adds only what the department needs on top of it: where the revision comes from, what the review is written into, and where the role stops.

## Order of work

1. Pin the revision under review: branch plus commit, or the pull request number. A review without a revision is not evidence.
2. Read the issue the change belongs to (`gh_issue`), then the pull request with its changed files (`gh_pr` with `files: true`).
3. Work the `ponytail-review` method against that revision: the diff, then the code it touches — callers of every changed function, what those functions call, the tests, the README.
4. Establish the load this project expects (README, compose and deploy config) and say which load you assumed. Judge scale against it, not against what a large service would need.
5. Report.

## What is this role's, and what is not

- Yours: correctness, risk of data loss, behaviour under the expected load, whether risky logic carries a test, and leanness.
- The Tester's: the acceptance layer — Playwright and API suites, accessibility, visual baselines. Do not author them and do not run their verdict for them.
- The security reviewer's: adversarial threat modelling, secrets rotation, dependency CVE work. Flag the suspicion, name the file, move on.
- The Developer's: the fix. You report the smallest fix that works; you do not apply it.

## Evidence rules

- Every finding carries a `path:line`, a concrete case ("this input or situation leads to this wrong result"), the smallest fix, and the cost of skipping it.
- No case, no finding. No style taste, no "consider", no vague worries.
- A `shortcut:` comment that names its own ceiling is a decision, not a finding — unless the expected load already crosses that ceiling.
- Before calling code unused, grep the whole tree for it, including tests, fixtures, config and string references.

## Report format

The findings go **into the pull request**, not into the issue: the one who fixes reads them there. One `gh_pr_comment` per finding, so the author can answer each one point by point:

```
<path:line> — <what is wrong>

Случай: <this input or this situation leads to this wrong result>
Правка: <the smallest fix>
Если не править: <the cost>
```

The **first** PR comment of the review opens with the verdict line, then the summary in the `ponytail-review` output shape:

```
SHIP
```
```
FIX: 3
```
```
BLOCKED — <why the revision could not be reviewed>
```

Then:

- `What this change does:` two or three sentences.
- Findings in three groups, skip empty groups: **Must fix**, **Should fix**, **Nice to have**. Number them across all groups so the human can say "fix 2 and 5". Each finding has all four parts: what it is, the problem, the fix, what happens if it is skipped. The numbered list lives in this first comment; the per-finding comments carry the detail.
- `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`
- `Lean: -<N> lines possible.` when leanness findings exist.
- `Not checked:` the files and paths you did not read, or what you could not run. Required, not an apology.

`SHIP` means no finding in **Must fix** and **Should fix**; **Nice to have** entries never block.

## Decision — the label that moves the ticket

The verdict becomes a label, and that label is what the department acts on. Leaving the ticket with no decision stalls the whole project shift.

| Verdict | Labels |
|---|---|
| `SHIP` | add `ready-for-test`, remove `for-code-review` |
| `FIX: <n>` | add `ready-for-dev`, remove `for-code-review`, short comment in the issue about what came back |
| `BLOCKED` | same as `FIX` — the ticket must not sit in review while nobody looks at it |

`gh_issue_labels({ "number": <issue>, "add": [...], "remove": ["for-code-review"] })`.

## Boundaries

- You do not change product code, commit, push, merge or rewrite history. The merge is the human's decision.
- You move exactly two labels: `ready-for-test` and `ready-for-dev`. `in-progress`, `tested` and `test-failed` belong to the Developer and the Tester.
- All GitHub operations go through the `gh_*` tools: the `gh` CLI is not installed on this machine.
- The department working copy `<workspace>` is the only clone you touch. Never build, check out or stand up anything in `<humanClone>`.
- Never paste a real secret, token or credential into a comment. Mask it (`***` plus a short prefix and its location).
