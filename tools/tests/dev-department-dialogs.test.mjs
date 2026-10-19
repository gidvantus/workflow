// Интеграционный тест диспетчера отдела на РЕАЛЬНОМ модуле: поддельные сервисы,
// поддельная сеть GitHub, поддельные часы. Проверяются: конвейер ролей, один
// диалог на тикет, сторож зависшего хода и — отдельно — сбой модели, который
// не должен тратить попытку задачи.
// Запуск: node .dev-department-dialogs-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const pluginFile = path.join(dshHome, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const home = path.join(process.cwd(), '.dev-department-test-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })

// Общие настройки и реестр проектов — так, как их читает диспетчер.
fs.writeFileSync(path.join(home, 'dev-department.json'), JSON.stringify({
  windows: [{ start: '00:00', stop: '23:59' }],
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, null, 2))
const WORKSPACE = path.join(home, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true })
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  version: 1,
  default: 'vahta',
  projects: {
    vahta: {
      title: 'Тест',
      repo: 'gidvantus/vahta',
      base: 'develop-m',
      workspace: WORKSPACE,
      composeProject: 'vahta-agent',
      department: { enabled: true },
    },
  },
}, null, 2))
fs.writeFileSync(path.join(home, 'github.token'), 'test-token\n')
fs.writeFileSync(path.join(home, 'telegram.json'), JSON.stringify({ token: 't', chatId: '1' }))
process.env.DSH_HOME = home

// ── поддельные часы ─────────────────────────────────────────────────────────
const RealDate = Date
let clock = new RealDate('2026-10-02T13:05:00+03:00').getTime()
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(clock); else super(...args) }
  static now() { return clock }
}
globalThis.Date = FakeDate
const advance = (ms) => { clock += ms }

// ── поддельная сеть ─────────────────────────────────────────────────────────
const issues = new Map()
const comments = []
const telegram = []

function respond(options, payload) {
  if (options.host === 'api.telegram.org') {
    telegram.push(JSON.parse(payload).text)
    return { statusCode: 200, body: '{"ok":true}' }
  }
  const url = new URL('https://api.github.com' + options.path)
  const parts = url.pathname.split('/').filter(Boolean)
  const body = payload ? JSON.parse(payload) : null
  if (parts[0] !== 'repos' || parts[3] !== 'issues') return { statusCode: 404, body: '{"message":"nf"}' }
  const tail = parts.slice(4)
  if (tail.length === 0) {
    const open = [...issues.values()].filter((i) => i.state === 'open')
    return { statusCode: 200, body: JSON.stringify(open) }
  }
  const issue = issues.get(Number(tail[0]))
  if (!issue) return { statusCode: 404, body: '{"message":"nf"}' }
  if (tail.length === 1) return { statusCode: 200, body: JSON.stringify(issue) }
  if (tail[1] === 'comments') {
    comments.push({ number: issue.number, body: body.body })
    return { statusCode: 201, body: '{}' }
  }
  if (tail[1] === 'labels') {
    if (options.method === 'POST') {
      for (const label of body.labels) if (!issue.labels.includes(label)) issue.labels.push(label)
      return { statusCode: 200, body: '{}' }
    }
    if (options.method === 'DELETE') {
      const name = decodeURIComponent(tail[2] || '')
      issue.labels = issue.labels.filter((l) => l !== name)
      return { statusCode: 200, body: '{}' }
    }
  }
  return { statusCode: 404, body: '{"message":"nf"}' }
}

https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    process.nextTick(() => {
      const result = respond(options, payload)
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
  },
})

// ── поддельные сервисы ──────────────────────────────────────────────────────
let created = []
let running = new Set()
let persisted = new Set()
const updatedAt = new Map()
const turnTails = new Map()
const cancelled = []
const prompts = []
const allRequestIds = []
const tools = []

const agents = {
  async create({ sessionId, meta, setup }) {
    created.push({ sessionId, preset: meta.agentPreset })
    running.add(sessionId)
    updatedAt.set(sessionId, Date.now())
    if (setup) await setup({})
  },
  get: (id) => (created.some((c) => c.sessionId === id) ? { id } : undefined),
}
const sessions = { get: (id) => (created.some((c) => c.sessionId === id) ? { id } : undefined) }
const sessionController = {
  async list() {
    return {
      items: created.map((c) => ({
        sessionId: c.sessionId,
        running: running.has(c.sessionId),
        updatedAt: updatedAt.get(c.sessionId) || Date.now(),
        blank: false,
      })),
    }
  },
  async inspect(id) {
    if (persisted.has(id) || created.some((c) => c.sessionId === id)) return { meta: { id } }
    throw new Error('session/not-found')
  },
  async prompt({ sessionId, requestId, content }) {
    prompts.push({ sessionId, requestId, text: content[0].text })
    allRequestIds.push({ sessionId, requestId })
    running.add(sessionId)
    updatedAt.set(sessionId, Date.now())
    return { accepted: true }
  },
  async cancel({ sessionId }) {
    cancelled.push(sessionId)
    running.delete(sessionId)
    return { accepted: true }
  },
  follow({ address }) {
    const events = turnTails.get(address.sessionId) || []
    const records = events.map((event) => ({ type: 'event', event }))
    return (async function* snapshot() { yield { type: 'snapshot', records, cursor: records.length } })()
  },
}
const ownedPaths = new Set()
const createdWorkspaces = []
const services = {
  timer: {},
  tools: { register(tool) { tools.push(tool) } },
  agents,
  sessions,
  agentPresets: { async mount() {} },
  workspaceRegistry: {
    async resolveByPath(p) { return ownedPaths.has(p) ? { path: p, attachSession() {} } : undefined },
    async create(p, title) {
      ownedPaths.add(p)
      createdWorkspaces.push({ path: p, title })
      return { path: p, attachSession() {} }
    },
  },
  sessionController,
  permissionPresets: { set() {}, current: () => 'workspace-write' },
  sessionTitle: { rename() {} },
}

