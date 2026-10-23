// Шаг 10: мост должен узнавать проект по ОБОИМ его корням и не путать сессии.
//
//   node 22-fix-routing.mjs --dry-run
//   node 22-fix-routing.mjs
//
// Что лечится:
//   1) github.mjs — проекта искался только по workspace; сессия, открытая в
//      каталоге человека (humanClone), проектом не опознавалась вовсе и
//      project_info отказывал;
//   2) tg-bridge — то же самое при выборе бота: событие уходило общему боту;
//   3) tg-bridge — активный диалог выбирался из ВСЕХ сессий процесса, поэтому
//      сообщение, отправленное боту CloudPass, могло уйти в чужую сессию;
//   4) tg-bridge — рабочая область по умолчанию для /new бралась из проекта по
//      умолчанию реестра, а не из проекта бота.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const BRIDGE = path.join(HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-routing'

let edits = 0

function writeFile(file, text) {
  const before = fs.readFileSync(file, 'utf8')
  if (before === text) return
  const bak = file + BACKUP_SUFFIX
  if (!DRY && !fs.existsSync(bak)) fs.copyFileSync(file, bak)
  if (!DRY) fs.writeFileSync(file, text, 'utf8')
}

function replaceOnce(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length !== 2) throw new Error('«' + label + '»: ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  edits += 1
  console.log('  ' + label)
  return parts.join(to)
}

function replaceRegex(text, re, lines, label) {
  const matches = text.match(new RegExp(re.source, 'g'))
  if (!matches || matches.length !== 1) {
    throw new Error('«' + label + '»: ожидалось 1 совпадение, найдено ' + (matches ? matches.length : 0))
  }
  edits += 1
  console.log('  ' + label)
  // Замена функцией: иначе replace истолковал бы $& и подобное в тексте.
  return text.replace(re, () => lines.join('\n'))
}

// ── 1. github.mjs: корни проекта — рабочая копия И каталог человека ─────────

const PICK_RE = / {6}const root = normalizePath\(row\.workspace\)\n {6}if \(!root\) continue\n {6}if \(wanted === root \|\| wanted\.indexOf\(root \+ '\\\\'\) === 0\) \{\n {8}if \(root\.length > bestLength\) \{ best = row; bestLength = root\.length \}\n {6}\}\n/

const PICK_NEW = [
  '      // Сессия может стоять и в рабочей копии отдела, и в каталоге человека:',
  '      // оба принадлежат проекту, поэтому оба — его корни.',
  '      for (const candidate of [row.workspace, row.humanClone]) {',
  '        const root = normalizePath(candidate)',
  '        if (!root) continue',
  "        if (wanted === root || wanted.indexOf(root + '\\\\') === 0) {",
  '          if (root.length > bestLength) { best = row; bestLength = root.length }',
  '        }',
  '      }',
]

for (const id of fs.readdirSync(PRESETS)) {
  const file = path.join(PRESETS, id, 'github.mjs')
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')
  if (text.includes('for (const candidate of [row.workspace, row.humanClone])')) {
    console.log('[skip] ' + id + '/github.mjs: уже правился')
    continue
  }
  text = replaceRegex(text, PICK_RE, PICK_NEW, id + '/github.mjs: корни проекта')
  writeFile(file, text)
}

// ── 2. tg-bridge ───────────────────────────────────────────────────────────

