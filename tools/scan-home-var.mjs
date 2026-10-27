#!/usr/bin/env node
// Скан кода на конструкции, которые 26.10 и 27.10.2026 снесли боевой ~/.dsh.
//
//   node tools/scan-home-var.mjs                    D:\Development и D:\Agents
//   node tools/scan-home-var.mjs D:\Agents D:\Work  любые корни
//
// Что ищет:
//   ASSIGN-HOME     присваивание `$home` / `$HOME` в PowerShell — переменная read-only,
//                   присваивание падает нетерминирующей ошибкой, и рекурсивное удаление
//                   по `$home` бьёт по профилю человека;
//   JUNCTION        mklink /J, Junction/SymbolicLink, fs.symlinkSync — удаление проходит
//                   сквозь ссылку и уносит оригинал;
//   RM-ENV-PATH     рекурсивное удаление каталога, чей путь выведен из process.env.DSH_HOME,
//                   os.homedir(), $env:USERPROFILE, $HOME;
//   DSH-HOME-HUMAN  каталог установки, выставленный в домашний каталог человека.
//
// Код возврата 1, если что-то найдено.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const roots = process.argv.slice(2)
if (roots.length === 0) roots.push('D:\\Development', 'D:\\Agents')

// reports/ — тексты отчётов, а не команды: там встречается описание уже сделанных
// `mklink /J` (например про node_modules в worktree), это не код и не инструкция.
const SKIP_DIR = /[\\/](node_modules|\.git|\.dsh-module-fallback|dist|\.next|pg16|coverage-[^\\/]*|reports)[\\/]/
const CHECKED = /\.(mjs|cjs|js|ts|ps1|psm1|bat|cmd|sh|md|yml|yaml)$/i
const SELF = /(agent-safety\.mjs|agent-safety\.test\.mjs|scan-home-var\.mjs|agent\.cordis\.yml|ARCHITECTURE\.md|home-guard\.mjs)$/i

// Текст правил и документация о самих запретах — не код, их не считаем.
const RULE_TEXT = /ЗАПРЕТЫ: разрушающие команды PowerShell|запрещены: `mklink|объявление home не найдено/

const ENV_PATH = /process\.env\.DSH_HOME|os\.homedir\(\)|\$env:USERPROFILE|\$env:DSH_HOME|\$HOME\b|homedir\(\)/

const ASSIGN_HOME = /\$(home|HOME)\s*=(?!=)/
const JUNCTION = /mklink\s+\/J|ItemType\s+(Junction|SymbolicLink)|symlinkSync|CreateSymbolicLink/i
const DSH_HOME_HUMAN = /(--dsh-home|DSH_HOME)\s*=?\s*["']?\$env:USERPROFILE["']?\s*($|\\)/

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(full + path.sep)) continue
      walk(full, out)
    } else if (CHECKED.test(entry.name)) {
      out.push(full)
    }
  }
}

// Вызовы удаления: возвращает [{line, arg, recursive}]
function deleteCalls(lines) {
  const calls = []
  const argOf = /fs\.rmSync\(\s*([A-Za-z_$][\w$]*)|fs\.rmdirSync\(\s*([A-Za-z_$][\w$]*)|Remove-Item[^\r\n]*?(\$[A-Za-z_][\w]*)/i
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/rmSync|rmdirSync|Remove-Item/.test(line)) continue
    if (!/recursive\s*:\s*true|-Recurse/.test(line)) continue
    const m = argOf.exec(line)
    if (!m) continue
    const arg = (m[1] || m[2] || m[3] || '').replace(/^\$/, '')
    if (arg) calls.push({ line: i + 1, arg })
  }
  return calls
}

function definitions(lines) {
  const map = new Map()
  const def = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(.+)$/
  for (const line of lines) {
    const m = def.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

const findings = []
let scanned = 0
let deleteSites = 0

for (const root of roots) {
  const files = []
  walk(root, files)
  scanned += files.length
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (RULE_TEXT.test(text) || SELF.test(file)) continue
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (ASSIGN_HOME.test(line)) findings.push({ kind: 'ASSIGN-HOME', file, line: i + 1, detail: line.trim() })
      if (JUNCTION.test(line)) findings.push({ kind: 'JUNCTION', file, line: i + 1, detail: line.trim() })
      if (DSH_HOME_HUMAN.test(line)) findings.push({ kind: 'DSH-HOME-HUMAN', file, line: i + 1, detail: line.trim() })
    }

    const calls = deleteCalls(lines)
    if (calls.length === 0) continue
    deleteSites += calls.length
    const defs = definitions(lines)
    for (const call of calls) {
      const value = defs.get(call.arg)
      if (value === undefined) continue
      if (!ENV_PATH.test(value)) continue
      findings.push({
        kind: 'RM-ENV-PATH',
        file,
        line: call.line,
        detail: call.arg + ' = ' + value.trim().slice(0, 140),
      })
    }
  }
}

console.log('корни:            ' + roots.join(', '))
console.log('файлов прочитано: ' + scanned)
console.log('удалений каталога: ' + deleteSites)
console.log('')
if (findings.length === 0) {
  console.log('находок нет: ни `$home=` , ни ссылок, ни удаления по пути из окружения')
  process.exit(0)
}
for (const finding of findings) {
  const rel = path.relative(process.cwd(), finding.file) || finding.file
  console.log('[' + finding.kind + '] ' + finding.file + ':' + finding.line)
  console.log('    ' + finding.detail)
}
console.log('')
console.log('находок: ' + findings.length)
process.exit(1)
