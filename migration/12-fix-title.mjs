// Починка заголовка проекта: при первом создании projects.json через
// PowerShell-here-string кириллица «Вахта» записалась двойным кодированием.
// Здесь файл читается и пишется Node в UTF-8, поэтому строки из этого файла
// гарантированно корректны.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const file = path.join(HOME, 'projects.json')
const raw = fs.readFileSync(file, 'utf8')
const registry = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)

const TITLES = { vahta: 'Вахта' }

for (const [id, title] of Object.entries(TITLES)) {
  const project = registry.projects[id]
  if (!project) continue
  const before = String(project.title || '')
  const codepoints = Array.from(before).map((ch) => ch.codePointAt(0).toString(16)).join(' ')
  console.log(id + ': было "' + before + '" (' + Array.from(before).length + ' символов; U+' + codepoints + ')')
  project.title = title
  console.log(id + ': стало "' + project.title + '" (' + Array.from(project.title).length + ' символов)')
}

const backup = file + '.bak-multiproject'
if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8')

const check = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const [id, title] of Object.entries(TITLES)) {
  if (check.projects[id] && check.projects[id].title !== title) throw new Error('заголовок ' + id + ' не записался')
}
console.log('\nprojects.json перезаписан, заголовки проверены чтением')
