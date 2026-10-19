#!/usr/bin/env node
// Синхронизация кастомной надстройки DSH между каталогом установки и репозиторием.
//
//   node sync.mjs collect   из ~/.dsh в репозиторий (режим по умолчанию)
//   node sync.mjs apply     из репозитория в ~/.dsh
//   node sync.mjs status    сравнить и показать расхождения
//
// Каталог установки: $DSH_HOME, иначе ~/.dsh; переопределяется ключом --dsh-home.
// Черновики (*.bak-*), логи, артефакты тестов и секреты не синхронизируются.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(fileURLToPath(import.meta.url))

// ── аргументы ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const mode = argv.find((a) => !a.startsWith('--')) || 'collect'
if (!['collect', 'apply', 'status'].includes(mode)) {
  console.error('режим должен быть collect, apply или status')
  process.exit(2)
}
const homeFlag = argv.indexOf('--dsh-home')
const dshHome = homeFlag === -1
  ? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  : argv[homeFlag + 1]
if (!fs.existsSync(dshHome)) {
  console.error('каталог установки не найден: ' + dshHome + ' (задай --dsh-home)')
  process.exit(2)
}

// ── что синхронизируем ──────────────────────────────────────────────────────

// Роли отдела: один каталог — один пресет. Новый пресет добавляется сюда строкой.
const PRESETS = ['analyst', 'code-review', 'design', 'dev', 'devops-delivery', 'jev', 'security-review', 'tester']

// Хост-плоскость: путь внутри каталога установки совпадает с путём в репозитории.
const HOST_FILES = [
  'profiles/desktop/cordis.patch.yml',
  'profiles/desktop/plugins/dev-department.mjs',
  'profiles/desktop/plugins/role-sessions.mjs',
  'profiles/desktop/plugins/role-permissions.mjs',
  'profiles/desktop/plugins/tg-bridge.mjs',
  'profiles/desktop/plugins/voice-input/index.mjs',
  'profiles/desktop/plugins/voice-input/client.js',
  'profiles/desktop/plugins/voice-input/package.json',
  'profiles/web/cordis.patch.yml',
  'profiles/web/plugins/role-sessions.mjs',
]

// Инструменты приезжают из рабочей области человека: её путь в sync.local.json.
const localConfig = path.join(repo, 'sync.local.json')
let toolsSource = null
if (fs.existsSync(localConfig)) {
  // Файл пишут руками, и редакторы любят BOM: JSON.parse на нём падает.
  const raw = fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, '')
  toolsSource = JSON.parse(raw).toolsSource || null
}
const TOOL_FILES = [
  { from: '.dev-department-dialogs-test.mjs', to: 'tools/tests/dev-department-dialogs.test.mjs' },
  { from: '.dev-department-windows-test.mjs', to: 'tools/tests/dev-department-windows.test.mjs' },
  { from: '.tester-images-test.mjs', to: 'tools/tests/tester-images.test.mjs' },
  { from: '.code-review-tools-test.mjs', to: 'tools/tests/code-review-tools.test.mjs' },
  { from: '.analyst-github-test.mjs', to: 'tools/tests/analyst-github.test.mjs' },
  { from: '.session-errors.mjs', to: 'tools/session-errors.mjs' },
  { from: '.session-tail.mjs', to: 'tools/session-tail.mjs' },
]

// Что не синхронизируется никогда: черновики, логи, артефакты прогонов.
const EXCLUDE = /\.bak(-|\.|$)|\.log(-|\.|$)|^\.coverage$|^coverage-|\.tmp$/

function walk(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (!EXCLUDE.test(entry.name)) out.push(path.relative(root, full))
    }
  }
  return out
}

