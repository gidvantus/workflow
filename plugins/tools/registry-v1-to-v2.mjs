#!/usr/bin/env node
// Разовый перевод реестра проектов отдела из версии 1 в версию 2.
//
//   node plugins/tools/registry-v1-to-v2.mjs            показать результат, ничего не писать
//   node plugins/tools/registry-v1-to-v2.mjs --write    переписать файл (бэкап рядом)
//   node plugins/tools/registry-v1-to-v2.mjs --file <путь> --write
//
// Каталог установки: $DSH_HOME, иначе ~/.dsh; переопределяется ключом --dsh-home.
// Путь файла по умолчанию — тот, который называет модуль состояния отдела
// (`state-paths.mjs`), то есть `<DSH_HOME>/profiles/<профиль>/dsh-dev-department/
// projects.json`. Своего пути этот инструмент не собирает: перенос каталога
// состояния не должен оставлять его на старом месте.
//
// Перевод — только форма, не смысл: запись проекта версии 1 становится проектом с
// одним отделом `development`, а её поля (`repo`, `workspace`, `windows`,
// `telegram`, …) переезжают в этот отдел без переименований. Поэтому диспетчер,
// мост Telegram и `sync.mjs` после конвертации читают ровно те же адреса.
//
// Правила запуска:
//   • по умолчанию ничего не пишется — печатается результат и список проблем;
//   • `--write` кладёт предыдущий файл в `projects.json.bak` и пишет атомарно;
//   • уже вторая версия — «уже вторая версия», код 0 (инструмент идемпотентен);
//   • токены ботов в печать не попадают: в предпросмотре вместо них «***».
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { statePathsModule, registryModule } from './plugin-paths.mjs'

function parseArgs(argv) {
  const parsed = { write: false, file: null, dshHome: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') { parsed.write = true; continue }
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue }
    if (arg === '--file' || arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('ключу ' + arg + ' нужно значение')
      if (arg === '--file') parsed.file = value
      else parsed.dshHome = value
      index += 1
      continue
    }
    if (arg.startsWith('--file=')) { parsed.file = arg.slice('--file='.length); continue }
    if (arg.startsWith('--dsh-home=')) { parsed.dshHome = arg.slice('--dsh-home='.length); continue }
    if (arg.startsWith('-')) throw new Error('неизвестный ключ: ' + arg)
  }
  return parsed
}

// Секрет в предпросмотр не попадает: инструмент печатает документ, который
// человек читает глазами, а токен бота — не то, что стоит оставлять в консоли и
// в истории оболочки.
function masked(value) {
  const document = JSON.parse(JSON.stringify(value))
  for (const project of Array.isArray(document.projects) ? document.projects : []) {
    for (const department of Array.isArray(project.departments) ? project.departments : []) {
      if (department.telegram && typeof department.telegram === 'object' && department.telegram.token) {
        department.telegram.token = '***'
      }
    }
  }
  return document
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node plugins/tools/registry-v1-to-v2.mjs [--write] [--file <путь>] [--dsh-home <путь>]')
  process.exit(0)
}

const dshHome = args.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// Модуль состояния читает `$DSH_HOME` в момент вызова и ключа `dshHome` не знает:
// каталог установки выставляем в окружение ДО него, иначе `--dsh-home` тихо
// проигнорируется и инструмент возьмёт настоящий каталог человека.
process.env.DSH_HOME = dshHome
const state = await statePathsModule({ dshHome })
const registry = await registryModule({ dshHome })
const file = args.file || state.readStateFile(state.STATE_FILES.projects)

if (!fs.existsSync(file)) {
  console.error('файл реестра не найден: ' + file)
  console.error('если реестр ещё не заведён, его нечего переводить: заведите документ версии 2 и положите по этому пути')
  process.exit(2)
}

let raw
try {
  raw = JSON.parse(registry.stripBom(fs.readFileSync(file, 'utf8')))
} catch (error) {
  console.error('файл реестра не читается: ' + file + ' — ' + (error && error.message ? error.message : String(error)))
  process.exit(2)
}

const converted = registry.convertLegacyDocument(raw)
if (converted.alreadyV2) {
  console.log('уже вторая версия: ' + file + ' — переводить нечего')
  process.exit(0)
}
if (converted.document === null) {
  console.error('перевод невозможен: ' + converted.problems.join('; '))
  process.exit(2)
}

// Проверка переведённого документа тем же разбором, которым его потом прочитает
// диспетчер: конвертер не должен отдавать файл, на котором смена встанет.
const checked = registry.parseRegistry(converted.document, path.basename(file))
const problems = converted.problems.slice()
for (const problem of checked.problems) problems.push(problem)
if (checked.fatal) problems.push(checked.fatal)

console.log(JSON.stringify(masked(checked.document || converted.document), null, 2))

if (problems.length > 0) {
  console.error('')
  console.error('ПРОБЛЕМЫ (' + problems.length + '):')
  for (const problem of problems) console.error('  • ' + problem)
}

if (checked.fatal) {
  console.error('')
  console.error('документ не прошёл проверку — файл не переписан')
  process.exit(2)
}

if (!args.write) {
  console.log('')
  console.log('это предпросмотр: файл не изменён. Переписать — добавьте --write')
  process.exit(0)
}

fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file + '.bak', fs.readFileSync(file))
const temporary = file + '.tmp-' + process.pid
fs.writeFileSync(temporary, JSON.stringify(checked.document, null, 2) + '\n')
fs.renameSync(temporary, file)
console.log('')
console.log('записано: ' + file + ' (предыдущая версия — ' + file + '.bak)')
