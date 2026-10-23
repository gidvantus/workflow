// Шаг 4: установить многопроектный диспетчер и убрать жёсткий cwd из tg-bridge.
//
//   node 05-deploy.mjs --dry-run
//   node 05-deploy.mjs
//
// Каждый затрагиваемый файл получает резервную копию .bak-multiproject (один раз).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const SOURCE = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', '04-dev-department.mjs')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'

const TG_HELPER = [
  '// Рабочая область по умолчанию для новых сессий из Telegram — проект по',
  '// умолчанию из реестра ~/.dsh/projects.json. Раньше здесь стоял жёстко',
  '// прописанный путь одного проекта, и /new всегда целился в него.',
  'function defaultProjectWorkspace() {',
  '  try {',
  "    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')",
  "    const raw = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'))",
  '    const projects = (raw && raw.projects) || {}',
  '    const ids = Object.keys(projects)',
  "    if (ids.length === 0) return ''",
  "    const id = typeof raw.default === 'string' && raw.default && projects[raw.default] ? raw.default : ids[0]",
  '    const workspace = projects[id] && projects[id].workspace',
  "    return typeof workspace === 'string' ? workspace : ''",
  '  } catch (error) {',
  "    return ''",
  '  }',
  '}',
  '',
  '',
].join('\n')

const TG_ANCHOR = 'function readTelegramConfig() {'

const DEPARTMENT_CONFIG = [
  '{',
  '  "windows": [',
  '    { "start": "13:00", "stop": "04:00" },',
  '    { "start": "07:00", "stop": "09:00" }',
  '  ],',
  '  "maxRework": 3',
  '}',
  '',
].join('\n')

function backup(file) {
  const target = file + BACKUP_SUFFIX
  if (!DRY && !fs.existsSync(target)) fs.copyFileSync(file, target)
  return target
}

// 1. Синтаксис исходника.
const source = fs.readFileSync(SOURCE, 'utf8')
if (!source.includes('function stepProject')) throw new Error('исходник не похож на многопроектный диспетчер')

// 2. Диспетчер.
const department = path.join(PLUGINS, 'dev-department.mjs')
backup(department)
if (!DRY) fs.writeFileSync(department, source, 'utf8')
console.log((DRY ? '[dry] ' : '[ok]  ') + department)

// 3. Конфиг смены: repo/workspacePath уехали в реестр проектов.
const departmentConfig = path.join(HOME, 'dev-department.json')
backup(departmentConfig)
if (!DRY) fs.writeFileSync(departmentConfig, DEPARTMENT_CONFIG, 'utf8')
console.log((DRY ? '[dry] ' : '[ok]  ') + departmentConfig)

// 4. tg-bridge: рабочая область по умолчанию — из реестра проектов.
const tg = path.join(PLUGINS, 'tg-bridge.mjs')
let tgText = fs.readFileSync(tg, 'utf8')
if (!tgText.includes(TG_ANCHOR)) throw new Error('tg-bridge.mjs: не найден якорь readTelegramConfig')
if (!tgText.includes('defaultProjectWorkspace')) {
  tgText = tgText.split(TG_ANCHOR).join(TG_HELPER + TG_ANCHOR)
}
const cwdLine = /^(\s*)let cwd = .*$/m
const match = cwdLine.exec(tgText)
if (!match) throw new Error('tg-bridge.mjs: не найдено объявление let cwd')
if (!match[0].includes('VideCoding')) throw new Error('tg-bridge.mjs: let cwd выглядит иначе, чем ожидалось: ' + match[0])
tgText = tgText.replace(cwdLine, '$1let cwd = defaultProjectWorkspace()')
backup(tg)
if (!DRY) fs.writeFileSync(tg, tgText, 'utf8')
console.log((DRY ? '[dry] ' : '[ok]  ') + tg)

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
