// Проверка расписания проекта на РЕАЛЬНОМ модуле диспетчера: функции окна
// берём из самого файла, а не из копии. Запуск: node .dev-department-windows-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import * as pluginPaths from '../plugin-paths.mjs'

// Модуль берём в любой раскладке: рабочая копия, установленный пакет, старая.
const plugin = pluginPaths.pluginFile('dev-department')
const source = fs.readFileSync(plugin, 'utf8')
const cut = source.indexOf('export default {')
const wanted = ['parseClock', 'formatClock', 'windowLabel', 'parseWindows', 'minutesOfDay', 'inWindow', 'shiftKey', 'nextWindowStart']
const present = wanted.filter((name) => new RegExp('function ' + name + '\\s*\\(').test(source))
const missing = wanted.filter((name) => present.indexOf(name) === -1)
if (missing.length > 0) { console.error('в модуле нет функций: ' + missing.join(', ')); process.exit(1) }

const moduleFile = path.join(process.cwd(), '.windows-under-test.mjs')
fs.writeFileSync(moduleFile, source.slice(0, cut) + '\nexport { ' + present.join(', ') + ' }\n')
const m = await import('file:///' + moduleFile.replace(/\\/g, '/') + '?v=' + Date.now())

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
const at = (y, mth, d, h, min) => new Date(y, mth - 1, d, h, min, 0, 0)
const WORK = [{ start: 780, stop: 240 }, { start: 420, stop: 540 }]
const NIGHT = [{ start: 1380, stop: 210 }]

console.log('=== разбор времени ===')
check('parseClock 09:05', m.parseClock('09:05'), 545)
check('parseClock 23:59', m.parseClock('23:59'), 1439)
check('parseClock мусор', m.parseClock('25:00'), null)
check('formatClock', m.formatClock(545), '09:05')
check('windowLabel', m.windowLabel({ start: 780, stop: 240 }), '13:00–04:00')

console.log('\n=== разбор списка окон ===')
const parsed = m.parseWindows([{ start: '13:00', stop: '04:00' }, { start: '07:00', stop: '09:00' }], 'тест')
check('окна разобраны', parsed.problems, [])
check('значения', parsed.windows, [{ start: 780, stop: 240 }, { start: 420, stop: 540 }])
const bad = m.parseWindows([{ start: '9:00', stop: '9:00' }, { start: '25:00', stop: '10:00' }], 'тест')
check('пустое окно отброшено', bad.windows, null)
check('две ошибки названы', bad.problems.length, 2)
check('битое время объяснено', /HH:MM/.test(bad.problems[1]), true)

console.log('\n=== попадание в окно ===')
check('13:00 внутри', m.inWindow(WORK, at(2026, 10, 2, 13, 0)), true)
check('04:00 вне (конец не включается)', m.inWindow(WORK, at(2026, 10, 3, 4, 0)), false)
check('03:59 внутри', m.inWindow(WORK, at(2026, 10, 3, 3, 59)), true)
check('09:00 вне (промежуток)', m.inWindow(WORK, at(2026, 10, 3, 9, 0)), false)
check('08:59 внутри', m.inWindow(WORK, at(2026, 10, 3, 8, 59)), true)
check('12:59 вне', m.inWindow(WORK, at(2026, 10, 3, 12, 59)), false)

console.log('\n=== ключ смены: дата начала ===')
check('ночная смена в 00:30 началась вчера', m.shiftKey(NIGHT, at(2026, 10, 3, 0, 30)), '2026-10-2')
check('ночная смена в 23:30 — сегодня', m.shiftKey(NIGHT, at(2026, 10, 2, 23, 30)), '2026-10-2')
check('дневное окно — та же дата', m.shiftKey(WORK, at(2026, 10, 2, 14, 0)), '2026-10-2')

console.log('\n=== ближайшее открытие ===')
check('в 12:00 — сегодня 13:00', m.nextWindowStart(WORK, at(2026, 10, 2, 12, 0)), at(2026, 10, 2, 13, 0))
check('в 19:00 — сегодня 23:00', m.nextWindowStart([{ start: 1380, stop: 210 }], at(2026, 10, 2, 19, 0)), at(2026, 10, 2, 23, 0))
check('в 04:00 — сегодня 07:00', m.nextWindowStart(WORK, at(2026, 10, 3, 4, 0)), at(2026, 10, 3, 7, 0))

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(moduleFile, { force: true })
process.exit(failures === 0 ? 0 : 1)
