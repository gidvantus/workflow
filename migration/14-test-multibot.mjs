// Тест многоботового моста на изолированном DSH_HOME.
//
// Проверяет три вещи:
//   1) опрашивается по одному боту на проект со своим ботом плюс общий;
//   2) сообщения бота уходят в тот чат, который этому боту принадлежит;
//   3) запрос разрешения по сессии уходит боту ПРОЕКТА этой сессии, а не всем.
//
// Сеть не трогается: https.request подменяется заглушкой.

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

// Настоящий DSH_HOME запоминаем ДО подмены: тестируем уже развёрнутый плагин.
const REAL_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const WORK = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', 'tmp-home')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'profiles', 'desktop', 'plugins'), { recursive: true })

const ALPHA_TOKEN = '111111:ALPHA_TOKEN'
const SHARED_TOKEN = '999999:SHARED_TOKEN'
const ALPHA_CHAT = 111
const SHARED_CHAT = 999

fs.writeFileSync(path.join(WORK, 'projects.json'), JSON.stringify({
  default: 'alpha',
  projects: {
    alpha: {
      title: 'Alpha', repo: 'acme/alpha', base: 'main', workspace: 'C:\\tmp\\alpha',
      telegram: { token: ALPHA_TOKEN, chatId: ALPHA_CHAT, voiceLang: 'ru' },
    },
    beta: { title: 'Beta', repo: 'acme/beta', base: 'main', workspace: 'C:\\tmp\\beta' },
  },
}, null, 2))

fs.writeFileSync(path.join(WORK, 'telegram.json'), JSON.stringify({ token: SHARED_TOKEN, chatId: SHARED_CHAT }, null, 2))

// Тестируем УЖЕ РАЗВЁРНУТЫЙ плагин: копируем его в изолированный DSH_HOME.
const deployed = path.join(REAL_HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')
fs.copyFileSync(deployed, path.join(WORK, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs'))

// ── заглушка сети ──────────────────────────────────────────────────────────
const calls = []
https.request = (options, cb) => {
  calls.push(String(options.path))
  const res = {
    statusCode: 200,
    on(event, fn) {
      if (event === 'data') fn(Buffer.from('{"ok":true,"result":[]}'))
      if (event === 'end') fn()
      return this
    },
    resume() {},
  }
  const req = {
    on() { return this },
    write() {},
    destroy() {},
    setTimeout() {},
    end() { setTimeout(() => cb(res), 0); return this },
  }
  return req
}

process.env.DSH_HOME = WORK
const mod = await import(pathToFileURL(path.join(WORK, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')).href)

// ── заглушки сервисов ──────────────────────────────────────────────────────
const timers = []
const handlers = {}
const SESSIONS = {
  'sess-alpha': { header: { cwd: 'C:\\tmp\\alpha' } },
  'sess-beta': { header: { cwd: 'C:\\tmp\\beta' } },
  'sess-other': { header: { cwd: 'C:\\tmp\\elsewhere' } },
}

const ctx = {
  get: (name) => {
    switch (name) {
      case 'agents': return { list: () => [], roots: () => [], get: () => undefined, currentInitiator: () => undefined }
      case 'sessions': return { get: (id) => SESSIONS[id] }
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

mod.default.apply(ctx)
console.log('хуков session/event        : ' + (handlers['session/event'] || []).length)
console.log('хуков approval/request     : ' + (handlers['approval/request'] || []).length)
console.log('хуков user-questions/request: ' + (handlers['user-questions/request'] || []).length)
console.log('опросов (ботов)            : ' + timers.length)

// Каждый опрос — свой бот.
for (const tick of timers) await tick()
await new Promise((r) => setTimeout(r, 60))

const pollPaths = calls.filter((p) => p.includes('/getUpdates'))
console.log('')
console.log('=== опрошенные боты ===')
for (const p of pollPaths) console.log('  ' + p.split('/getUpdates')[0])

// ── маршрутизация запроса разрешения ───────────────────────────────────────
async function approvalFor(sessionId) {
  calls.length = 0
  const hook = handlers['approval/request'][0]
  let handedToGui = false
  hook({
    toolName: 'shell',
    reason: 'проверка маршрутизации',
    agent: { id: sessionId },
    signal: undefined,
  }, () => { handedToGui = true })
  await new Promise((r) => setTimeout(r, 40))
  return { token: calls.length ? calls[0].split('/sendMessage')[0].replace('/bot', '') : null, handedToGui }
}

console.log('')
console.log('=== маршрутизация разрешений ===')
for (const [label, id] of [['alpha (свой бот)', 'sess-alpha'], ['beta (общий бот)', 'sess-beta'], ['чужой проект', 'sess-other'], ['неизвестная сессия', 'nope']]) {
  const r = await approvalFor(id)
  const which = r.token === ALPHA_TOKEN ? 'бот alpha' : r.token === SHARED_TOKEN ? 'общий бот' : r.token === null ? 'в GUI' : 'неизвестно'
  console.log('  ' + label.padEnd(20) + ' → ' + which)
}
