// Интеграционный набор моста Telegram на РЕАЛЬНОМ модуле `plugins/tg-bridge.mjs`:
// поддельная сеть Telegram, поддельные сервисы DSH, песочный реестр проектов.
//
// Проверяется видимость проектов в боте — то, что раньше не проверялось ничем:
//   • бот обычного проекта видит только свои рабочие области;
//   • бот проекта из `default` видит все области реестра;
//   • бот с `telegram.projects` видит свой проект первым, затем перечисленные;
//   • неизвестный id в списке не роняет старт и называется в предупреждении;
//   • /sessions и /sessions N считают только видимые области;
//   • кнопки чужого проекта (proj:/new:/newp:/newd:) отказывают и ничего не
//     открывают, `use:` с чужой сессией не переключает активный диалог;
//   • у видимой чужой области нет кнопок создания сессии и переключения диалога,
//     но история читается;
//   • /new у бота без своей рабочей области честно отказывает и не создаёт сессию;
//   • у своего проекта всё работает как до правки.
//
// Запуск из корня репозитория: node plugins/tools/tests/tg-bridge-projects.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import * as pluginPaths from '../plugin-paths.mjs'

// Путь к боевому модулю ищем ДО подмены DSH_HOME: набор проверяет исходник,
// который лежит рядом с ним, а не установленную копию.
const pluginFile = pluginPaths.pluginFile('tg-bridge')

// ── песочница ───────────────────────────────────────────────────────────────
const home = path.join(process.cwd(), '.tg-bridge-projects-test-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })

// Реестр проектов — там, где его читает модуль состояния отдела.
const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
process.env.DSH_HOME = home
// Каталог инструментов распознавания — песочный не для красоты: на старте мост
// чистит `.voice-tools/tmp`, и боевой каталог человека трогать нельзя.
const voiceTools = path.join(home, '.voice-tools')
fs.mkdirSync(path.join(voiceTools, 'tmp'), { recursive: true })
process.env.DSH_VOICE_TOOLS = voiceTools

// Пути проектов: области лежат под ними, как в жизни.
const P = {
  vahta: path.join(home, 'sandbox', 'vahta'),
  vahtaHuman: path.join(home, 'sandbox', 'vahta-human'),
  workflow: path.join(home, 'sandbox', 'workflow'),
  brain: path.join(home, 'sandbox', 'brain'),
  cloudpass: path.join(home, 'sandbox', 'cloudpass'),
  crm: path.join(home, 'sandbox', 'crm'),
  solo: path.join(home, 'sandbox', 'solo'),
}

// Рабочие области реестра DSH. Их две штуки у «Вахты» (рабочая копия отдела и
// каталог человека) — на этом проверяется, что в видимость попадает не проект,
// а все его корни.
const WORKSPACE_ROWS = [
  { id: 'w-vahta', title: 'Вахта', path: P.vahta, sessions: ['session-vahta-1'] },
  { id: 'w-vahta-human', title: 'Вахта (человек)', path: P.vahtaHuman, sessions: [] },
  { id: 'w-workflow', title: 'Workflow', path: P.workflow, sessions: ['session-wf-1'] },
  { id: 'w-brain', title: 'Brain', path: P.brain, sessions: ['session-brain-1'] },
  { id: 'w-cloudpass', title: 'CloudPass', path: P.cloudpass, sessions: ['session-cp-1'] },
  { id: 'w-crm', title: 'CRMDormitory', path: P.crm, sessions: ['session-crm-1'] },
]

// ── перехват логов: нужны и предупреждения, и строка «видит проекты» ────────
const warnings = []
const logs = []
const realLog = console.log
console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
console.log = (...args) => { logs.push(args.map(String).join(' ')); realLog(...args) }

// ── поддельная сеть Telegram ────────────────────────────────────────────────
let sends = []
const queues = new Map()
let updateId = 1000

function queueUpdate(token, update) {
  const q = queues.get(token) || []
  q.push(update)
  queues.set(token, q)
}

function respond(options, body) {
  const match = String(options.path || '').match(/^\/bot([^/]+)\/([^?]+)/)
  if (!match) return { statusCode: 404, body: '{}' }
  const token = match[1]
  const method = match[2]
  if (method === 'getUpdates') {
    const q = queues.get(token) || []
    const update = q.shift()
    return { statusCode: 200, body: JSON.stringify({ ok: true, result: update ? [update] : [] }) }
  }
  let payload = {}
  try { payload = body ? JSON.parse(body) : {} } catch (e) { payload = {} }
  sends.push({ token, method, payload })
  if (method === 'sendMessage' || method === 'editMessageText') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, result: { message_id: 100 + sends.length } }) }
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, result: true }) }
}

