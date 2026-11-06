// Проверка линта канона скиллов (#46) на песочном наборе. Боевые скиллы в
// проверке не участвуют: сейчас они ещё не приведены к канону, а линт обязан
// ловить и правильный, и сломанный набор. Поэтому каждый случай строит свой
// каталог `agent-presets/` во временном каталоге и гоняет `lintSkills` по нему.
//
// Запуск: node plugins/tools/tests/skills-lint.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EXPECTED_FILES, NO_ORDER, discoverSkills, lintSkills } from '../skills-lint.mjs'

const root = path.join(os.tmpdir(), 'dsh-skills-lint-test-' + process.pid)

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) +
    (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

function assertOk(name, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + (ok || detail === undefined ? '' : ' → ' + detail))
}

// ── песочный набор ──────────────────────────────────────────────────────────

// Общие блоки — ровно те тексты, что эталон обязан нести.
const ORDER = '## Порядок работы\n\n1. Прочитать задачу.\n2. Сделать работу.\n'
const WORKCOPY = '## Рабочая копия и репозиторий\n\n- Своя копия — `<workspace>`.\n'
const BRANCH = '## Ветка и PR\n\n- Ветка от `<base>`.\n'
const STAND = '## Стенд\n\n- `docker compose -p <composeProject> up -d`.\n'
const RETURN_REVIEW = '## Возврат из ревью и из теста\n\n- Галочки в чеклисте.\n'
const RETURN_COPY = '## Возврат рабочей копии\n\n- `git checkout <base>`.\n'
const EVIDENCE = '## Доказательства\n\n- `path:line` и конкретный случай.\n'
const QUALITY = '## Планка качества\n\n- `ruff check .`\n'
const REPORT = '## Отчёт и вердикт\n\nПервая строка — заголовок роли.\n\n```\nкаркас\n```\n'
const HEADER = '## Заголовок комментария роли\n\nПервая строка — `**Роль:** <имя> · <о чём>`.\n'
const BOUNDS = '## Границы\n\n- **Что моё.** Продукт.\n- **Чего не делаю.** Чужую половину.\n' +
  '- **Если не влезает.** Комментарий в issue.\n'

const TAIL_BACKEND = 'Особенности роли:\n- Имя роли — ровно `разработчик (бэкенд)`.\n'
const TAIL_REVIEW = 'Особенности роли:\n- Имя роли — ровно `код-ревьюер`.\n'

// Тот же каркас `## Отчёт и вердикт` (заголовок и первый абзац), но своя форма
// отчёта дальше: под `### Бэкенд` у роли свой чеклист. Режим `frame` обязан это
// пропустить — иначе дословная сверка запретила бы ролям разные отчёты.
const REPORT_BODY_OTHER = '## Отчёт и вердикт\n\nПервая строка — заголовок роли.\n\n' +
  '### Бэкенд\n- [ ] Б1 · `path:line` — что не так.\n'
// А это уже другой каркас: первый абзац разъехался, и правило «первая строка —
// заголовок роли, вторая — вердикт» больше не сторожит ничего.
const REPORT_FRAME_OTHER = '## Отчёт и вердикт\n\nПервая строка — имя роли.\n\n'

