// Хвост стенограммы сессии роли: чем занята прямо сейчас.
// Запуск: node .session-tail.mjs <часть id сессии> [сколько событий показать]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const needle = process.argv[2]
const limit = Number(process.argv[3] || 10)
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const root = path.join(dshHome, 'sessions')

const dirs = []
for (const workspace of fs.readdirSync(root)) {
  const base = path.join(root, workspace)
  if (!fs.statSync(base).isDirectory()) continue
  for (const session of fs.readdirSync(base)) {
    if (session.indexOf(needle) !== -1) dirs.push(path.join(base, session))
  }
}
if (dirs.length === 0) { console.error('сессия не найдена'); process.exit(1) }

for (const dir of dirs) {
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  const stat = fs.statSync(file)
  console.log('=== ' + path.basename(dir) + ' ===')
  console.log('записан: ' + stat.mtime.toLocaleTimeString('ru-RU') + ', ' + Math.round(stat.size / 1024) + ' КБ')

  // Стенограмма пишется несколькими кадрами zstd — распаковываем каждый.
  const bytes = fs.readFileSync(file)
  const parts = []
  let start = -1
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    const magic = bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd
    if (magic) {
      if (start >= 0) {
        try { parts.push(zlib.zstdDecompressSync(bytes.subarray(start, i)).toString('utf8')) } catch (error) { /* неполный кадр */ }
      }
      start = i
    }
  }
  if (start >= 0) {
    try { parts.push(zlib.zstdDecompressSync(bytes.subarray(start)).toString('utf8')) } catch (error) { /* неполный кадр */ }
  }

  const rows = parts.join('\n').split('\n').filter((l) => l.trim() !== '').map((l) => {
    try { return JSON.parse(l) } catch (error) { return null }
  }).filter(Boolean)

  const shown = []
  for (const row of rows) {
    const e = row.event || row
    const d = e.data || {}
    const cut = (text, n) => String(text).replace(/\s+/g, ' ').slice(0, n)
    if (e.type === 'tool/call') shown.push('  [вызов] ' + d.name + '  ' + cut(d.arguments, 240))
    if (e.type === 'tool/result') {
      const content = (d.message && d.message.content && d.message.content[0] && d.message.content[0].content) || []
      shown.push('  [итог] ошибка=' + !!d.error + '  ' + cut(content.map((b) => b.text || '').join(' '), 200))
    }
    if (e.type === 'step/start') shown.push('  — шаг ' + d.step + ' —')
    if (e.type === 'turn/end') shown.push('  [ход завершён] ' + JSON.stringify(d))
  }
  console.log('событий: ' + rows.length)
  console.log(shown.slice(-limit).join('\n'))
}
