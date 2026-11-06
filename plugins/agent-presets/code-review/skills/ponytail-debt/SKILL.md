---
name: ponytail-debt
description: >-
  List every `shortcut:` comment (and older `ponytail:` ones) as a debt ledger. One-shot report,
  changes nothing. Use for "ponytail debt", "what did ponytail defer", "list the
  shortcuts", the `ponytail-debt` skill.
---

Every deliberate ponytail shortcut is marked with a `shortcut:` comment naming
its ceiling and upgrade path (older code may say `ponytail:`). This collects them into one ledger so a deferral
can't quietly become permanent.

## Порядок работы

Grep the repo for comment markers, skipping `.git` and everything the
`.gitignore` files ignore (dependencies, build output, caches, in any stack):

`git grep --no-index --exclude-standard -nE '(#|//|/[*]) ?(shortcut|ponytail):'`  (add other comment prefixes if your stack uses them)

If the user names their own marker word (`ponytail debt TODO`), grep for that word instead.

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger. Skip hits that are not a deferral, like a note
about a keyboard shortcut.

## Отчёт и вердикт

Один отчёт на один круг работы, а не по комментарию на замечание: первая строка — заголовок роли `**Роль:** <имя> · <о чём>`, вторая — вердикт или решение, если роль его выносит, дальше — факты: что сделано, изменённые файлы, точные команды с их результатом и то, что осталось непроверенным. Прозы о процессе в отчёте нет: диспетчер и человек читают его машинно и глазами.

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `shortcut: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? add
`git blame -L<line>,<line>`.

Flag the rot risk: any marker comment that names no upgrade path or
trigger gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No shortcut debt. Clean ledger.`

## Границы

- **Что моё:** леджер `shortcut:`-маркеров — строки `<file>:<line>`, предел, триггер пересмотра и пометка `no-trigger`.
- **Чего не делаю:** не правлю код и не ставлю маркеры сам, не чиню найденные долги; по умолчанию ничего не пишу на диск.
- **Если не влезает:** просят сохранить леджер файлом — спрашиваю и пишу его отдельным файлом (например `PONYTAIL-DEBT.md`), правок в коде это не касается. Прогон одноразовый.
