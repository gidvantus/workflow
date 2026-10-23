// Шаг 5: BOM-устойчивое чтение конфигов + перезапись projects.json без BOM.
//
//   node 07-bom.mjs --dry-run
//   node 07-bom.mjs
//
// Зачем: редакторы на Windows (и PowerShell Set-Content -Encoding utf8) пишут
// BOM в начало файла. JSON.parse на такой файл падает с "Unexpected token",
// то есть один невидимый символ ломает всю систему ролей. Читаем через
// stripBom.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const MIGRATION = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'

const STRIP_BOM = [
  '// BOM в начале файла (его пишут редакторы Windows и PowerShell) ломает',
  '// JSON.parse невидимым символом. Реестр — обычный файл, который человек',
  '// правит руками, поэтому читаем его снисходительно.',
  'function stripBom(text) {',
  '  const value = String(text)',
  '  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value',
  '}',
  '',
  '',
].join('\n')

let edits = 0

function writeFile(file, text) {
  if (DRY) return
  const backup = file + BACKUP_SUFFIX
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, text, 'utf8')
}

function replaceAll(text, from, to, label, file) {
  const parts = text.split(from)
  const count = parts.length - 1
  if (count < 1) return text
  edits += count
  console.log('  ' + label + ' ×' + count + '  —  ' + path.basename(path.dirname(file)) + '/' + path.basename(file))
  return parts.join(to)
}

// ── 1. Ролевые пресеты ──────────────────────────────────────────────────────

for (const id of fs.readdirSync(PRESETS)) {
  const file = path.join(PRESETS, id, 'github.mjs')
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes('function stripBom')) {
    text = text.split('function readRegistry() {').join(STRIP_BOM + 'function readRegistry() {')
  }
  text = replaceAll(text, "JSON.parse(fs.readFileSync(file, 'utf8'))", "JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))", 'stripBom в github.mjs', file)
  writeFile(file, text)
}

// ── 2. Диспетчер отдела (и deployed, и исходник в рабочей области) ──────────

for (const file of [path.join(PLUGINS, 'dev-department.mjs'), path.join(MIGRATION, '04-dev-department.mjs')]) {
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes('function stripBom')) {
    text = text.split('function loadConfig() {').join(STRIP_BOM + 'function loadConfig() {')
  }
  text = replaceAll(text, "JSON.parse(fs.readFileSync(file, 'utf8'))", "JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))", 'stripBom в чтении конфигов', file)
  text = replaceAll(text, "JSON.parse(fs.readFileSync(dialogsFile(), 'utf8'))", "JSON.parse(stripBom(fs.readFileSync(dialogsFile(), 'utf8')))", 'stripBom в карте диалогов', file)
  writeFile(file, text)
}

// ── 3. tg-bridge ────────────────────────────────────────────────────────────

{
  const file = path.join(PLUGINS, 'tg-bridge.mjs')
  let text = fs.readFileSync(file, 'utf8')
  text = replaceAll(
    text,
    "JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'))",
    "JSON.parse(String(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).replace(/^\\uFEFF/, ''))",
    'BOM в tg-bridge',
    file,
  )
  writeFile(file, text)
}

// ── 4. Перезаписать projects.json без BOM ───────────────────────────────────

{
  const file = path.join(HOME, 'projects.json')
  const raw = fs.readFileSync(file, 'utf8')
  const value = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const parsed = JSON.parse(value)
  const clean = JSON.stringify(parsed, null, 2) + '\n'
  const hadBom = raw.charCodeAt(0) === 0xFEFF
  if (!DRY) fs.writeFileSync(file, clean, 'utf8')
  console.log('  projects.json: ' + (hadBom ? 'BOM убран' : 'BOM не было') + ', проектов ' + Object.keys(parsed.projects || {}).length)
}

console.log(DRY ? '=== DRY RUN ===' : '=== ЗАПИСАНО ===')
console.log('всего правок: ' + edits)
