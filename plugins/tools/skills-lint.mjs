// Механическая проверка канона скиллов ролей: спина из 11 разделов, одинаковые
// общие блоки, отсутствие мета-врезок.
//
//   node plugins/tools/skills-lint.mjs
//
// Зачем линт, а не глаза ревьюера. Восемнадцать файлов
// `plugins/agent-presets/<роль>/skills/<скилл>/SKILL.md` пишут разные роли и
// разные руки. Канон (`plugins/docs/SKILLS-CANON.md`) называет разделы спины и
// правило «общий блок копируется дословно», но сам ничего не проверяет: проверить
// дословность может только код, который читает файлы. Отсюда этот скрипт: он
// ничего не пишет и ничего не чинит, а называет файл, строку и что именно не так.
//
// Контракт (по нему же правятся сами файлы):
//
//   1. У каждого файла есть фронтматтер с непустыми `name` и `description`.
//   2. Первый H2 — `## Порядок работы`. Два исключения: файлы из `EXEMPT` (спина
//      им не нужна) и карточки границ из `NO_ORDER` — у них порядка работы нет по
//      замыслу, разделы описывают границу, а не шаги.
//   3. Последние H2 — `## Отчёт и вердикт`, `## Заголовок комментария роли`,
//      `## Границы` в этом порядке; каких-то из них в файле нет — проверяются
//      только те, что есть.
//   4. Общий блок совпадает дословно с эталоном (`COMMON_BLOCKS`). Эталон —
//      живой файл набора, а не копия в этом скрипте: копия разъехалась бы с
//      оригиналом молча. Хвост `Особенности роли:` в сверку не идёт — это как раз
//      то место, где роли разрешено отличаться.
//   5. Нет запрещённых строк: врезки `> **Проект.**` и
//      `> **Источник и адаптация.**`, упоминания Claude Code (`/plugin`,
//      `/reload-plugins`, `argument-hint`, `Claude Code`), которых в этом harness
//      нет.
//   6. Порядок спины: индексы встреченных разделов спины возрастают.
//
// Пустой список файлов — отказ (exit 1), а не успех: «проверено 0 из 18» не
// должно выглядеть как «канон соблюдён».
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Каталог скиллов в рабочей копии: `plugins/agent-presets`. */
const PRESETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-presets')

/** Сколько файлов `SKILL.md` в наборе. Число задаёт канон, а не подсчёт на глаз. */
export const EXPECTED_FILES = 18

/**
 * Спина: 11 имён в жёстком порядке. В файле стоит только то подмножество,
 * которое роли нужно, но относительный порядок обязан сохраняться.
 */
export const SPINE = [
  'Порядок работы',
  'Рабочая копия и репозиторий',
  'Ветка и PR',
  'Стенд',
  'Возврат из ревью и из теста',
  'Возврат рабочей копии',
  'Доказательства',
  'Планка качества',
  'Отчёт и вердикт',
  'Заголовок комментария роли',
  'Границы',
]

/** Последние разделы файла — в этом порядке, но только те, что в файле есть. */
export const TAIL = ['Отчёт и вердикт', 'Заголовок комментария роли', 'Границы']

/**
 * Исключения из правила спины: справочник инструмента и карточки. Спина им не
 * нужна, но запреты и общие блоки, если они есть, действуют.
 */
export const EXEMPT = [
  'jev/skills/jev-decisions/SKILL.md',
  'code-review/skills/ponytail-help/SKILL.md',
  'code-review/skills/ponytail-gain/SKILL.md',
]

/**
 * Карточки границ: у них нет шагов работы, поэтому `## Порядок работы` не
 * требуется и первым H2 считаться не обязан. Это не исключение из спины:
 * `## Планка качества` у них есть и сверяется по общим правилам.
 */
export const NO_ORDER = [
  'dev-backend/skills/role-boundaries/SKILL.md',
  'dev-frontend/skills/role-boundaries/SKILL.md',
]

/** Эталон для блоков рабочего процесса — рабочая копия, ветка, стенд, возвраты. */
const WORKFLOW_REF = 'dev-backend/skills/dev-workflow/SKILL.md'

/** Эталон для блоков отчёта — доказательства, заголовок роли, каркас отчёта. */
const REVIEW_REF = 'code-review/skills/code-review/SKILL.md'

/**
 * Общие блоки: имя раздела → эталон и режим сверки.
 *
 * `full` — весь раздел дословно, без хвоста `Особенности роли:`.
 * `frame` — только каркас: заголовок и первый абзац. У `## Отчёт и вердикт`
 *   первым абзацем идёт правило «первая строка — заголовок роли, вторая —
 *   вердикт», а дальше у каждой роли своя форма отчёта (сводка и чеклист у
 *   ревьюера, факты и команды у разработчика, артефакты у тестировщика) — сверять
 *   её дословно значит запретить ролям разные отчёты.
 */