function pairs() {
  const list = []
  for (const rel of HOST_FILES) {
    list.push({ from: path.join(dshHome, rel), to: path.join(repo, rel) })
  }
  for (const preset of PRESETS) {
    const fromRoot = path.join(dshHome, '.agent-presets', preset)
    for (const rel of walk(fromRoot)) {
      list.push({ from: path.join(fromRoot, rel), to: path.join(repo, 'agent-presets', preset, rel) })
    }
  }
  if (toolsSource) {
    for (const tool of TOOL_FILES) {
      list.push({ from: path.join(toolsSource, tool.from), to: path.join(repo, tool.to) })
    }
  }
  return list
}

function hash(file) {
  if (!fs.existsSync(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function copyOne(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

const short = (full) => path.relative(repo, full).split(path.sep).join('/')

// ── проверка секретов ───────────────────────────────────────────────────────

function secrets() {
  const found = []
  for (const name of ['github.token', 'telegram.json', 'typesafe.token']) {
    const file = path.join(dshHome, name)
    if (!fs.existsSync(file)) continue
    const value = fs.readFileSync(file, 'utf8').trim()
    if (value) found.push({ where: name, value })
  }
  const projects = path.join(dshHome, 'projects.json')
  if (fs.existsSync(projects)) {
    const data = JSON.parse(fs.readFileSync(projects, 'utf8'))
    for (const [id, project] of Object.entries(data.projects || {})) {
      const token = project.telegram && project.telegram.token
      if (token) found.push({ where: 'projects.json: ' + id, value: token })
    }
  }
  return found
}

// Скан только по текстовым файлам: бинарники (шрифты) читать незачем.
const TEXT = /\.(md|json|jsonl|ya?ml|mjs|cjs|js|ts|txt|csv|py|ps1|sh|html|css)$/i

function scanSecrets() {
  let hits = 0
  const known = secrets()
  for (const { where, value } of known) {
    for (const rel of walk(repo).filter((r) => TEXT.test(r) && !r.startsWith('.git' + path.sep))) {
      const full = path.join(repo, rel)
      if (fs.readFileSync(full, 'utf8').includes(value)) {
        hits += 1
        console.log('  СЕКРЕТ  ' + where + ' встречается в ' + short(full))
      }
    }
  }
  console.log(hits === 0 ? '  секретов в репозитории нет' : '  найдено совпадений: ' + hits)
  return hits
}

// ── режимы ──────────────────────────────────────────────────────────────────

const list = pairs()
if (!toolsSource) console.log('  (sync.local.json не найден — tools/ не синхронизируются)')

if (mode === 'status') {
  let same = 0
  let diff = 0
  let missing = 0
  for (const pair of list) {
    const target = hash(pair.to)
    if (target === null) {
      missing += 1
      console.log('  нет в репо   ' + short(pair.to))
    } else if (target !== hash(pair.from)) {
      diff += 1
      console.log('  различается  ' + short(pair.to))
    } else same += 1
  }
  console.log('')
  console.log('совпадает: ' + same + ', различается: ' + diff + ', нет в репозитории: ' + missing)
}

if (mode === 'collect') {
  let copied = 0
  for (const pair of list) {
    if (!fs.existsSync(pair.from)) {
      console.log('  пропуск (нет боевого файла): ' + pair.from)
      continue
    }
    if (hash(pair.from) !== hash(pair.to)) {
      copyOne(pair.from, pair.to)
      copied += 1
      console.log('  собрано   ' + short(pair.to))
    }
  }
  console.log('')
  console.log('обновлено файлов: ' + copied)
  console.log('')
  console.log('проверка секретов:')
  scanSecrets()
}

if (mode === 'apply') {
  let copied = 0
  for (const pair of list) {
    if (!fs.existsSync(pair.to)) continue
    if (hash(pair.to) !== hash(pair.from)) {
      copyOne(pair.to, pair.from)
      copied += 1
      console.log('  разложено ' + path.relative(dshHome, pair.from).split(path.sep).join('/'))
    }
  }
  console.log('')
  console.log('обновлено файлов: ' + copied + ' (перезапусти DSH, чтобы плагины хоста перечитались)')
}
