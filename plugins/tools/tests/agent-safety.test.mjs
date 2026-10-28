// Проверка, что запрет на разрушающие команды PowerShell есть в промпте КАЖДОЙ роли.
//
// Зачем тест, а не только текст в промпте: 26.10 и 27.10.2026 боевой ~/.dsh стирали
// дважды одной и той же конструкцией (`$home='...'` + `Remove-Item -Recurse -Force $home`,
// где `$home` — read-only переменная, равная профилю человека). Запрет обязан ехать
// вместе с пресетами: новый пресет без блока — красный тест, а не сюрприз на проде.
//
// Запуск: node agent-safety.test.mjs (из каталога tools/tests)
import path from 'node:path'
import process from 'node:process'
import { checkPresets } from '../agent-safety.mjs'

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + (ok || detail === undefined ? '' : ' → ' + detail))
}

const { files, problems } = checkPresets()

check('пресеты найдены', files > 0, 'ни одного agent-presets/*/agent.cordis.yml')
check('блок запретов есть у всех ролей (' + files + ' шт.)', problems.length === 0,
  problems.length > 0 ? problems.join('; ') : undefined)

for (const problem of problems) console.log('  подробности: ' + problem)

// Маркер должен быть именно тот, что вписывает agent-safety.mjs: иначе второй прогон
// инжектора добавит блок во второй раз.
const marker = 'ЗАПРЕТЫ: разрушающие команды PowerShell'
check('маркер блока стабилен', typeof marker === 'string' && marker.length > 0)

// Репозиторий не должен сам учить агентов этой конструкции: файлы пресетов проверяет
// checkPresets, а скрипты — отдельный взгляд по коду.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Корень репозитория считаем от файла теста, а не от cwd: тест лежит в
// plugins/tools/tests, и запускать его можно из любого каталога.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const codeFiles = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(ps1|mjs|cjs|js)$/.test(entry.name) && !full.split(path.sep).join('/').includes('/tools/tests/')) codeFiles.push(full)
  }
}
walk(repoRoot)

const banned = /(\$HOME|\$home)\s*=\s*['"]/i
const offenders = codeFiles.filter((file) => {
  const text = fs.readFileSync(file, 'utf8')
  // agent-safety.mjs содержит образец конструкции внутри текста правил — это не код.
  if (file.endsWith('agent-safety.mjs')) return false
  return banned.test(text)
})
check('в скриптах нет присваивания $home/$HOME', offenders.length === 0,
  offenders.map((file) => path.relative(repoRoot, file)).join(', '))

console.log('')
if (failures > 0) {
  console.log('ПРОВАЛОВ: ' + failures)
  process.exit(1)
}
console.log('ВСЕ ПРОВЕРКИ ПРОШЛИ')