function sandbox(name) {
  const skillsDir = path.join(root, name, 'agent-presets')
  const write = (rel, text) => {
    const file = path.join(skillsDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  // Файл скилла: фронтматтер плюс перечисленные разделы в переданном порядке.
  const skill = (rel, body, head) => write(rel, (head ?? '---\nname: dev-workflow\ndescription: Правила роли.\n---\n\n') + body)
  const lint = (expected) => lintSkills({ skillsDir, expected })
  return { skillsDir, write, skill, lint }
}

const texts = (result) => result.report.map((line) => line.text).join('\n')
const fails = (result) => result.report.filter((line) => !line.ok)

// ── 1. Правильный набор ─────────────────────────────────────────────────────

console.log('=== правильный набор ===')
{
  const box = sandbox('case-clean')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + WORKCOPY + '\n' + BRANCH + '\n' + STAND + '\n' + RETURN_REVIEW + '\n' +
    RETURN_COPY + '\n' + QUALITY + '\n' + REPORT + '\n' + HEADER + '\n' + TAIL_BACKEND + '\n' + BOUNDS)
  box.skill('code-review/skills/code-review/SKILL.md',
    ORDER + '\n' + EVIDENCE + '\n' + REPORT + '\n' + HEADER + '\n' + TAIL_REVIEW + '\n' + BOUNDS,
    '---\nname: code-review\ndescription: Правила ревью.\n---\n\n')
  // Карточка границ: порядка работы у неё нет по замыслу.
  box.skill('dev-backend/skills/role-boundaries/SKILL.md',
    '## Твоя половина\n\n- Пути из `tools/` и пути вида `plugins/agent-presets/…`.\n\n' +
    '## Не твоя половина\n\n- Чужие каталоги.\n\n' + QUALITY,
    '---\nname: role-boundaries\ndescription: Границы половины.\n---\n\n')
  // Исключение: справочник инструмента, спины не требует.
  box.skill('jev/skills/jev-decisions/SKILL.md', '## Когда Jev уместен\n\n- Классификация.\n',
    '---\nname: jev-decisions\ndescription: Справочник Jev.\n---\n\n')

  const result = box.lint(4)
  check('файлов проверено', result.checked, 4)
  check('нарушений нет', result.violations, 0)
  assertOk('карточка границ прошла проверку запретов', result.report.some((line) =>
    line.rel === 'dev-backend/skills/role-boundaries/SKILL.md' && /запрещённых строк нет/.test(line.text)),
  'у карточки границ проверка запретов не прошла')
  assertOk('карточке границ порядок работы не требуется', result.report.some((line) =>
    line.rel === 'dev-backend/skills/role-boundaries/SKILL.md' && /карточка границ/.test(line.text)),
  'линт не узнал карточку границ')
  assertOk('исключение названо', result.report.some((line) =>
    line.rel === 'jev/skills/jev-decisions/SKILL.md' && /исключени/.test(line.text)),
  'линт не отметил исключение')
}

// ── 2. Разъехавшийся общий блок ─────────────────────────────────────────────

console.log('\n=== разъехавшийся общий блок ===')
{
  const box = sandbox('case-diverged')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + STAND + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  box.skill('code-review/skills/code-review/SKILL.md',
    ORDER + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  // Тот же блок, но переписанный: линт обязан это увидеть.
  box.skill('dev-fullstack/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + STAND.replace('up -d', 'up -d --build') + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)

  const result = box.lint(3)
  check('одно нарушение', result.violations, 1)
  check('назван разъехавшийся блок', /общий блок «Стенд» расходится/.test(texts(result)), true)
  check('назван файл', fails(result)[0]?.rel, 'dev-fullstack/skills/dev-workflow/SKILL.md')
  assertOk('названа строка', typeof fails(result)[0]?.line === 'number' && fails(result)[0].line > 1,
    String(fails(result)[0]?.line))
}

// ── 3. Хвост «Особенности роли:» в сверку не идёт ───────────────────────────

console.log('\n=== хвост роли не ломает дословность ===')
{
  const box = sandbox('case-tail')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + HEADER + '\n' + TAIL_BACKEND + '\n' + BOUNDS)
  box.skill('code-review/skills/code-review/SKILL.md',
    ORDER + '\n' + HEADER + '\n' + TAIL_REVIEW + '\n' + BOUNDS)
  box.skill('security-review/skills/security-review/SKILL.md',
    ORDER + '\n' + HEADER + '\n' + 'Особенности роли:\n- Имя роли — ровно `безопасник`.\n\n- Своя строка.\n' + BOUNDS)

  const result = box.lint(3)
  check('разные хвосты допустимы', result.violations, 0)
}

// ── 4. Каркас «Отчёт и вердикт» ─────────────────────────────────────────────

console.log('\n=== каркас «Отчёт и вердикт» ===')
{
  const box = sandbox('case-report-frame')
  box.skill('code-review/skills/code-review/SKILL.md',
    ORDER + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  // Своя форма отчёта под тем же первым абзацем — нарушением не считается.
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + REPORT_BODY_OTHER + '\n' + HEADER + '\n' + BOUNDS)
  // Первый абзац разъехался — каркас перестал быть общим.
  box.skill('tester/skills/testing-contract/SKILL.md',
    ORDER + '\n' + REPORT_FRAME_OTHER + '\n' + HEADER + '\n' + BOUNDS)

  const result = box.lint(3)
  const text = texts(result)
  check('другое тело отчёта — не нарушение', fails(result).map((line) => line.rel),
    ['tester/skills/testing-contract/SKILL.md'])
  check('разъехавшийся каркас пойман', result.violations, 1)
  assertOk('назван блок «Отчёт и вердикт»', /общий блок «Отчёт и вердикт» расходится/.test(text), text)
}

// ── 5. Запрещённые строки ───────────────────────────────────────────────────

console.log('\n=== запрещённые строки ===')
{
  const box = sandbox('case-forbidden')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n> **Проект.** Правила лежат в реестре.\n' +
    '> **Источник и адаптация.** Поставлен.\n' +
    'Скилл ставится командой `/plugin` и `/reload-plugins`.\n' +
    'Поле `argument-hint` и Claude Code здесь не работают.\n\n' + BOUNDS)

  const result = box.lint(1)
  const text = texts(result)
  for (const label of ['> **Проект.**', '> **Источник и адаптация.**', '/plugin', '/reload-plugins',
    'argument-hint', 'Claude Code']) {
    assertOk('поймана строка `' + label + '`', text.includes('`' + label + '`'), text)
  }
  check('нарушений по числу строк', result.violations, 6)
}

// ── 6. Спина: первый раздел, порядок, хвост ─────────────────────────────────

console.log('\n=== спина ===')
{
  const box = sandbox('case-spine')
  // Эталоны на месте: проверяются поломки спины, а не отсутствие эталона.
  box.skill('dev-backend/skills/dev-workflow/SKILL.md',
    ORDER + '\n' + WORKCOPY + '\n' + STAND + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  box.skill('code-review/skills/code-review/SKILL.md',
    ORDER + '\n' + EVIDENCE + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  // Первый H2 не тот: порядок спины при этом правильный, поэтому поломка одна.
  box.skill('dev-frontend/skills/dev-workflow/SKILL.md',
    '## Введение\n\nКоротко о роли.\n\n' + ORDER + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  // Порядок спины нарушен: «Доказательства» раньше «Планки качества».
  box.skill('code-review/skills/ponytail-review/SKILL.md',
    ORDER + '\n' + QUALITY + '\n' + EVIDENCE + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS)
  // Раздел, которого нет в спине, стоит после хвоста: хвост перестал быть хвостом.
  box.skill('tester/skills/testing-contract/SKILL.md',
    ORDER + '\n' + REPORT + '\n' + HEADER + '\n' + BOUNDS + '\n## Что искать\n\n- Дыры.\n')

  const result = box.lint(5)
  const text = texts(result)
  check('пойманы три разных поломки', result.violations, 3)
  assertOk('первый H2', /первый H2 обязан быть «## Порядок работы»/.test(text), text)
  assertOk('порядок спины', /стоит после раздела, который по спине идёт позже/.test(text), text)
  assertOk('хвост', /хвост обязан быть/.test(text), text)
}

// ── 7. Фронтматтер и эталон ─────────────────────────────────────────────────

console.log('\n=== фронтматтер и эталон ===')
{
  const box = sandbox('case-head')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md', ORDER + '\n' + BOUNDS)
  // Нет description во фронтматтере.
  box.skill('code-review/skills/code-review/SKILL.md', ORDER + '\n' + BOUNDS,
    '---\nname: code-review\n---\n\n')
  // Общий блок есть, а в эталоне его нет.
  box.skill('analyst/skills/task-analysis/SKILL.md', ORDER + '\n' + EVIDENCE + '\n' + BOUNDS)

  const result = box.lint(3)
  const text = texts(result)
  check('две поломки', result.violations, 2)
  assertOk('пойман фронтматтер без description', /фронтматтер: нет description/.test(text), text)
  assertOk('пойман общий блок без эталона', /в эталоне .* такого раздела нет/.test(text), text)
}

// ── 8. Число файлов ─────────────────────────────────────────────────────────

console.log('\n=== число файлов ===')
{
  const box = sandbox('case-count')
  box.skill('dev-backend/skills/dev-workflow/SKILL.md', ORDER + '\n' + BOUNDS)
  const result = box.lint(99)
  assertOk('расхождение числа файлов — нарушение', /файлов SKILL.md 1, а канон ждёт 99/.test(texts(result)),
    texts(result))
  check('считается как нарушение', result.violations, 1)
}

// ── 9. Боевой набор ─────────────────────────────────────────────────────────

console.log('\n=== боевой набор ===')
{
  const found = discoverSkills()
  check('файлов скиллов найдено', found.length, EXPECTED_FILES)
  check('пути отсортированы', found.map((entry) => entry.rel).join('|') ===
    [...found.map((entry) => entry.rel)].sort().join('|'), true)
  const result = lintSkills()
  check('прогон по боевому набору', result.checked, EXPECTED_FILES)
  // Число нарушений зависит от того, приведены ли скиллы к канону, — эта
  // величина в тесте не фиксируется намеренно. Фиксируется только то, что каждая
  // строка отчёта называет файл и строку.
  assertOk('у каждой строки отчёта есть файл и строка', result.report.every((line) =>
    typeof line.rel === 'string' && line.rel.length > 0 && Number.isInteger(line.line) && line.line > 0),
  'в отчёте есть строка без файла или строки')
}

fs.rmSync(root, { recursive: true, force: true })
console.log('')
if (failures > 0) {
  console.log('ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
  process.exit(1)
}
console.log('ВСЕ ПРОВЕРКИ ПРОШЛИ')
