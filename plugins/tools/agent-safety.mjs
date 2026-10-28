#!/usr/bin/env node
// Запреты на разрушающие команды PowerShell — в промпт каждой роли отдела.
//
//   node tools/agent-safety.mjs          вписать блок во все agent-presets/*/agent.cordis.yml
//   node tools/agent-safety.mjs check    проверить, что блок есть у всех ролей и YAML не сломан
//
// Зачем: 26.10 и 27.10.2026 агент отдела дважды стёр боевой ~/.dsh одной и той же
// конструкцией. `$home` — встроенная read-only переменная PowerShell (равна
// домашнему каталогу человека); присваивание `$home='D:\temp\home'` падает
// нетерминирующей ошибкой, код идёт дальше, и `Remove-Item -Recurse -Force $home`
// сносит профиль человека. Второй раз: ссылка внутрь боевого каталога.
//
// Блок вписывается в конец литерала `prefix: |-` строки persona и идемпотентен:
// повторный запуск ничего не добавляет.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Скрипт лежит в plugins/tools, поэтому корень репозитория — два уровня выше, а
// роли — в каталоге пакета отдела (plugins/agent-presets).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const presetsDir = path.join(repo, 'plugins', 'agent-presets')

// Маркер идемпотентности: первая строка блока, по ней же живёт режим check.
const MARKER = 'ЗАПРЕТЫ: разрушающие команды PowerShell'

const RULES = [
  MARKER + ' (26.10 и 27.10.2026 так стёрли боевой ~/.dsh)',
  'Профиль человека и каталог установки DSH неприкосновенны. 26.10 и 27.10.2026 боевой',
  '`~/.dsh` стирали целиком дважды, оба раза одной и той же конструкцией, поэтому эти',
  'запреты сильнее любого удобства проверки:',
  '',
  '- `$home` / `$HOME` — встроенная read-only переменная PowerShell, равна домашнему',
  '  каталогу человека. Присваивание `$home=\'D:\\temp\\home\'` НЕ срабатывает: ошибка',
  '  `Cannot overwrite variable HOME because it is read-only or constant` не',
  '  терминирующая, скрипт идёт дальше, `$home` остаётся `C:\\Users\\<человек>`, и',
  '  следующая `Remove-Item -Recurse -Force $home` удаляет профиль человека.',
  '  Свои переменные так не называй: `$sandboxHome`, `$tmpHome`, `$testHome`,',
  '  `$dshHome`. Если имя `home` принципиально — только',
  '  `Set-Variable -Name home -Value <путь> -Force`, и сразу выведи `$home`.',
  '- Рекурсивное удаление (`Remove-Item -Recurse`, `ri -r`, `rmdir /s /q`, `rd /s /q`,',
  '  `fs.rmSync(..., { recursive: true })`) допустимо только по пути, который ты в этом',
  '  же ответе напечатал через `[IO.Path]::GetFullPath()`, и только если он лежит внутри',
  '  `$env:TEMP` или каталога артефактов проекта. Запрещено, если путь — домашний каталог',
  '  человека, его предок, `~/.dsh`, `~/.home-backup`, `DSH_HOME` или что-то внутри них.',
  '- Временный каталог установки в скриптах и тестах создаётся и удаляется только через',
  '  `tools/home-guard.mjs` — `freshHome(dir)` и `wipeHome(dir)`: они сами отказываются',
  '  работать с боевым `~/.dsh`, его предками и потомками. Свой',
  '  `fs.rmSync(home)` / `Remove-Item $home` в пробах и тестах запрещён.',
  '- Ссылки на боевой каталог запрещены: `mklink /J`, `New-Item -ItemType',
  '  Junction|SymbolicLink`, `fs.symlinkSync` с целью внутри `~/.dsh`. Рекурсивное',
  '  удаление проходит сквозь ссылку и уносит оригинал.',
  '- В `~/.dsh` можно только читать: не удалять, не перемещать, не перезаписывать.',
  '  Раскладка и правки — `node sync.mjs apply` из репозитория. Снимок для восстановления',
  '  лежит в `~/.home-backup`; его не трогать и не чистить.',
  '- Перед командой, которая удаляет или перезаписывает каталог, назови в ответе точный',
  '  путь и почему он одноразовый. Назвать не можешь — не выполняй.',
]

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8')
}

