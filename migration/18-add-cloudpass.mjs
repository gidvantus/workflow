// Шаг 8: проект CloudPass + защита от проекта без рабочей копии.
//
//   node 18-add-cloudpass.mjs --dry-run
//   node 18-add-cloudpass.mjs
//
//   1) добавляет проект cloudpass в ~/.dsh/projects.json;
//   2) учит диспетчер пропускать проект, у которого нет клона отдела, с
//      внятной причиной — иначе он падал бы на этом каждый тик.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const MIGRATION = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-cloudpass'

// Расписание — как на вахте.
const SCHEDULE = [
  { start: '13:00', stop: '04:00' },
  { start: '07:00', stop: '09:00' },
]

// Репозиторий gidvantus/cloudpass сейчас пуст, поэтому базовая ветка — main:
// develop-m появится, когда её заведут, и тогда base меняется одной строкой.
const CLOUDPASS = {
  title: 'CloudPass',
  repo: 'gidvantus/cloudpass',
  base: 'main',
  workspace: 'D:\\Agents\\CloudPass',
  humanClone: 'D:\\Development\\VideCoding\\CloudPass',
  composeProject: 'cloudpass-agent',
  department: {
    enabled: true,
    windows: SCHEDULE,
    maxRework: 3,
  },
}

function backup(file) {
  const target = file + BACKUP_SUFFIX
  if (!DRY && fs.existsSync(file) && !fs.existsSync(target)) fs.copyFileSync(file, target)
}

function replaceOnce(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length !== 2) throw new Error('для «' + label + '» ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  console.log('  ' + label)
  return parts.join(to)
}

// ── 1. Проект ──────────────────────────────────────────────────────────────

{
  const file = path.join(HOME, 'projects.json')
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (registry.projects.cloudpass) {
    console.log('[skip] проект cloudpass уже есть в реестре')
  } else {
    registry.projects.cloudpass = CLOUDPASS
    backup(file)
    if (!DRY) fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8')
    console.log('[ok]  проект cloudpass добавлен (' + Object.keys(registry.projects).length + ' проекта в реестре)')
  }
}

// ── 2. Диспетчер: проект без клона пропускается с причиной ─────────────────

const ANCHOR = [
  '    if (!row.department.windows) continue // о причине уже сказано выше',
  '    usable.push(row)',
].join('\n')

const REPLACEMENT = [
  '    if (!row.department.windows) continue // о причине уже сказано выше',
  '    // Роли работают в git-клоне. Каталога нет или это не клон — проект',
  '    // пропускается с причиной: иначе диспетчер падал бы на этом каждый тик,',
  '    // а агент всё равно не смог бы ни ветвиться, ни коммитить.',
  '    if (!fs.existsSync(row.workspace)) {',
  "      problems.push(row.id + ': рабочая область ' + row.workspace + ' не существует — проект пропущен, сначала склонируйте репозиторий')",
  '      continue',
  '    }',
  "    if (!fs.existsSync(path.join(row.workspace, '.git'))) {",
  "      problems.push(row.id + ': рабочая область ' + row.workspace + ' не является git-клоном — проект пропущен')",
  '      continue',
  '    }',
  '    usable.push(row)',
].join('\n')

for (const file of [path.join(PLUGINS, 'dev-department.mjs'), path.join(MIGRATION, '08-dev-department-v2.mjs')]) {
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')
  if (text.includes('не является git-клоном')) {
    console.log('[skip] ' + path.basename(file) + ': проверка уже есть')
    continue
  }
  text = replaceOnce(text, ANCHOR, REPLACEMENT, 'проверка рабочей области в ' + path.basename(file))
  backup(file)
  if (!DRY) fs.writeFileSync(file, text, 'utf8')
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