export const COMMON_BLOCKS = {
  'Рабочая копия и репозиторий': { ref: WORKFLOW_REF, mode: 'full' },
  'Ветка и PR': { ref: WORKFLOW_REF, mode: 'full' },
  'Стенд': { ref: WORKFLOW_REF, mode: 'full' },
  'Возврат из ревью и из теста': { ref: WORKFLOW_REF, mode: 'full' },
  'Возврат рабочей копии': { ref: WORKFLOW_REF, mode: 'full' },
  'Доказательства': { ref: REVIEW_REF, mode: 'full' },
  'Заголовок комментария роли': { ref: REVIEW_REF, mode: 'full' },
  'Отчёт и вердикт': { ref: REVIEW_REF, mode: 'frame' },
}

/**
 * Запрещённые строки. Регулярные выражения, а не `includes`, по двум причинам:
 * `/plugin` должен ловить команду `/plugin-help`, но не путь `…/plugins/x.mjs`,
 * а `> **Проект.**` содержит звёздочки разметки.
 */
export const FORBIDDEN = [
  { label: '> **Проект.**', re: /> \*\*Проект\.\*\*/ },
  { label: '> **Источник и адаптация.**', re: /> \*\*Источник и адаптация\.\*\*/ },
  { label: '/plugin', re: /(?<![\w-])\/plugin(?![\w-])/ },
  { label: '/reload-plugins', re: /\/reload-plugins/ },
  { label: 'argument-hint', re: /argument-hint/ },
  { label: 'Claude Code', re: /Claude Code/ },
]

/** Строка-разделитель «общий блок кончился, дальше отличия этой роли». */
const TAIL_MARKER = /^Особенности роли:\s*$/