// Границы литерала `prefix: |-` в строке persona: где начинается контент и где он
// заканчивается (первая строка с меньшим отступом).
function prefixBlock(lines) {
  const start = lines.findIndex((line) => /^\s*prefix:\s*\|-\s*$/.test(line))
  if (start === -1) return null
  const keyIndent = lines[start].match(/^\s*/)[0].length
  const indent = keyIndent + 2
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const current = line.match(/^\s*/)[0].length
    if (current < indent) {
      end = i
      break
    }
  }
  return { start, end, indent }
}

function presetFiles() {
  if (!fs.existsSync(presetsDir)) return []
  return fs
    .readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(presetsDir, entry.name, 'agent.cordis.yml'))
    .filter((file) => fs.existsSync(file))
}

// ── check ───────────────────────────────────────────────────────────────────

// Возвращает { files, problems }: пустой problems — запрет есть в промпте каждой роли.
export function checkPresets() {
  const problems = []
  const files = presetFiles()
  if (files.length === 0) problems.push('не найдено ни одного agent-presets/*/agent.cordis.yml')
  for (const file of files) {
    const rel = path.relative(repo, file).split(path.sep).join('/')
    const lines = readText(file).split('\n')
    const block = prefixBlock(lines)
    if (!block) {
      problems.push(rel + ': нет литерала `prefix: |-` — блок некуда вписать')
      continue
    }
    const hits = lines.filter((line) => line.includes(MARKER)).length
    if (hits === 0) problems.push(rel + ': блока запретов нет')
    else if (hits > 1) problems.push(rel + ': блок запретов продублирован (' + hits + ' раз)')
    for (let i = block.start + 1; i < block.end; i += 1) {
      if (lines[i].includes('\t')) problems.push(rel + ': табуляция в строке ' + (i + 1))
    }
  }
  return { files: files.length, problems }
}

function check() {
  const { files, problems } = checkPresets()
  if (problems.length > 0) {
    for (const problem of problems) console.log('  ПРОВАЛ  ' + problem)
    console.log('')
    console.log('проверено ролей: ' + files + ', проблем: ' + problems.length)
    process.exit(1)
  }
  console.log('  блок запретов есть у всех ролей: ' + files)
  console.log('  YAML не тронут: литерал prefix на месте, табуляций нет')
}

// ── inject ──────────────────────────────────────────────────────────────────

function inject() {
  const files = presetFiles()
  let injected = 0
  let skipped = 0
  for (const file of files) {
    const rel = path.relative(repo, file).split(path.sep).join('/')
    const text = readText(file)
    if (text.includes(MARKER)) {
      skipped += 1
      console.log('  уже есть   ' + rel)
      continue
    }
    const lines = text.split('\n')
    const block = prefixBlock(lines)
    if (!block) {
      console.log('  ПРОПУСК     ' + rel + ': нет литерала `prefix: |-`')
      continue
    }
    const pad = ' '.repeat(block.indent)
    const inserted = ['', ...RULES.map((line) => (line === '' ? '' : pad + line)), '']
    lines.splice(block.end, 0, ...inserted)
    writeText(file, lines.join('\n'))
    injected += 1
    console.log('  вписано     ' + rel + ' (+' + RULES.length + ' строк)')
  }
  console.log('')
  console.log('ролей обновлено: ' + injected + ', уже было: ' + skipped)
  if (injected > 0) {
    console.log('дальше: node sync.mjs apply   → разложить в ~/.dsh, затем перезапустить DSH')
  }
}

// CLI запускается только при прямом вызове: файл импортирует тест agent-safety.test.mjs.
const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  if (process.argv.includes('check')) check()
  else inject()
}
