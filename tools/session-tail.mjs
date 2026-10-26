// Хвост стенограммы сессии роли: чем занята прямо сейчас.
// Запуск: node .session-tail.mjs <часть id сессии> [сколько событий показать]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTranscript } from './zstd-frames.mjs'

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

  // Стенограмма пишется несколькими кадрами zstd — разбирает общий хелпер.
  const { rows, brokenFrames, droppedLines } = readTranscript(file)

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
  // Молча потерянные события — это не «пусто», а недосчёт: говорим о них вслух.
  if (brokenFrames > 0) console.log('! кадров разобрано не целиком: ' + brokenFrames + ' — часть событий в хвост не попала')
  if (droppedLines > 0) console.log('! строк не разобрано: ' + droppedLines + ' — стенограмма оборвана или повреждена')
  console.log(shown.slice(-limit).join('\n'))
}
