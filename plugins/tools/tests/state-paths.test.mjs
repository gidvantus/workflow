// Проверка модуля путей состояния отдела: `plugins/state-paths.mjs`.
//
// Модуль — единственное место, где собран путь состояния отдела (issue #26), и
// его спрашивают все: хост-плагины пишут через него, инструменты `plugins/tools/`
// читают через него. Набор проверяет ровно контракт переноса:
//
//   - каталог состояния — `<DSH_HOME>/profiles/desktop/dsh-dev-department`, а не
//     корень каталога установки;
//   - восемь имён файлов не переименованы;
//   - легаси-файл переносится один раз, второй вызов — no-op;
//   - когда есть оба файла, читается новый, а старый остаётся нетронутым;
//   - отсутствующий каталог создаётся при первом обращении;
//   - `$DSH_HOME` читается в момент вызова, а не на импорте;
//   - пресеты в корне каталога установки перенос не задевает.
//
// Настоящий ~/.dsh не читается и не пишется: каталог установки подменяется
// песочным в `process.env.DSH_HOME`.
// Запуск: node state-paths.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import * as pluginPaths from '../plugin-paths.mjs'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// ── песочница ───────────────────────────────────────────────────────────────

const sandbox = path.join(process.cwd(), '.state-paths-home')
const other = path.join(process.cwd(), '.state-paths-other-home')
fs.rmSync(sandbox, { recursive: true, force: true })
fs.rmSync(other, { recursive: true, force: true })
fs.mkdirSync(sandbox, { recursive: true })
// Пресеты лежат в корне каталога установки и остаются там при любом переносе:
// это DSH, а не отдел. Соседство проверяется ниже.
fs.mkdirSync(path.join(sandbox, '.agent-presets', 'analyst'), { recursive: true })
fs.writeFileSync(path.join(sandbox, '.agent-presets', 'analyst', 'preset.yml'), 'id: analyst\n')
process.env.DSH_HOME = sandbox

// Модуль берётся из раскладки: рабочая копия, установленный пакет или старая
// раскладка. Своего пути к нему набор не выводит — иначе проверялся бы не тот
// файл, который работает на машине.
let moduleFile
try {
  moduleFile = pluginPaths.pluginFile('state-paths', { dshHome: sandbox })
} catch (error) {
  // Модуль — половина `profiles/` (контракт половин в issue #26). Пока его нет в
  // раскладке, проверять нечего, но и «пропустить» набор нельзя: иначе перенос
  // состояния остался бы непроверенным. Говорим, чего именно не хватает, и падаем.
  console.error('модуль путей состояния отдела не найден ни в одной раскладке:\n' + error.message)
  console.error('  его пишет половина `profiles/`: ' + path.join(pluginPaths.REPO_PACKAGE_DIR, 'state-paths.mjs'))
  process.exit(1)
}
const state = await import('file:///' + moduleFile.replace(/\\/g, '/'))

const STATE_DIR = path.join(sandbox, 'profiles', 'desktop', 'dsh-dev-department')
const statePath = (name) => path.join(STATE_DIR, name)

// ── имя профиля и каталог ───────────────────────────────────────────────────

console.log('=== каталог состояния ===')
check('профиль состояния — профиль установки', state.STATE_PROFILE, pluginPaths.DEFAULT_PROFILE)
check('каталог состояния — в профиле, а не в корне', state.stateDir(), STATE_DIR)
check('каталог установки берётся из $DSH_HOME', state.dshHome(), sandbox)
check('старый путь файла — корень каталога установки', state.legacyFile('projects.json'), path.join(sandbox, 'projects.json'))

// ── восемь имён ─────────────────────────────────────────────────────────────

console.log('\n=== имена файлов состояния ===')
// Имена — часть контракта: их знают плагины и инструменты. Переименование в
// модуле обязано ломать набор, а не тихо оставлять файл на старом месте.
check('восемь имён из постановки', state.STATE_FILES, {
  projects: 'projects.json',
  config: 'dev-department.json',
  dialogs: 'dev-department-dialogs.json',
  usage: 'dev-department-usage.json',
  shiftLog: 'dev-department.log',
  mcpLog: 'dev-department-mcp.log',
  roleSessions: 'role-sessions.log',
  rolePermissions: 'role-permissions.log',
})

// ── каталог создаётся, файл — нет ───────────────────────────────────────────

