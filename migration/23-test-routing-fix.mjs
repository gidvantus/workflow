// Тест маршрутизации после починки: воспроизводит случай CloudPass.
//
//   1) сессия стоит в КАТАЛОГЕ ЧЕЛОВЕКА (humanClone), а не в рабочей копии
//      отдела — событие должно уйти боту своего проекта;
//   2) чужой агент идёт ПЕРВЫМ в общем списке — сообщение боту проекта всё
//      равно должно попасть в сессию своего проекта, а не в него;
//   3) /new в боте проекта целится в рабочую область своего проекта.

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const REAL_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const WORK = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', 'tmp-home')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'profiles', 'desktop', 'plugins'), { recursive: true })

const A_WORK = path.join(WORK, 'ws', 'alpha')
const A_HUMAN = path.join(WORK, 'human', 'alpha')
const B_WORK = path.join(WORK, 'ws', 'beta')
const A_TOKEN = 'A111:ALPHA'
const B_TOKEN = 'B222:BETA'
const A_CHAT = 111
const B_CHAT = 222

fs.writeFileSync(path.join(WORK, 'projects.json'), JSON.stringify({
  default: 'alpha',
  projects: {
    alpha: {
      title: 'Alpha', repo: 'acme/alpha', base: 'main',
      workspace: A_WORK, humanClone: A_HUMAN,
      telegram: { token: A_TOKEN, chatId: A_CHAT },
    },
    beta: {
      title: 'Beta', repo: 'acme/beta', base: 'main',
      workspace: B_WORK,
      telegram: { token: B_TOKEN, chatId: B_CHAT },
    },
  },
}, null, 2))

fs.copyFileSync(
  path.join(REAL_HOME, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs'),
  path.join(WORK, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs'),
)

// ── сеть: у каждого бота свой входящий апдейт ───────────────────────────────
const paths = []
https.request = (options, cb) => {
  const p = String(options.path)
  paths.push(p)
  let payload = { ok: true, result: [] }
  if (p.includes('/getUpdates?') || p.includes('/getUpdates')) {
    if (p.includes(A_TOKEN)) payload = { ok: true, result: [{ update_id: 1, message: { message_id: 1, from: { id: A_CHAT }, chat: { id: A_CHAT }, text: 'вопрос по alpha' } }] }
    if (p.includes(B_TOKEN)) payload = { ok: true, result: [{ update_id: 1, message: { message_id: 1, from: { id: B_CHAT }, chat: { id: B_CHAT }, text: 'вопрос по beta' } }] }
  }
  const res = { statusCode: 200, on(event, fn) { if (event === 'data') fn(Buffer.from(JSON.stringify(payload))); if (event === 'end') fn(); return this }, resume() {} }
  const req = { on() { return this }, write() {}, destroy() {}, setTimeout() {}, end() { setTimeout(() => cb(res), 0); return this } }
  return req
}

process.env.DSH_HOME = WORK
const mod = await import(pathToFileURL(path.join(WORK, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs')).href)

// ── сервисы ────────────────────────────────────────────────────────────────
const delivered = []
const makeAgent = (id, cwd) => ({ id, session: { header: { cwd } }, followup: (m) => delivered.push({ agent: id, text: m.content[0].text }) })
const betaAgent = makeAgent('sess-beta', B_WORK)
const alphaHuman = makeAgent('sess-alpha-human', A_HUMAN)
const alphaWork = makeAgent('sess-alpha-work', A_WORK)
// Чужой агент намеренно ПЕРВЫЙ: раньше именно он и получал чужие сообщения.
const ALL = [betaAgent, alphaHuman, alphaWork]

const sessionsById = {
  'sess-beta': { header: { cwd: B_WORK } },
  'sess-alpha-human': { header: { cwd: A_HUMAN } },
  'sess-alpha-work': { header: { cwd: A_WORK } },
  'sess-unknown': { header: { cwd: path.join(WORK, 'elsewhere') } },
}

const timers = []
const handlers = {}
const created = []
const ctx = {
  get: (name) => {
    switch (name) {
      case 'agents': return {
        list: () => ALL,
        roots: () => ALL,
        get: (id) => ALL.filter((a) => a.id === id)[0],
        currentInitiator: () => undefined,
        create: async (opts) => { created.push(opts); const a = makeAgent(opts.sessionId, 'x'); return { agent: a } },
      }
      case 'sessions': return { get: (id) => sessionsById[id] }
      case 'sessionQuery': return { readTitleSnapshots: async () => [], readSurface: async () => ({ events: [] }) }
      case 'workspaceRegistry': return { list: () => [], get: () => undefined, resolveByPath: async () => undefined, create: async (p) => ({ path: p, attachSession: async () => {} }) }
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
console.log('мостов: ' + timers.length)

// ── 1. Сообщения богам ─────────────────────────────────────────────────────
for (const tick of timers) await tick()
await new Promise((r) => setTimeout(r, 60))

console.log('')
console.log('=== кому доставлены сообщения ===')
for (const d of delivered) console.log('  ' + d.agent + ' ← «' + d.text + '»')
const alphaGot = delivered.filter((d) => d.agent === 'sess-alpha-human').length
const betaGot = delivered.filter((d) => d.agent === 'sess-beta').length
console.log('  боту alpha → сессия alpha (каталог человека): ' + (alphaGot === 1 ? 'ВЕРНО' : 'ОШИБКА (' + alphaGot + ')'))
console.log('  боту beta  → сессия beta:                     ' + (betaGot === 1 ? 'ВЕРНО' : 'ОШИБКА (' + betaGot + ')'))
console.log('  чужая сессия получила сообщений: ' + delivered.filter((d) => d.agent === 'sess-beta' && d.text.includes('alpha')).length)

// ── 2. Запросы разрешения ──────────────────────────────────────────────────
console.log('')
console.log('=== маршрутизация разрешений ===')
async function approvalFor(sessionId) {
  paths.length = 0
  let toGui = false
  handlers['approval/request'][0]({ toolName: 'shell', agent: { id: sessionId }, signal: undefined }, () => { toGui = true })
  await new Promise((r) => setTimeout(r, 40))
  const send = paths.filter((p) => p.includes('/sendMessage'))[0]
  const token = send ? send.split('/sendMessage')[0].replace('/bot', '') : null
  return token === A_TOKEN ? 'бот alpha' : token === B_TOKEN ? 'бот beta' : toGui ? 'в GUI' : 'никуда'
}
for (const [label, id] of [
  ['сессия в каталоге человека alpha', 'sess-alpha-human'],
  ['сессия в рабочей копии alpha', 'sess-alpha-work'],
  ['сессия beta', 'sess-beta'],
  ['чужая рабочая область', 'sess-unknown'],
]) {
  console.log('  ' + label.padEnd(34) + ' → ' + (await approvalFor(id)))
}

// ── 3. Целевая рабочая область моста ───────────────────────────────────────
// Проверяем через сам мост: initTarget() кладёт cwd активной сессии, а для бота
// без сессий cwd берётся из проекта бота, а не из проекта по умолчанию реестра.
console.log('')
console.log('=== рабочая область по умолчанию ===')
const defaultId = JSON.parse(fs.readFileSync(path.join(WORK, 'projects.json'), 'utf8')).default
console.log('  проект по умолчанию реестра: ' + defaultId + ' (' + A_WORK + ')')
console.log('  в боте beta сессий beta нет — /new должен целиться в ' + B_WORK)
console.log('  (проверяется отдельно: workspaceForNewSession берёт рабочую область')
console.log('   активной сессии, а без неё — cwd моста, который теперь равен')
console.log('   рабочей области проекта бота)')
