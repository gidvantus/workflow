// Проверка раскладки пресетов ролей на РЕАЛЬНОМ модуле диспетчера: правила
// важнее самого копирования, поэтому проверяем их — чужой пресет не трогаем,
// устаревший скилл убираем, ссылку не разворачиваем, повторный запуск ничего не
// переписывает. Запуск: node app/tools/tests/deploy-presets.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deployPresets } from '../../../plugins/dev-department.mjs'

const root = path.join(os.tmpdir(), 'dsh-deploy-presets-test-' + process.pid)
const source = path.join(root, 'source')
const target = path.join(root, 'target')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) +
    (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    return null
  }
}

fs.rmSync(root, { recursive: true, force: true })
write(path.join(source, 'dev-backend', 'preset.yml'), 'name: Бэкенд\n')
write(path.join(source, 'dev-backend', 'skills', 'dev-workflow', 'SKILL.md'), 'правила роли\n')
write(path.join(source, 'tester', 'preset.yml'), 'name: Тестировщик\n')

console.log('=== первый запуск: пустой корень ===')
const first = deployPresets({ source, target })
check('ошибок нет', first.problem, null)
check('роли перечислены', first.presets, ['dev-backend', 'tester'])
check('новых файлов', first.written, 3)
check('обновлений нет', first.updated, 0)
check('скилл лёг в корень', read(path.join(target, 'dev-backend', 'skills', 'dev-workflow', 'SKILL.md')), 'правила роли\n')

console.log('\n=== второй запуск: содержимое совпадает ===')
const second = deployPresets({ source, target })
check('ничего не пишет', second.written + second.updated + second.removed, 0)
check('файлы учтены как совпадающие', second.unchanged, 3)

console.log('\n=== правка роли в пакете ===')
write(path.join(source, 'dev-backend', 'preset.yml'), 'name: Бэкенд (v2)\n')
const third = deployPresets({ source, target })
check('обновлён один файл', third.updated, 1)
check('новое содержимое на месте', read(path.join(target, 'dev-backend', 'preset.yml')), 'name: Бэкенд (v2)\n')

console.log('\n=== скилл убран из роли ===')
fs.rmSync(path.join(source, 'dev-backend', 'skills'), { recursive: true, force: true })
const fourth = deployPresets({ source, target })
check('устаревший файл убран', fourth.removed, 1)
check('каталога скилла больше нет', fs.existsSync(path.join(target, 'dev-backend', 'skills')), false)

console.log('\n=== свой пресет человека ===')
write(path.join(target, 'my-own', 'preset.yml'), 'name: Моё\n')
const fifth = deployPresets({ source, target })
check('чужой пресет назван', fifth.foreign, ['my-own'])
check('чужой пресет цел', read(path.join(target, 'my-own', 'preset.yml')), 'name: Моё\n')

console.log('\n=== корень — ссылка ===')
const linkRoot = path.join(root, 'linked-home')
fs.mkdirSync(linkRoot, { recursive: true })
const linkPath = path.join(linkRoot, '.agent-presets')
try {
  fs.symlinkSync(path.join(source, 'dev-backend'), linkPath, 'junction')
  const linked = deployPresets({ source, target: linkPath })
  check('ссылка не разворачивается', /ссылка/.test(String(linked.problem)), true)
  check('через ссылку ничего не записано', linked.written + linked.updated + linked.removed, 0)
} catch (error) {
  console.log('пропущено: ссылку не создать (' + String(error && error.message).split('\n')[0] + ')')
}

console.log('=== нет каталога пресетов ===')
const absent = deployPresets({ source: path.join(root, 'нет-такого'), target: path.join(root, 'x') })
check('причина названа', /нет каталога пресетов/.test(String(absent.problem)), true)

console.log('\n=== источник по умолчанию (каталог рядом с плагином) ===')
// Тот же вызов, но source не задан: плагин обязан найти свой `agent-presets/`
// сам, иначе bundle-установка молча останется без ролей. Цель — временный
// каталог, боевой ~/.dsh/.agent-presets тест не трогает.
const defaultSource = deployPresets({ target: path.join(root, 'target-default') })
check('источник найден без подсказки', defaultSource.problem, null)
check('роли разложены из него', defaultSource.presets.length > 0, true)
check('путь источника — каталог пакета', /agent-presets[\\/]?$/.test(defaultSource.source), true)

fs.rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nвсё прошло' : '\nпровалов: ' + failures)
process.exit(failures === 0 ? 0 : 1)