console.log('\n=== путь для записи ===')
check('до первого обращения каталога нет', fs.existsSync(STATE_DIR), false)
check('путь для записи — новый каталог', state.stateFile(state.STATE_FILES.projects), statePath('projects.json'))
check('каталог создан обращением', fs.existsSync(STATE_DIR), true)
check('но файла ещё нет: путь — не запись', fs.existsSync(statePath('projects.json')), false)

// ── перенос легаси-файла ────────────────────────────────────────────────────

console.log('\n=== перенос со старого места ===')
const bookName = state.STATE_FILES.usage
const bookText = JSON.stringify([{ project: 'workflow', issue: 26, role: 'dev-backend' }])
fs.writeFileSync(state.legacyFile(bookName), bookText)
const bookPath = state.stateFile(bookName)
check('книга записи — новый каталог', bookPath, statePath(bookName))
check('легаси-файл перенесён, а не скопирован', [fs.existsSync(state.legacyFile(bookName)), fs.readFileSync(bookPath, 'utf8')],
  [false, bookText])

const beforeAgain = fs.readFileSync(bookPath, 'utf8')
check('повторный вызов — no-op', [state.stateFile(bookName), fs.readFileSync(bookPath, 'utf8')], [bookPath, beforeAgain])

// Старого файла нет — ни переноса, ни создания файла: «файла нет» остаётся
// прежним состоянием, плагин сам решает, писать ли ему.
const dialogsName = state.STATE_FILES.dialogs
check('старого файла нет — ни переноса, ни файла', [state.stateFile(dialogsName), fs.existsSync(statePath(dialogsName))],
  [statePath(dialogsName), false])

// Оба файла есть — переносить нечего, старый остаётся на месте: чтение живёт с
// нового места, а данные не теряются даже после ручного возврата файла в корень.
console.log('\n=== оба места сразу ===')
const rulesName = state.STATE_FILES.roleSessions
fs.writeFileSync(state.legacyFile(rulesName), 'OLD\n')
fs.writeFileSync(statePath(rulesName), 'NEW\n')
check('есть оба — читается новый', state.readStateFile(rulesName), statePath(rulesName))
check('старый не тронут', fs.readFileSync(state.legacyFile(rulesName), 'utf8'), 'OLD\n')
check('и запись в новое место старый не сносит', [state.stateFile(rulesName), fs.readFileSync(state.legacyFile(rulesName), 'utf8')],
  [statePath(rulesName), 'OLD\n'])

// ── чтение ──────────────────────────────────────────────────────────────────

console.log('\n=== путь для чтения ===')
const permissionsName = state.STATE_FILES.rolePermissions
fs.writeFileSync(state.legacyFile(permissionsName), 'старая запись\n')
check('есть только старый — читается он', state.readStateFile(permissionsName), state.legacyFile(permissionsName))
// Чтение не переносит: перенос — дело записи, иначе чтение меняло бы диск.
check('чтение старый файл не переносит', [fs.existsSync(state.legacyFile(permissionsName)), fs.existsSync(statePath(permissionsName))],
  [true, false])
check('нет обоих — новый путь', state.readStateFile(state.STATE_FILES.mcpLog), statePath(state.STATE_FILES.mcpLog))

// ── окружение читается в момент вызова ──────────────────────────────────────

console.log('\n=== $DSH_HOME в момент вызова ===')
process.env.DSH_HOME = other
check('другой $DSH_HOME — другой каталог состояния',
  [state.dshHome(), state.stateDir(), state.stateFile(state.STATE_FILES.config)],
  [other, path.join(other, 'profiles', 'desktop', 'dsh-dev-department'),
    path.join(other, 'profiles', 'desktop', 'dsh-dev-department', state.STATE_FILES.config)])
process.env.DSH_HOME = sandbox

// ── соседи не тронуты ───────────────────────────────────────────────────────

console.log('\n=== что перенос не задевает ===')
check('пресеты в корне каталога установки на месте',
  fs.readFileSync(path.join(sandbox, '.agent-presets', 'analyst', 'preset.yml'), 'utf8'), 'id: analyst\n')
// Перенос унёс ровно один файл — книгу: остальные имена в корне не появлялись.
check('перенесённое в корне не осталось',
  [fs.existsSync(state.legacyFile(state.STATE_FILES.usage)), fs.existsSync(path.join(sandbox, state.STATE_FILES.projects))],
  [false, false])

// Ветка «rename не удался — копия вместо переноса» здесь не проверяется: она
// срабатывает на другом устройстве (EXDEV) или на чужом праве (EPERM), и
// изготовить это в песочнице одного диска нельзя, не подменяя модуль его копией.

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(sandbox, { recursive: true, force: true })
fs.rmSync(other, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
