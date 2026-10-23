// Шаг 12: события проекта без своего бота не должны уходить в чужой чат.
//
//   node 27-fix-shared-fallback.mjs --dry-run
//   node 27-fix-shared-fallback.mjs
//
// Раньше общим адресатом становился любой мост, чей токен совпадает с токеном
// из telegram.json. С тех пор как этот токен сделали ботом проекта Brain, такое
// правило отправляло события остальных проектов в чужой чат — ровно та ошибка,
// из-за которой сообщения CloudPass уходили не туда.
//
// Теперь общий бот — только тот, у которого нет своего проекта. Проект без бота
// остаётся в GUI, и об этом пишется в лог.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const BRIDGE = path.join(HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')
const DRY = process.argv.includes('--dry-run')

const FROM = [
  '    // Общий бот: если его токен уже занят проектом, общим становится тот же',
  '    // мост — иначе у проектов без своего бота не осталось бы адресата.',
  '    const sharedBridge = bridges.filter((bridge) => bridge.projectId === null)[0] ||',
  '      (shared ? byToken.get(shared.token) : undefined)',
].join('\n')

const TO = [
  '    // Общий бот — ТОЛЬКО тот, у которого нет своего проекта. Если токен общего',
  '    // бота принадлежит какому-то проекту, общего бота нет вовсе: иначе события',
  '    // проекта без своего бота молча уходили бы в чужой чат.',
  '    const sharedBridge = bridges.filter((bridge) => bridge.projectId === null)[0]',
  '',
  '    const withoutBot = projects.filter((project) => !project.bot)',
  '    if (withoutBot.length > 0) {',
  "      console.warn('[tg-bridge] без своего бота: ' + withoutBot.map((p) => p.id).join(', ') +",
  "        (sharedBridge ? ' — их события уходят общему боту' : ' — их события остаются в GUI, пока в проекте не задан telegram'))",
  '    }',
].join('\n')

let text = fs.readFileSync(BRIDGE, 'utf8')

if (text.includes('Общий бот — ТОЛЬКО тот')) {
  console.log('[skip] уже правился')
} else {
  const parts = text.split(FROM)
  if (parts.length !== 2) throw new Error('ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  text = parts.join(TO)
  if (!DRY) {
    const bak = BRIDGE + '.bak-shared'
    if (!fs.existsSync(bak)) fs.copyFileSync(BRIDGE, bak)
    fs.writeFileSync(BRIDGE, text, 'utf8')
  }
  console.log('[ok]  ' + (DRY ? '(dry) ' : '') + 'правило общего бота изменено')
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