https.request = (options, callback) => {
  // Тело запроса уходит через write() + end(): копим его, иначе POST придёт пустым.
  let chunks = ''
  const req = {
    on() { return req },
    setTimeout() { return req },
    destroy() { return req },
    write(chunk) { chunks += String(chunk); return req },
    end(payload) {
      if (payload !== undefined) chunks += String(payload)
      process.nextTick(() => {
        const result = respond(options, chunks)
        const res = {
          statusCode: result.statusCode,
          on(event, fn) {
            if (event === 'data') fn(result.body)
            if (event === 'end') process.nextTick(fn)
            return res
          },
        }
        callback(res)
      })
      return req
    },
  }
  return req
}

// ── поддельные сервисы DSH ──────────────────────────────────────────────────
let created = []
let followups = []
let workspaces = []
let services = {}

// Строка каждого диалога: где он стоит и как называется.
const SESSION_CWD = new Map()

function agentOf(id) {
  const cwd = SESSION_CWD.get(id)
  if (cwd === undefined) return undefined
  return {
    id,
    session: { header: { cwd } },
    followup(message) { followups.push({ sessionId: id, text: message.content && message.content[0] && message.content[0].text }) },
  }
}

function makeServices() {
  return {
    timer: {},
    agents: {
      get: agentOf,
      list: () => Array.from(SESSION_CWD.keys()).map(agentOf),
      roots: () => [],
      currentInitiator: () => undefined,
      async resume({ resumeSessionId }) { return { agent: agentOf(resumeSessionId) } },
      async create({ sessionId, meta }) {
        created.push({ sessionId, cwd: meta && meta.cwd, preset: meta && meta.agentPreset })
        SESSION_CWD.set(sessionId, meta && meta.cwd)
        return { agent: agentOf(sessionId) }
      },
    },
    sessions: {
      get: (id) => {
        const cwd = SESSION_CWD.get(id)
        return cwd === undefined ? undefined : { id, header: { cwd } }
      },
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: 'Диалог ' + id } } }))
      },
      async readSurface() {
        return { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'сообщение' }] } }] }
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((w) => w.id === id),
    },
    agentPresets: {
      async list() { return [{ id: 'dev', name: 'Разработчик', trust: 'user' }] },
      async resolve(presetId) { return { id: presetId || 'dev' } },
      async mount() {},
    },
    agentDefaultModel: { currentSelection: () => undefined },
  }
}

function resetWorld() {
  sends = []
  queues.clear()
  created = []
  followups = []
  SESSION_CWD.clear()
  workspaces = WORKSPACE_ROWS.map((row) => {
    for (const sid of row.sessions) SESSION_CWD.set(sid, row.path)
    return {
      id: row.id,
      title: row.title,
      path: row.path,
      sessionIds: row.sessions.slice(),
      attachSession(id) { this.sessionIds.push(id) },
    }
  })
  services = makeServices()
}

// ── запуск моста ────────────────────────────────────────────────────────────
let generation = 0
const intervals = []
let currentLabel