let generation = 0
async function boot() {
  generation += 1
  const mod = await import('file:///' + pluginFile.replace(/\\/g, '/') + '?v=' + generation)
  const localTools = []
  const localCtx = {
    get: (n) => (n === 'tools' ? { register(t) { localTools.push(t) } } : services[n]),
    effect(fn) { fn(); return () => {} },
    interval() { return () => {} },
  }
  mod.default.apply(localCtx)
  return {
    tick: () => localTools.find((t) => t.name === 'dev_department_tick').execute({}),
    status: async () => JSON.parse(await localTools.find((t) => t.name === 'dev_department_status').execute({})),
  }
}

let failures = 0
async function tick(app) {
  const parsed = JSON.parse(await app.tick())
  const list = parsed.result && parsed.result.projects
  return { result: (list && list[0]) || parsed.result, state: parsed.state, raw: parsed.result }
}
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
const lastPrompt = () => prompts[prompts.length - 1]
const setLabels = (number, labels) => { issues.get(number).labels = labels }
const endTurn = (sessionId) => { running.delete(sessionId); advance(3 * 60 * 1000) }
const attemptsOf = (state, project) => state.projects[project].attempts
// Ход упал на старте: модель не ответила, вызовов инструмента не было.
const brokenTurn = (message) => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message, code: 'STREAM_CLOSED' } } } },
]
// Ход упал, но работа в нём была.
const brokenTurnWithWork = (message) => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'начал' }] } } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh', arguments: '{}' } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message, code: 'STREAM_CLOSED' } } } },
]
function reset(extraIssues) {
  issues.clear()
  created = []
  running = new Set()
  persisted = new Set()
  updatedAt.clear()
  turnTails.clear()
  prompts.length = 0
  if (extraIssues) issues.set(extraIssues.number, extraIssues)
}

console.log('=== сценарий 1: конвейер dev → код-ревью → тест и один диалог на тикет ===')
issues.set(100, { number: 100, title: 'Демо-тикет 100', labels: ['ready-for-dev'], state: 'open' })
let app = await boot()
let step = await tick(app)
check('первый шаг — разработчик', step.result.action + ':' + step.result.role, 'dispatched:dev')
const devDialog = step.result.sessionId
check('рабочая область отдела зарегистрирована', createdWorkspaces, [{ path: WORKSPACE, title: 'Тест — отдел' }])

