// Миграция пресетов, шаг 3: косметика после замен.
//
//   node 03-polish.mjs --dry-run
//   node 03-polish.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'
const ROLES = ['analyst', 'dev', 'tester', 'devops-delivery', 'security-review']

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
  console.log('  ' + file + '  |  ' + label + ' ×' + count)
  return parts.join(to)
}

// Метки конвейера остаются названными своими обычными именами: это контракт
// ролей, одинаковый в любом проекте. Реестр может их переопределить, поэтому
// project_info остаётся источником истины.
const LABELS_NOTE_FROM = '      - `<id>` — поле `id`; `<labels.dev>`, `<labels.progress>`, `<labels.test>`, `<labels.ok>`, `<labels.failed>` — поля объекта `labels`.'
const LABELS_NOTE_TO = '      - `<id>` — поле `id`. Метки конвейера `project_info` тоже отдаёт (`labels.dev`, `labels.progress`, `labels.test`, `labels.ok`, `labels.failed`); ниже они названы своими обычными именами, потому что это контракт ролей, одинаковый в любом проекте. Если проект переопределяет `labels`, пользуйся значениями из `project_info`, а не текстом промта.'

const SKILL_LABELS_FROM = '> `<artifacts>`, `<id>`, `<labels.dev>`, `<labels.progress>`, `<labels.test>`, `<labels.ok>`, `<labels.failed>`.'
const SKILL_LABELS_TO = '> `<artifacts>`, `<id>`. Метки конвейера берутся из `project_info.labels`, если проект их переопределяет.'

const POLISH = [
  ['задешь стенд человека (стенд человека) и его базу', 'задешь стенд человека и его базу', 'лишняя скобка (ru)'],
  ["touch the human's own stand (the human's own stand) and its database", "touch the human's own stand and its database", 'лишняя скобка (en)'],
  ["touch the human's own stand (the human's own stand)", "touch the human's own stand", 'лишняя скобка (en, короткая)'],
  ['стенд человека (стенд человека)', 'стенд человека', 'лишняя скобка (ru, короткая)'],
]

for (const role of ROLES) {
  const dir = path.join(PRESETS, role)
  if (!fs.existsSync(dir)) continue

  const composition = path.join(dir, 'agent.cordis.yml')
  if (fs.existsSync(composition)) {
    const rel = role + '/agent.cordis.yml'
    let yml = fs.readFileSync(composition, 'utf8')
    yml = replaceAll(yml, LABELS_NOTE_FROM, LABELS_NOTE_TO, 'уточнение про метки', rel)
    for (const [from, to, label] of POLISH) yml = replaceAll(yml, from, to, label, rel)
    writeFile(composition, yml)
  }

  const skillsRoot = path.join(dir, 'skills')
  if (!fs.existsSync(skillsRoot)) continue
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    const rel = role + '/skills/' + entry.name + '/SKILL.md'
    let md = fs.readFileSync(skillFile, 'utf8')
    md = replaceAll(md, SKILL_LABELS_FROM, SKILL_LABELS_TO, 'уточнение про метки', rel)
    for (const [from, to, label] of POLISH) md = replaceAll(md, from, to, label, rel)
    writeFile(skillFile, md)
  }
}

console.log(DRY ? '=== DRY RUN ===' : '=== ЗАПИСАНО ===')
console.log('всего правок: ' + edits)