{
  let text = fs.readFileSync(BRIDGE, 'utf8')

  if (text.includes('belongsToBot')) {
    console.log('[skip] tg-bridge.mjs: уже правился')
  } else {
    // 2a. Реестр проектов отдаёт оба корня.
    text = replaceOnce(text, [
      '    return {',
      '      id,',
      "      title: typeof row.title === 'string' && row.title ? row.title : id,",
      "      workspace: String(row.workspace || ''),",
      '      bot,',
      '    }',
    ].join('\n'), [
      '    return {',
      '      id,',
      "      title: typeof row.title === 'string' && row.title ? row.title : id,",
      "      workspace: String(row.workspace || ''),",
      "      humanClone: String(row.humanClone || ''),",
      '      // Корни проекта: рабочая копия отдела и каталог человека. Сессия может',
      '      // стоять в любом из них — оба принадлежат проекту.',
      "      roots: [String(row.workspace || ''), String(row.humanClone || '')].filter(Boolean),",
      '      bot,',
      '    }',
    ].join('\n'), 'реестр проектов: humanClone и roots')

    // 2b. Бот несёт свои корни и рабочую область по умолчанию.
    text = replaceOnce(text,
      "    bots.push({ key: project.id, projectId: project.id, ...project.bot })",
      "    bots.push({ key: project.id, projectId: project.id, roots: project.roots, defaultCwd: project.workspace, ...project.bot })",
      'бот проекта: roots и defaultCwd')
    text = replaceOnce(text,
      "    bots.push({ key: 'shared', projectId: null, ...shared })",
      "    bots.push({ key: 'shared', projectId: null, roots: [], defaultCwd: '', ...shared })",
      'общий бот: пустые roots')

    // 2c. Роутер: проект по любому из корней.
    text = replaceRegex(text, / {10}const root = normalizePath\(project\.workspace\)\n {10}if \(!root\) continue\n {10}if \(wanted === root \|\| wanted\.indexOf\(root \+ '\\\\'\) === 0\) \{\n {12}if \(root\.length > bestLength\) \{ best = project; bestLength = root\.length \}\n {10}\}\n/, [
      '          for (const candidate of project.roots || []) {',
      '            const root = normalizePath(candidate)',
      '            if (!root) continue',
      "            if (wanted === root || wanted.indexOf(root + '\\\\') === 0) {",
      '              if (root.length > bestLength) { best = project; bestLength = root.length }',
      '            }',
      '          }',
    ], 'роутер: проект по обоим корням')

    // 2d. Активный диалог выбирается только среди своих сессий.
    text = replaceOnce(text, [
      '    async function resolveTarget() {',
      '      if (target) return target',
      '      const initiator = agents.currentInitiator && agents.currentInitiator()',
      '      if (initiator) { target = initiator; return target }',
      '      const roots = agents.roots && agents.roots()',
      '      if (roots && roots.length > 0) { target = roots[0]; return target }',
      '      const all = agents.list()',
      '      if (all.length > 0) { target = all[0]; return target }',
      '      return undefined',
      '    }',
    ].join('\n'), [
      '    // Мост обслуживает СВОЙ проект, поэтому и активный диалог выбирается',
      '    // среди своих сессий. Без этого сообщение, отправленное боту CloudPass,',
      '    // ушло бы в первую попавшуюся сессию процесса — например в вахту.',
      '    function belongsToBot(agent) {',
      '      if (!bot.projectId) return true',
      '      const session = agent && agent.session',
      '      const cwd = session && session.header ? session.header.cwd : undefined',
      '      if (!cwd) return false',
      '      const wanted = normalizePath(cwd)',
      '      return (bot.roots || []).some((candidate) => {',
      '        const root = normalizePath(candidate)',
      "        return root !== '' && (wanted === root || wanted.indexOf(root + '\\\\') === 0)",
      '      })',
      '    }',
      '',
      '    async function resolveTarget() {',
      '      if (target && belongsToBot(target)) return target',
      '      target = undefined',
      '      const initiator = agents.currentInitiator && agents.currentInitiator()',
      '      if (initiator && belongsToBot(initiator)) { target = initiator; return target }',
      '      const roots = (agents.roots && agents.roots()) || []',
      '      const own = roots.filter(belongsToBot)',
      '      if (own.length > 0) { target = own[0]; return target }',
      '      const all = agents.list() || []',
      '      const mine = all.filter(belongsToBot)',
      '      if (mine.length > 0) { target = mine[0]; return target }',
      '      return undefined',
      '    }',
    ].join('\n'), 'resolveTarget: только свои сессии')

    // 2e. /new в боте проекта создаёт сессию в рабочей области ЭТОГО проекта.
    text = replaceOnce(text,
      '    let cwd = defaultProjectWorkspace()',
      '    let cwd = bot.defaultCwd || defaultProjectWorkspace()',
      'cwd по умолчанию: рабочая область проекта бота')

    writeFile(BRIDGE, text)
  }
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
console.log('правок: ' + edits)