endTurn(devDialog)
setLabels(100, ['for-code-review'])
await tick(app)
step = await tick(app)
check('после разработки — код-ревьюер', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const reviewDialog = step.result.sessionId
check('ревьюеру сказано про метку', lastPrompt().text.includes('for-code-review'), true)
check('ревьюеру сказано про комментарии в PR', lastPrompt().text.includes('gh_pr_comment'), true)
check('диалоги записаны с проектом', Object.keys((await app.status()).dialogs).sort(), ['vahta:code-review:100', 'vahta:dev:100'])

endTurn(reviewDialog)
setLabels(100, ['ready-for-test'])
await tick(app)
step = await tick(app)
check('ревьюер принял — тестировщик', step.result.action + ':' + step.result.role, 'dispatched:tester')
const testerDialog = step.result.sessionId
check('диалоги всех трёх ролей', Object.keys((await app.status()).dialogs).sort(), ['vahta:code-review:100', 'vahta:dev:100', 'vahta:tester:100'])

endTurn(testerDialog)
setLabels(100, ['test-failed'])
await tick(app)
step = await tick(app)
check('возврат из теста в доработку', step.result.action + ':' + step.result.role, 'dispatched:dev')
check('НОВЫЙ диалог не создан', created.length, 3)
check('доработка в прежнем диалоге', step.result.sessionId, devDialog)
check('в задании есть пометка о продолжении', lastPrompt().text.includes('Это тот же диалог'), true)
check('сказано, что вернул тестировщик', lastPrompt().text.includes('тестировщик вернул'), true)

endTurn(devDialog)
setLabels(100, ['for-code-review'])
await tick(app)
step = await tick(app)
check('повторное ревью в прежнем диалоге', step.result.sessionId, reviewDialog)
check('сказано, что ревью повторное', lastPrompt().text.includes('ПОВТОРНО'), true)

endTurn(reviewDialog)
setLabels(100, ['ready-for-test'])
await tick(app)
step = await tick(app)
check('повторный тест в прежнем диалоге', step.result.sessionId, testerDialog)
check('сказано, что проверка повторная', lastPrompt().text.includes('ПОВТОРНО'), true)

endTurn(testerDialog)
setLabels(100, ['tested'])
issues.get(100).state = 'closed'
await app.tick()
check('после приёмки карта диалогов пуста', (await app.status()).dialogs, {})

console.log('\n=== сценарий 2: сбой модели не тратит попытку и уводит в паузу ===')
reset({ number: 200, title: 'Демо-тикет 200', labels: ['ready-for-dev'], state: 'open' })
app = await boot()
step = await tick(app)
const broken = step.result.sessionId
check('задача выдана', step.result.action, 'dispatched')
check('попытка засчитана при выдаче', attemptsOf(step.state, 'vahta')[200], 1)

turnTails.set(broken, brokenTurn('SSE stream ended without [DONE]'))
endTurn(broken)
step = await tick(app)
check('сбой распознан', step.result.action, 'provider-error')
check('причина названа', step.result.message, 'SSE stream ended without [DONE]')
check('пауза 10 минут', step.result.backoffMinutes, 10)
check('попытка НЕ засчитана', attemptsOf(step.state, 'vahta')[200], 0)

advance(60 * 1000)
step = await tick(app)
check('пока пауза — задачи не выдаются', step.result.action, 'backoff')
check('осталось минут', step.result.minutesLeft, 9)
check('новых сессий не создано', created.length, 1)

advance(11 * 60 * 1000)
step = await tick(app)
check('после паузы работа продолжается', step.result.action, 'dispatched')
check('и попытка снова засчитана', attemptsOf(step.state, 'vahta')[200], 1)

console.log('\n=== сценарий 3: сбой с работой внутри — обычная попытка ===')
reset({ number: 300, title: 'Демо-тикет 300', labels: ['ready-for-dev'], state: 'open' })
app = await boot()
step = await tick(app)
const worked = step.result.sessionId
check('задача выдана', step.result.action, 'dispatched')
turnTails.set(worked, brokenTurnWithWork('SSE stream ended without [DONE]'))
endTurn(worked)
step = await tick(app)
check('если работа была — считаем обычно', step.result.action, 'finished-session')
check('и попытка остаётся', attemptsOf(step.state, 'vahta')[300], 1)

console.log('\n=== сценарий 4: зависший ход снимается сторожем ===')
reset({ number: 400, title: 'Демо-тикет 400', labels: ['ready-for-dev'], state: 'open' })
cancelled.length = 0
app = await boot()
step = await tick(app)
const frozen = step.result.sessionId
updatedAt.set(frozen, Date.now() - 45 * 60 * 1000)
advance(3 * 60 * 1000)
step = await tick(app)
check('зависание распознано', step.result.action, 'stuck')
check('снятие отправлено', cancelled, [frozen])
advance(60 * 1000)
step = await tick(app)
check('после снятия конвейер идёт', step.result.action, 'dispatched')

console.log('\n=== сценарий 5: возврат с код-ревью — доработка, и лимит доработок держит петлю ===')
reset({ number: 500, title: 'Демо-тикет 500', labels: ['ready-for-dev'], state: 'open' })
app = await boot()
step = await tick(app)
const dev5 = step.result.sessionId
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev')

let rounds = 0
let dropped = null
for (let i = 0; i < 5 && !dropped; i += 1) {
  endTurn(dev5)
  setLabels(500, ['for-code-review'])
  await tick(app)
  const reviewStep = await tick(app)
  if (reviewStep.result.action !== 'dispatched') { dropped = reviewStep.result; break }
  endTurn(reviewStep.result.sessionId)
  setLabels(500, ['ready-for-dev'])
  const closing = await tick(app)
  check('ревьюер вернул — это движение, а не «без изменений»', closing.result.outcome, 'код-ревьюер вернул в доработку')
  const devStep = await tick(app)
  if (devStep.result.action === 'dropped') { dropped = devStep.result; break }
  rounds += 1
  if (rounds === 1) {
    check('доработка в прежнем диалоге разработчика', devStep.result.sessionId, dev5)
    check('сказано, что вернул код-ревьюер', lastPrompt().text.includes('код-ревьюер вернул'), true)
    check('счётчик доработок растёт', devStep.state.projects.vahta.rework[500], 1)
  }
}
check('петля ограничена лимитом доработок', rounds, 3)
check('тикет снят с конвейера', dropped && dropped.action, 'dropped')
check('причина снятия', dropped && dropped.reason, 'too many rework rounds')

console.log('\n=== служебное ===')
const ids = allRequestIds.map((p) => p.requestId)
check('requestId уникальны', new Set(ids).size, ids.length)
const reused = allRequestIds.filter((p, i) => allRequestIds.findIndex((q) => q.sessionId === p.sessionId) < i)
console.log('заданий всего: ' + allRequestIds.length + ', из них в уже открытые диалоги: ' + reused.length)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