/** Все файлы скиллов набора, путями от `agent-presets/` через `/`. */
export function discoverSkills(skillsDir = PRESETS_DIR) {
  const found = []
  if (!fs.existsSync(skillsDir)) return found
  for (const role of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!role.isDirectory()) continue
    const skillsRoot = path.join(skillsDir, role.name, 'skills')
    if (!fs.existsSync(skillsRoot)) continue
    for (const skill of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const file = path.join(skillsRoot, skill.name, 'SKILL.md')
      if (!fs.existsSync(file)) continue
      found.push({ rel: role.name + '/skills/' + skill.name + '/SKILL.md', file })
    }
  }
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * H2-разделы файла: имя, строка (1-based) и границы. Строки внутри
 * ограждённых блоков (``` и ~~~) не считаются заголовками — иначе пример
 * разметки внутри скилла ломал бы разбор.
 */
function h2Sections(lines) {
  const sections = []
  let fence = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]
      else if (fence === fenceMatch[1]) fence = null
      continue
    }
    if (fence !== null) continue
    if (!/^## /.test(line)) continue
    if (sections.length > 0) sections[sections.length - 1].end = i
    sections.push({ name: line.slice(3).trim(), line: i + 1, start: i, end: lines.length })
  }
  return sections
}

/** Фронтматтер: `name` и `description` — однострочные или блочные (`>-`). */
function frontmatter(lines) {
  const first = String(lines[0] ?? '').replace(/^\uFEFF/, '').trim()
  if (first !== '---') return { name: null, description: null }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end === -1) return { name: null, description: null }
  const head = lines.slice(1, end)
  const field = (key) => {
    const at = head.findIndex((line) => new RegExp('^' + key + ':').test(line))
    if (at === -1) return null
    const inline = head[at].slice(key.length + 1).trim()
    if (!['', '>-', '>', '|', '|-'].includes(inline)) return inline
    const rest = []
    for (let i = at + 1; i < head.length; i += 1) {
      if (head[i].trim() === '' || !/^\s/.test(head[i])) break
      rest.push(head[i].trim())
    }
    return rest.join(' ') || null
  }
  return { name: field('name'), description: field('description') }
}

/** Текст раздела: от заголовка до следующего H2, без хвостовых пробелов. */
function sectionText(lines, section) {
  return lines.slice(section.start, section.end).join('\n').replace(/\s+$/, '')
}

/** Раздел без хвоста `Особенности роли:` — то, что обязано совпадать дословно. */
function commonPart(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => TAIL_MARKER.test(line))
  return (at === -1 ? lines : lines.slice(0, at)).join('\n').replace(/\s+$/, '')
}

/** Каркас раздела: заголовок и первый абзац, дальше — форма отчёта этой роли. */
function framePart(text) {
  const lines = text.split('\n')
  const out = [lines[0]]
  let i = 1
  while (i < lines.length && lines[i].trim() === '') i += 1
  if (i >= lines.length) return out.join('\n')
  out.push('')
  while (i < lines.length && lines[i].trim() !== '') {
    out.push(lines[i])
    i += 1
  }
  return out.join('\n')
}

const short = (text) => text.replace(/\s+/g, ' ').slice(0, 60)

/** Проверки одного файла. Возвращает строки отчёта: `{ ok, rel, line, text }`. */
function lintFile(entry, reference) {
  const report = []
  const add = (ok, line, text) => report.push({ ok, rel: entry.rel, line, text })
  const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/)
  const exempt = EXEMPT.includes(entry.rel)
  const noOrder = NO_ORDER.includes(entry.rel)

  const head = frontmatter(lines)
  const missing = []
  if (!head.name) missing.push('name')
  if (!head.description) missing.push('description')
  add(missing.length === 0, 1,
    missing.length === 0
      ? 'фронтматтер: name и description на месте'
      : 'фронтматтер: нет ' + missing.join(', '))

  const sections = h2Sections(lines)
  const names = sections.map((section) => section.name)
  const firstLine = sections[0] === undefined ? 1 : sections[0].line

  if (exempt) {
    add(true, 1, 'спины не требуется: файл в списке исключений (`EXEMPT`)')
  } else {
    const first = sections[0]
    if (noOrder) {
      add(true, firstLine, 'порядок работы не требуется: карточка границ (`NO_ORDER`)')
    } else {
      const ok = first !== undefined && first.name === 'Порядок работы'
      add(ok, firstLine, ok
        ? 'первый H2 — «Порядок работы»'
        : 'первый H2 обязан быть «## Порядок работы», а он — «' + (first === undefined ? 'нет H2' : first.name) + '»')
    }

    const expectedTail = TAIL.filter((name) => names.includes(name))
    if (expectedTail.length === 0) {
      add(true, firstLine, 'хвостовых разделов спины нет — проверка хвоста пропущена')
    } else {
      const actualTail = names.slice(names.length - expectedTail.length)
      const ok = actualTail.join('|') === expectedTail.join('|')
      const at = sections.find((section) => section.name === expectedTail[0])
      add(ok, at === undefined ? firstLine : at.line, ok
        ? 'хвост на месте: ' + expectedTail.join(' → ')
        : 'хвост обязан быть ' + expectedTail.join(' → ') + ', а он — ' + actualTail.join(' → '))
    }

    const hits = sections
      .map((section) => section)
      .filter((section) => SPINE.includes(section.name))
    let broken = null
    for (let i = 1; i < hits.length; i += 1) {
      if (SPINE.indexOf(hits[i].name) <= SPINE.indexOf(hits[i - 1].name)) {
        broken = hits[i]
        break
      }
    }
    add(broken === null, broken === null ? firstLine : broken.line, broken === null
      ? 'порядок спины соблюдён'
      : 'раздел «' + broken.name + '» стоит после раздела, который по спине идёт позже')
  }

  for (const [name, spec] of Object.entries(COMMON_BLOCKS)) {
    const section = sections.find((candidate) => candidate.name === name)
    if (section === undefined) continue
    const refLines = reference(spec.ref)
    const normalize = spec.mode === 'frame' ? framePart : commonPart
    if (refLines === null) {
      add(false, section.line, 'общий блок «' + name + '»: нет эталона ' + spec.ref)
      continue
    }
    const refSection = h2Sections(refLines).find((candidate) => candidate.name === name)
    if (refSection === undefined) {
      add(false, section.line, 'общий блок «' + name + '»: в эталоне ' + spec.ref + ' такого раздела нет')
      continue
    }
    const got = normalize(sectionText(lines, section))
    const want = normalize(sectionText(refLines, refSection))
    add(got === want, section.line, got === want
      ? 'общий блок «' + name + '» совпадает с ' + spec.ref
      : 'общий блок «' + name + '» расходится с ' + spec.ref +
        ' — в файле «' + short(got) + '», в эталоне «' + short(want) + '»')
  }

  const forbidden = []
  lines.forEach((line, index) => {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) forbidden.push({ line: index + 1, label: rule.label })
    }
  })
  if (forbidden.length === 0) add(true, 1, 'запрещённых строк нет')
  else {
    for (const hit of forbidden) add(false, hit.line, 'запрещённая строка `' + hit.label + '`')
  }

  return report
}

/**
 * Прогон по каталогу скиллов. Ничего не пишет: возвращает строки отчёта и сводку,
 * печать и код возврата — дело вызывающего (так прогон проверяется набором).
 */
export function lintSkills(options = {}) {
  const skillsDir = options.skillsDir ?? PRESETS_DIR
  const expected = options.expected ?? EXPECTED_FILES
  const files = discoverSkills(skillsDir)

  const cache = new Map()
  const reference = (rel) => {
    if (!cache.has(rel)) {
      const file = path.join(skillsDir, ...rel.split('/'))
      cache.set(rel, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : null)
    }
    return cache.get(rel)
  }

  const report = []
  for (const entry of files) report.push(...lintFile(entry, reference))
  if (files.length !== expected) {
    report.push({
      ok: false,
      rel: 'agent-presets',
      line: 1,
      text: 'файлов SKILL.md ' + files.length + ', а канон ждёт ' + expected,
    })
  }

  return {
    files: files.map((entry) => entry.rel),
    checked: files.length,
    expected,
    violations: report.filter((line) => !line.ok).length,
    report,
  }
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const result = lintSkills()
  for (const line of result.report) {
    console.log((line.ok ? 'ok    ' : 'fail  ') + line.rel + ':' + line.line + ' — ' + line.text)
  }
  console.log('')
  console.log(result.checked + '/' + result.expected + ' файлов, ' + result.violations + ' нарушений')
  process.exit(result.violations === 0 ? 0 : 1)
}