async function boot(registry) {
  fs.writeFileSync(path.join(stateDir, 'projects.json'), JSON.stringify(registry, null, 2))
  generation += 1
  resetWorld()
  intervals.length = 0
  const mod = await import('file:///' + pluginFile.replace(/\\/g, '/') + '?v=' + generation)
  const localCtx = {
    get: (name) => services[name],
    on: () => () => {},
    effect(fn, label) {
      currentLabel = label
      const dispose = fn()
      currentLabel = undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
    interval(fn, ms) {
      intervals.push({ label: currentLabel, ms, fn })
      return () => {}
    },
  }
  mod.default.apply(localCtx)
  return {
    // В мосте один опрос на бота: колбэк берём по метке эффекта и зовём вручную.
    async tick(botId) {
      const item = intervals.find((i) => i.label === 'tg-bridge:poll:' + botId)
      if (!item) throw new Error('нет опроса для бота ' + botId)
      await item.fn()
    },
  }
}

const tokenOf = (botId) => 't-' + botId
const sendsOf = (botId) => sends.filter((s) => s.token === tokenOf(botId))
const lastOf = (botId, method) => {
  const list = sendsOf(botId).filter((s) => s.method === method)
  return list[list.length - 1]
}
const answerOf = (botId) => {
  const last = lastOf(botId, 'answerCallbackQuery')
  return last ? last.payload.text : undefined
}
// Последний экран бота — новое сообщение ИЛИ правка прежнего, что пришло позже.
// Выбирать по методу нельзя: после правки клавиатуры (editMessageText) команда
// отвечает новым сообщением (sendMessage), и предпочтение метода вернуло бы
// экран, которого человек уже не видит.
const lastScreen = (botId) => {
  const list = sendsOf(botId).filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText')
  return list[list.length - 1]
}
const buttonsOf = (botId) => {
  const last = lastScreen(botId)
  const rows = (last && last.payload.reply_markup && last.payload.reply_markup.inline_keyboard) || []
  return rows.flat().map((b) => b.callback_data)
}
const textOf = (botId) => {
  const last = lastScreen(botId)
  return last ? String(last.payload.text || '') : ''
}

async function command(app, botId, text) {
  updateId += 1
  queueUpdate(tokenOf(botId), {
    update_id: updateId,
    message: { from: { id: 1 }, chat: { id: 1 }, text },
  })
  await app.tick(botId)
}

async function press(app, botId, data) {
  updateId += 1
  queueUpdate(tokenOf(botId), {
    update_id: updateId,
    callback_query: { id: 'cb' + updateId, from: { id: 1 }, message: { message_id: 10, chat: { id: 1 } }, data },
  })
  await app.tick(botId)
}

// ── реестры проектов ────────────────────────────────────────────────────────
function projectRow(id, title, workspace, humanClone, telegram) {
  const row = { title, repo: 'gidvantus/' + id, base: 'main', workspace }
  if (humanClone) row.humanClone = humanClone
  if (telegram) row.telegram = telegram
  return row
}

const telegramBot = (id, extra) => ({ token: tokenOf(id), chatId: 1, ...(extra || {}) })

// Реестр основного сценария: вахта — проект default без явного списка, workflow
// перечисляет вахту явно, cloudpass — обычный бот, brain и crm — без ботов.
function registryMain() {
  return {
    version: 1,
    default: 'vahta',
    projects: {
      vahta: projectRow('vahta', 'Вахта', P.vahta, P.vahtaHuman, telegramBot('vahta')),
      workflow: projectRow('workflow', 'Workflow', P.workflow, null, telegramBot('workflow', { projects: ['vahta'] })),
      cloudpass: projectRow('cloudpass', 'CloudPass', P.cloudpass, null, telegramBot('cloudpass')),
      brain: projectRow('brain', 'Brain', P.brain),
      crm: projectRow('crm', 'CRMDormitory', P.crm),
    },
  }
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// ── сценарий 1: бот обычного проекта видит только свои области ─────────────
console.log('=== сценарий 1: бот обычного проекта видит только свои области ===')
let app = await boot(registryMain())
await command(app, 'cloudpass', '/projects')
check('заголовок считает одну область', textOf('cloudpass'), '📂 Проекты (1):\nНажмите на проект, чтобы открыть его сессии.\n🟢 открытые / 🔒 закрытые')
check('в списке только свой проект', buttonsOf('cloudpass'), ['proj:w-cloudpass'])
check('в логе видна привязка бота', logs.some((l) => l === '[tg-bridge] бот "cloudpass" видит проекты: cloudpass'), true)

// ── сценарий 2: бот проекта default видит все области ──────────────────────
console.log('\n=== сценарий 2: бот проекта из default видит все области ===')
app = await boot(registryMain())
await command(app, 'vahta', '/projects')
check('заголовок считает все области', textOf('vahta').split('\n')[0], '📂 Проекты (6):')
check('в списке все области реестра', buttonsOf('vahta'), [
  'proj:w-vahta', 'proj:w-vahta-human', 'proj:w-workflow', 'proj:w-brain', 'proj:w-cloudpass', 'proj:w-crm',
])
check('в логе бот default называет все проекты реестра', logs.some((l) => l === '[tg-bridge] бот "vahta" видит проекты: vahta, workflow, cloudpass, brain, crm'), true)

// ── сценарий 3: telegram.projects — свой проект первым ─────────────────────
console.log('\n=== сценарий 3: бот с telegram.projects видит свой проект и перечисленный ===')
app = await boot(registryMain())
await command(app, 'workflow', '/projects')
check('заголовок считает свой и перечисленный', textOf('workflow').split('\n')[0], '📂 Проекты (3):')
check('свой проект первым, затем перечисленный', buttonsOf('workflow'), [
  'proj:w-workflow', 'proj:w-vahta', 'proj:w-vahta-human',
])
check('в логе порядок видимости', logs.some((l) => l === '[tg-bridge] бот "workflow" видит проекты: workflow, vahta'), true)

// ── сценарий 3б: непустой telegram.projects сильнее правила default ───────
console.log('\n=== сценарий 3б: у проекта из default явный список сужает видимость ===')
// `default` — вахта, и у неё же непустой список: по README бот сужается до
// своего проекта плюс перечисленных, то есть перестаёт быть обзорным.
const registryNarrowDefault = registryMain()
registryNarrowDefault.projects.vahta.telegram.projects = ['workflow']
app = await boot(registryNarrowDefault)
await command(app, 'vahta', '/projects')
check('обзорный бот сужен до своего и перечисленного', textOf('vahta').split('\n')[0], '📂 Проекты (3):')
check('в списке только свой проект и перечисленный', buttonsOf('vahta'), [
  'proj:w-vahta', 'proj:w-vahta-human', 'proj:w-workflow',
])
check('в логе названы только видимые проекты', logs.some((l) => l === '[tg-bridge] бот "vahta" видит проекты: vahta, workflow'), true)

// ── сценарий 5: /sessions и /sessions N считают только видимых ─────────────
console.log('\n=== сценарий 5: /sessions и /sessions N считают только видимые области ===')
app = await boot(registryMain())
await command(app, 'workflow', '/sessions')
const sessionsAll = textOf('workflow')
check('/sessions называет свой проект', sessionsAll.includes('📂 Workflow'), true)
check('/sessions называет перечисленный проект', sessionsAll.includes('📂 Вахта'), true)
check('/sessions не показывает чужие проекты', [
  sessionsAll.includes('Brain'), sessionsAll.includes('CloudPass'), sessionsAll.includes('CRMDormitory'),
], [false, false, false])
await command(app, 'workflow', '/sessions 1')
const sessionsOne = textOf('workflow')
check('/sessions 1 — свой проект', sessionsOne.includes('📂 Workflow'), true)
check('/sessions 1 — не перечисленный', sessionsOne.includes('📂 Вахта'), false)

// ── сценарий 6: кнопки чужого проекта отказывают ──────────────────────────
console.log('\n=== сценарий 6: proj:/new:/newp:/newd: с чужой областью — отказ ===')
app = await boot(registryMain())
for (const data of ['proj:w-vahta', 'new:w-vahta', 'newp:w-vahta:dev', 'newd:w-vahta']) {
  const before = sendsOf('cloudpass').length
  await press(app, 'cloudpass', data)
  check('отказ на ' + data, answerOf('cloudpass'), 'Проект другого бота — откройте его в боте этого проекта')
  check('после ' + data + ' ничего не открыто', sendsOf('cloudpass').length - before, 1)
}
check('сессий не создано', created.length, 0)

// ── сценарий 7: use: с чужой сессией не переключает диалог ────────────────
console.log('\n=== сценарий 7: use: с чужой сессией — отказ, target не переключён ===')
app = await boot(registryMain())
await press(app, 'workflow', 'use:session-vahta-1')
check('отказ на use: чужой сессии', answerOf('workflow'), 'Диалог другого бота — откройте его в боте этого проекта')
await command(app, 'workflow', 'привет')
check('сообщение ушло в свой диалог', followups[followups.length - 1].sessionId, 'session-wf-1')

// ── сценарий 8: у видимой чужой области только чтение ─────────────────────
console.log('\n=== сценарий 8: видимая чужая область — история есть, работы нет ===')
app = await boot(registryMain())
await press(app, 'workflow', 'proj:w-vahta')
const foreignButtons = buttonsOf('workflow')
check('история чужого диалога доступна', foreignButtons.includes('hist:session-vahta-1:10'), true)
check('создания сессии в чужой области нет', foreignButtons.includes('new:w-vahta'), false)
check('переключения чужого диалога нет', foreignButtons.includes('use:session-vahta-1'), false)
check('возврат к списку остался', foreignButtons.includes('back:projects'), true)

// ── сценарий 4: неизвестный id в telegram.projects ────────────────────────
console.log('\n=== сценарий 4: неизвестный id в telegram.projects не роняет старт ===')
const registryUnknown = registryMain()
registryUnknown.projects.workflow.telegram.projects = ['vahta', 'nope', '', 'vahta']
warnings.length = 0
app = await boot(registryUnknown)
check('предупреждение названо один раз', warnings.filter((w) => w.includes('неизвестные проекты')), [
  '[tg-bridge] бот "workflow": в telegram.projects неизвестные проекты: nope',
])
await command(app, 'workflow', '/projects')
check('неизвестный id выброшен, повторы схлопнуты', buttonsOf('workflow'), [
  'proj:w-workflow', 'proj:w-vahta', 'proj:w-vahta-human',
])

// ── сценарий 9: /new без своей рабочей области ────────────────────────────
console.log('\n=== сценарий 9: /new у бота без своей рабочей области ===')
app = await boot({
  version: 1,
  default: 'vahta',
  projects: {
    vahta: projectRow('vahta', 'Вахта', P.vahta, P.vahtaHuman, telegramBot('vahta')),
    solo: projectRow('solo', 'Solo', P.solo, null, telegramBot('solo')),
  },
})
await command(app, 'solo', '/new dev')
check('честный отказ вместо чужого каталога', textOf('solo'), '❌ Не нашёл проект для новой сессии.')
check('сессий не создано', created.length, 0)

// ── сценарий 10: у своего проекта всё как до правки ───────────────────────
console.log('\n=== сценарий 10: у своего проекта всё работает как до правки ===')
app = await boot(registryMain())
await command(app, 'workflow', '/projects')
check('свой проект в списке', buttonsOf('workflow').includes('proj:w-workflow'), true)
await press(app, 'workflow', 'proj:w-workflow')
const ownButtons = buttonsOf('workflow')
check('у своего диалога есть переключение', ownButtons.includes('use:session-wf-1'), true)
check('у своего проекта есть новая сессия', ownButtons.includes('new:w-workflow'), true)
await press(app, 'workflow', 'new:w-workflow')
const picker = buttonsOf('workflow')
check('выбор пресета показывает пресеты', [
  picker.includes('newp:w-workflow:dev'), picker.includes('newd:w-workflow'),
], [true, true])
await press(app, 'workflow', 'newd:w-workflow')
check('сессия создана в своей области', created.map((c) => c.cwd), [P.workflow])
check('после создания показана активация', textOf('workflow').includes('✅ Текущая сессия:'), true)
await command(app, 'workflow', '/new dev')
check('/new создаёт сессию в своей области', created.map((c) => c.cwd), [P.workflow, P.workflow])

// ── сценарий 11: номер и id из списка «только чтение» не открывают диалог ──
// Дыра, которую нашло ревью: отказ стоял только в callback'е `use:`, а /use
// зовёт switchTarget напрямую. При этом lastSessions наполняется чужими
// диалогами (sessionsText нумерует весь видимый список, sessionsPayload —
// открытый на чтение проект), так что id знать не нужно: номер берётся из
// списка, который само изменение сделало «только чтение».
console.log('\n=== сценарий 11: /use номером или id чужой диалог не открывает ===')
app = await boot(registryMain())
await command(app, 'workflow', '/sessions')
// Видимый список: свой проект первым, перечисленная вахта — вторым номером.
await command(app, 'workflow', '/use 2')
check('номер чужого диалога из /sessions — отказ', textOf('workflow'), 'Диалог другого бота — откройте его в боте этого проекта')
await command(app, 'workflow', 'привет')
check('сообщение по-прежнему уходит в свой диалог', followups[followups.length - 1].sessionId, 'session-wf-1')

// Тот же обход через список «только чтение»: proj: чужого проекта кладёт его
// диалоги в нумерацию /sessions, и /use 1 не должен делать их активными.
await press(app, 'workflow', 'proj:w-vahta')
const readOnlyButtons = buttonsOf('workflow')
check('список открыт на чтение', readOnlyButtons.includes('hist:session-vahta-1:10'), true)
await command(app, 'workflow', '/use 1')
check('номер из списка чтения — отказ', textOf('workflow'), 'Диалог другого бота — откройте его в боте этого проекта')
await command(app, 'workflow', 'ещё')
check('и после списка чтения сообщение идёт в свой диалог', followups[followups.length - 1].sessionId, 'session-wf-1')

await command(app, 'workflow', '/use session-vahta-1')
check('прямой id чужой сессии — отказ', textOf('workflow'), 'Диалог другого бота — откройте его в боте этого проекта')
check('чужой диалог так и не стал активным', followups.every((f) => f.sessionId === 'session-wf-1'), true)
// Свой диалог команда по-прежнему открывает.
await command(app, 'workflow', '/use session-wf-1')
check('свой диалог /use открывает как раньше', textOf('workflow').includes('✅ Текущая сессия: session-wf-1'), true)

// ── итог ────────────────────────────────────────────────────────────────────
fs.rmSync(home, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ВСЕ ПРОВЕРКИ ПРОШЛИ')
else console.log('ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
process.exit(failures === 0 ? 0 : 1)
