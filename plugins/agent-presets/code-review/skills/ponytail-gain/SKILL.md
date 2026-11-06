---
name: ponytail-gain
description: >-
  Show ponytail's measured savings (code, cost, speed) from the benchmark.
  One-shot display. Use for "ponytail gain", "what does ponytail save",
  "ponytail impact", the `ponytail-gain` skill.
---

# Ponytail Gain

Display this scoreboard when invoked. One-shot: do NOT change mode, write flag
files, or persist anything.

The figures are the published agentic benchmark of Ponytail 5: a headless agent
run (Opus 5.5, default effort) on 39 tasks (feature tickets in a real FastAPI +
React repo, bug fixes, security and privacy cases, small apps), 5 runs each,
against the same agent without the skill. 18 of the tasks have hidden checks
for correctness and safety. Each figure is the geometric mean of the per-task
medians. They are measured, not computed from the current repo.
Source: `benchmarks/results/2026-10-07-agentic.md` and the repository README.

## Доказательства

- У каждого замечания есть `path:line`, конкретный случай («такой вход или такая ситуация приводит к такому неверному результату»), минимальная правка и цена, если её не делать.
- Нет случая — нет замечания: никакого вкуса, никаких «можно рассмотреть», никаких расплывчатых опасений.
- Перед отправкой перечитай строки и подтверди: вызывающий существует, значение правда может быть пустым, код правда не используется. Неиспользуемость проверяется грепом по всему дереву, включая тесты, фикстуры, конфиг и обращения по строке.
- Комментарий `shortcut:` (или старый `ponytail:`), называющий свой предел, — это решение, а не замечание, пока ожидаемая нагрузка не пересекает этот предел.
- Минимальная правка та, что работает, и правка, удаляющая код, лучше добавляющей: слои, фреймворки и конфиг, которых задача не требует, не появляются.
- Настоящий секрет, токен или пароль в комментарий не попадает никогда: показывай `***`, место и то, что его надо отозвать.

Особенности роли:

- Это средние по бенчмарку, а не по этому репозиторию. Никогда не печатай экономию «для этого репо» («здесь ты сэкономил X строк/токенов»): непостроенная версия никогда не существовала, вычитать не из чего.
- Единственные настоящие цифры по конкретному репозиторию даёт `ponytail-debt` (посчитанный леджер): карточка отправляет туда, а не выдумывает число.

## Отчёт и вердикт

Один отчёт на один круг работы, а не по комментарию на замечание: первая строка — заголовок роли `**Роль:** <имя> · <о чём>`, вторая — вердикт или решение, если роль его выносит, дальше — факты: что сделано, изменённые файлы, точные команды с их результатом и то, что осталось непроверенным. Прозы о процессе в отчёте нет: диспетчер и человек читают его машинно и глазами.

Render plain ASCII bars. The bar length shows ponytail as a share of the
no-skill baseline; the label carries the exact figure:

```
  ponytail gain           benchmark · 39 tasks × 5 runs · Opus 5.5

  no-skill        ████████████████████  100%
  Lines of code   █████████···········   47%   ▼ 53%
  Output tokens   ███████████·········   55%   ▼ 45%
  Cost            ███████████████·····   74%   ▼ 26%
  Time            ████████████········   59%   ▼ 41%
  Hidden checks passed   97%  (no-skill 96%)
  Tests where the logic needs one   98%  (no-skill 68%)

  This repo:  ponytail-debt  (shortcuts you deferred)
              ponytail-audit (what's still cuttable)
```

## Границы

- **Что моё:** показать карточку бенчмарка как есть — цифры, подписи, источник.
- **Чего не делаю:** не меняю режим, не пишу флаговые файлы, ничего не сохраняю, код не трогаю.
- **Если не влезает:** просят цифры по текущему репозиторию — это `ponytail-debt` и `ponytail-audit`, а не эта карточка. Прогон одноразовый.
