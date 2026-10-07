// Здоровье потока модели: по стенограммам последних сессий ищем ходы,
// которые завершились ошибкой (обрыв SSE), и показываем, когда это было.
// Запуск: node .session-errors.mjs [часов_назад]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const hours = Number(process.argv[2] || 24)
const since = Date.now() - hours * 3600 * 1000
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const root = path.join(dshHome, 'sessions')

function unzstd(file) {
  const bytes = fs.readFileSync(file)
  const parts = []
  let start = -1
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    const magic = bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd
    if (!magic) continue
    if (start >= 0) {
      try { parts.push(zlib.zstdDecompressSync(bytes.subarray(start, i)).toString('utf8')) } catch (e) { /* неполный кадр */ }
    }
    start = i
  }
  if (start >= 0) {
    try { parts.push(zlib.zstdDecompressSync(bytes.subarray(start)).toString('utf8')) } catch (e) { /* неполный кадр */ }
  }
  return parts.join('\n')
}

const rows = []
for (const workspace of fs.readdirSync(root)) {
  const base = path.join(root, workspace)
  if (!fs.statSync(base).isDirectory()) continue
  for (const session of fs.readdirSync(base)) {
    const file = path.join(base, session, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    const stat = fs.statSync(file)
    if (stat.mtimeMs < since) continue
    let text = ''
    try { text = unzstd(file) } catch (e) { continue }
    const events = text.split('\n').filter((l) => l.trim() !== '').map((l) => {
      try { return JSON.parse(l) } catch (e) { return null }
    }).filter(Boolean)
    const errors = []
    let lastWrite = null
    for (const row of events) {
      const e = row.event || row
      const d = e.data || {}
      if (e.type === 'turn/end' && d.reason && d.reason.kind === 'error') {
        errors.push((d.reason.error && d.reason.error.message) || 'ошибка')
      }
      if (e.type === 'turn/start') lastWrite = e.time
    }
    if (errors.length > 0) {
      rows.push({
        workspace: workspace.replace(/^--|--$/g, ''),
        session: session.slice(8, 16),
        errors: errors.length,
        last: errors[errors.length - 1],
        mtime: stat.mtime,
        events: events.length,
      })
    }
  }
}

rows.sort((a, b) => b.mtime - a.mtime)
console.log('сессии с ошибочными ходами за последние ' + hours + ' ч: ' + rows.length)
for (const row of rows) {
  console.log('  ' + row.mtime.toLocaleString('ru-RU') + '  ' + row.workspace + '  ' + row.session +
    '  ходов с ошибкой: ' + row.errors + '  событий: ' + row.events + '\n      ' + row.last)
}
if (rows.length === 0) console.log('  за это время обрывов потока не было')

const byMessage = {}
for (const row of rows) byMessage[row.last] = (byMessage[row.last] || 0) + row.errors
console.log('\nитого по причинам:')
for (const [message, count] of Object.entries(byMessage).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + count + ' ходов: ' + message)
}
