// Шаг 6: отдел в каждом проекте.
//
//   node 09-deploy-v2.mjs --dry-run
//   node 09-deploy-v2.mjs
//
// Делает три вещи:
//   1) добавляет проекту vahta явную секцию department (включён + расписание);
//   2) переписывает dev-department.json в ОБЩИЕ значения по умолчанию;
//   3) ставит многопроектный диспетчер версии 2.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const SOURCE = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', '08-dev-department-v2.mjs')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'

// Расписание работы отдела. Переносится в проект vahta как ЕГО расписание и
// остаётся в dev-department.json как общее — для проектов, которые своё не задали.
const SCHEDULE = [
  { start: '13:00', stop: '04:00' },
  { start: '07:00', stop: '09:00' },
]

const SHARED_CONFIG = JSON.stringify({
  windows: SCHEDULE,
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, null, 2) + '\n'

function backup(file) {
  const target = file + BACKUP_SUFFIX
  if (!DRY && fs.existsSync(file) && !fs.existsSync(target)) fs.copyFileSync(file, target)
}

// 1. Диспетчер v2.
const source = fs.readFileSync(SOURCE, 'utf8')
if (!source.includes('department: {')) throw new Error('исходник не похож на диспетчер v2')
const department = path.join(PLUGINS, 'dev-department.mjs')
backup(department)
if (!DRY) fs.writeFileSync(department, source, 'utf8')
console.log((DRY ? '[dry] ' : '[ok]  ') + 'диспетчер v2 → ' + department)

// 2. projects.json: у vahta появляется своя секция department.
{
  const file = path.join(HOME, 'projects.json')
  const raw = fs.readFileSync(file, 'utf8')
  const registry = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
  const vahta = registry.projects && registry.projects.vahta
  if (!vahta) throw new Error('в реестре нет проекта vahta')
  if (!vahta.department) {
    vahta.department = { enabled: true, windows: SCHEDULE, maxRework: 3 }
    backup(file)
    if (!DRY) fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8')
    console.log((DRY ? '[dry] ' : '[ok]  ') + 'vahta: добавлена секция department')
  } else {
    console.log('[skip] vahta: секция department уже есть')
  }
}

// 3. dev-department.json — только общие значения по умолчанию.
{
  const file = path.join(HOME, 'dev-department.json')
  backup(file)
  if (!DRY) fs.writeFileSync(file, SHARED_CONFIG, 'utf8')
  console.log((DRY ? '[dry] ' : '[ok]  ') + 'общие значения → ' + file)
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
