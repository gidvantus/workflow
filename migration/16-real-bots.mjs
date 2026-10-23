// Проверка на РЕАЛЬНОМ реестре: какие боты поднимет мост и не полезет ли он
// в сеть при старте. Опрос не запускается намеренно: два поллера на одном
// токене перехватывают друг у друга обновления, а этот процесс не должен
// мешать работающему DSH.

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')

// Сеть запрещена: если плагин полезет в Telegram при старте — тест упадёт.
let networkCalls = 0
https.request = () => { networkCalls += 1; throw new Error('сеть при старте недопустима') }
https.get = () => { networkCalls += 1; throw new Error('сеть при старте недопустима') }

const started = []
const realLog = console.log
console.log = (...args) => { started.push(args.join(' ')) }

const mod = await import(pathToFileURL(path.join(HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')).href)

const timers = []
const handlers = {}
const ctx = {
  get: (name) => {
    switch (name) {
      case 'agents': return { list: () => [], roots: () => [], get: () => undefined, currentInitiator: () => undefined }
      case 'sessions': return { get: () => undefined }
      case 'sessionQuery': return { readTitleSnapshots: async () => [], readSurface: async () => ({ events: [] }) }
      case 'workspaceRegistry': return { list: () => [], get: () => undefined }
      case 'agentPresets': return { list: async () => [], resolve: async (id) => ({ id: id || 'dev' }), mount: async () => ({}) }
      case 'agentDefaultModel': return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      default: return undefined
    }
  },
  on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); return () => {} },
  interval: (fn) => { timers.push(fn); return () => {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}

try {
  mod.default.apply(ctx)
} finally {
  console.log = realLog
}

realLog('=== старт моста на реальном реестре ===')
for (const line of started) realLog('  ' + line)
realLog('')
realLog('поллеров зарегистрировано : ' + timers.length)
realLog('хук session/event         : ' + (handlers['session/event'] || []).length)
realLog('хук approval/request      : ' + (handlers['approval/request'] || []).length)
realLog('хук user-questions/request: ' + (handlers['user-questions/request'] || []).length)
realLog('обращений в сеть при старте: ' + networkCalls)

// Сколько ботов настроено в реестре — независимый подсчёт по конфигам.
const registry = JSON.parse(fs.readFileSync(path.join(HOME, 'projects.json'), 'utf8'))
const own = Object.keys(registry.projects).filter((id) => registry.projects[id].telegram && registry.projects[id].telegram.token)
let shared = 0
try {
  const tg = JSON.parse(fs.readFileSync(path.join(HOME, 'telegram.json'), 'utf8'))
  if (tg.token) shared = 1
} catch (e) { /* нет общего бота */ }
realLog('')
realLog('проектов со своим ботом   : ' + own.length + (own.length ? ' (' + own.join(', ') + ')' : ''))
realLog('общий бот в telegram.json : ' + (shared ? 'есть' : 'нет'))
