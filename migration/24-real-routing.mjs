// Проверка на РЕАЛЬНОМ реестре: в какого бота уйдёт событие для каждой рабочей
// области. Сеть заглушена — ни одного настоящего сообщения не отправляется.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const requested = []
https.request = (options, cb) => {
  requested.push(String(options.path))
  const res = {
    statusCode: 200,
    on(event, fn) { if (event === 'data') fn(Buffer.from('{"ok":true,"result":[]}')); if (event === 'end') fn(); return this },
    resume() {},
  }
  return { on() { return this }, write() {}, destroy() {}, setTimeout() {}, end() { setTimeout(() => cb(res), 0); return this } }
}
https.get = () => { requested.push('GET'); return { on() { return this }, destroy() {} } }

const mod = await import(pathToFileURL(path.join(HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')).href)

const registry = JSON.parse(fs.readFileSync(path.join(HOME, 'projects.json'), 'utf8'))
const botIdOf = (projectId) => {
  const p = registry.projects[projectId]
  return p && p.telegram && p.telegram.token ? String(p.telegram.token).split(':')[0] : '(нет)'
}

const handlers = {}
const cwdFor = { current: '' }
const ctx = {
  get: (name) => {
    switch (name) {
      case 'agents': return { list: () => [], roots: () => [], get: () => undefined, currentInitiator: () => undefined }
      case 'sessions': return { get: () => ({ header: { cwd: cwdFor.current } }) }
      case 'sessionQuery': return { readTitleSnapshots: async () => [], readSurface: async () => ({ events: [] }) }
      case 'workspaceRegistry': return { list: () => [], get: () => undefined }
      case 'agentPresets': return { list: async () => [], resolve: async (id) => ({ id: id || 'dev' }), mount: async () => ({}) }
      case 'agentDefaultModel': return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      default: return undefined
    }
  },
  on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); return () => {} },
  interval: () => () => {},
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}

const logs = []
const realLog = console.log
console.log = (...a) => logs.push(a.join(' '))
try { mod.default.apply(ctx) } finally { console.log = realLog }

realLog('=== боты, поднятые мостом ===')
for (const line of logs) realLog('  ' + line)
realLog('')
realLog('=== куда уйдёт запрос разрешения для рабочей области ===')

async function route(cwd) {
  cwdFor.current = cwd
  requested.length = 0
  let toGui = false
  handlers['approval/request'][0]({ toolName: 'shell', agent: { id: 'sess-x' }, signal: undefined }, () => { toGui = true })
  await new Promise((r) => setTimeout(r, 40))
  const send = requested.filter((p) => p.includes('/sendMessage'))[0]
  if (!send) return toGui ? 'в GUI (бот не взял)' : 'никуда'
  const token = send.split('/sendMessage')[0].replace('/bot', '')
  const owner = Object.keys(registry.projects).filter((id) => {
    const t = registry.projects[id].telegram
    return t && String(t.token) === token
  })[0]
  return 'бот ' + (owner || '?') + ' (' + token.split(':')[0] + ')'
}

const cases = []
for (const [id, p] of Object.entries(registry.projects)) {
  if (p.workspace) cases.push([id + ': рабочая копия отдела', p.workspace])
  if (p.humanClone) cases.push([id + ': каталог человека', p.humanClone])
}
cases.push(['чужая область', 'D:\\Somewhere\\Else'])

for (const [label, cwd] of cases) {
  realLog('  ' + label.padEnd(34) + ' → ' + (await route(cwd)))
}

realLog('')
realLog('=== ожидание ===')
for (const id of Object.keys(registry.projects)) realLog('  ' + id.padEnd(11) + ' бот ' + botIdOf(id))
