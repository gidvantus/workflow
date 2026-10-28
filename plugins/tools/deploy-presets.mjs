// Раскладка пресетов ролей отдела в пользовательский корень DSH — без запуска
// приложения. Плагин делает то же самое на своей загрузке; инструмент нужен,
// чтобы починить установку сразу и увидеть, что именно легло на диск.
//
// Запуск: node app/tools/deploy-presets.mjs [--source <каталог>] [--target <каталог>] [--json]
import path from 'node:path'
import { deployPresets } from '../../plugins/dev-department.mjs'

const options = {}
let json = false
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--source') options.source = path.resolve(args[++i] || '')
  else if (arg === '--target') options.target = path.resolve(args[++i] || '')
  else if (arg === '--json') json = true
  else {
    console.error('неизвестный аргумент: ' + arg)
    console.error('использование: node tools/deploy-presets.mjs [--source <каталог>] [--target <каталог>] [--json]')
    process.exit(2)
  }
}

const result = deployPresets(options)

if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.problem ? 1 : 0)
}

console.log('источник: ' + result.source)
console.log('корень:   ' + result.target)
if (result.problem) {
  console.error('ошибка: ' + result.problem)
  process.exit(1)
}
console.log('роли:     ' + result.presets.join(', '))
console.log('новых файлов: ' + result.written + ', обновлено: ' + result.updated +
  ', убрано: ' + result.removed + ', без изменений: ' + result.unchanged)
if (result.foreign.length > 0) console.log('свои пресеты (не тронуты): ' + result.foreign.join(', '))
