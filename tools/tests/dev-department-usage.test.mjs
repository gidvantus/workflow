// Проверка второй половины учёта токенов на РЕАЛЬНОМ модуле диспетчера:
// profiles/desktop/plugins/dev-department.mjs (и его usage-ledger.mjs рядом).
//
// Проверяется то, что не видно по CLI: привязка «сессия → тикет» появляется ДО
// первого хода, повторная выдача в тот же диалог не делает вторую запись, карточка
// `dev_department_status` отдаёт `usage` с `sessions[]` и `totals`, сводка смены
// печатает `потрачено #N: …` и `Итого за смену: …` (с ценой только при заданном
// тарифе), а сессия, до которой `sessionQuery` не дотянулся, считается по
// стенограмме на диске.
//
// Поддельные сеть, часы и сервисы; настоящий ~/.dsh не читается и не пишется —
// каталог установки подменяется на песочный ДО импорта модуля.
// Запуск: node dev-department-usage.test.mjs (из каталога tools/tests)
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'

const pluginFile = path.join(process.cwd(), '..', '..', 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const home = path.join(process.cwd(), '.dev-department-usage-home')
fs.rmSync(home, { recursive: true, force: true })
const WORKSPACE = path.join(home, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true })
fs.writeFileSync(path.join(home, 'github.token'), 'test-token\n')
fs.writeFileSync(path.join(home, 'telegram.json'), JSON.stringify({ token: 't', chatId: '1' }))
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  version: 1,
  default: 'workflow',
  projects: {
    workflow: {
      title: 'Тест',
      repo: 'gidvantus/workflow',
      base: 'main',
      workspace: WORKSPACE,
      composeProject: 'workflow-agent',
      department: { enabled: true },
    },
  },
}, null, 2))
const configFile = path.join(home, 'dev-department.json')
const writeConfig = (extra) => fs.writeFileSync(configFile, JSON.stringify(Object.assign({
  windows: [{ start: '00:00', stop: '23:59' }],
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, extra || {}), null, 2))
writeConfig()
process.env.DSH_HOME = home

const bookFile = path.join(home, 'dev-department-usage.json')
const readBook = () => (fs.existsSync(bookFile) ? JSON.parse(fs.readFileSync(bookFile, 'utf8')) : [])
const writeBook = (entries) => fs.writeFileSync(bookFile, JSON.stringify(entries, null, 2) + '\n')

// ── поддельные часы ─────────────────────────────────────────────────────────
const RealDate = Date
let clock = new RealDate('2026-10-26T12:00:00+03:00').getTime()
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
  if (parts[0] !== 'repos') return { statusCode: 404, body: '{"message":"nf"}' }
  if (parts[3] === 'pulls') return { statusCode: 200, body: '[]' }
  if (parts[3] !== 'issues') return { statusCode: 404, body: '{"message":"nf"}' }
  const tail = parts.slice(4)
  if (tail.length === 0) {
    if (options.method === 'POST') {
      const number = 900 + issues.size
      const createdIssue = {
        number, title: body.title, body: body.body, state: 'open',
        labels: [], assignees: [], comments: 0,
        updated_at: '2026-10-26T12:00:00Z',
        html_url: 'https://github.com/gidvantus/workflow/issues/' + number,
      }
      issues.set(number, createdIssue)
      return { statusCode: 201, body: JSON.stringify(createdIssue) }
    }
    return { statusCode: 200, body: JSON.stringify([...issues.values()].filter((i) => i.state === 'open')) }
  }
  const issue = issues.get(Number(tail[0]))
  if (!issue) return { statusCode: 404, body: '{"message":"nf"}' }
  if (tail.length === 1) return { statusCode: 200, body: JSON.stringify(issue) }
  if (tail[1] === 'comments') {
    if (options.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify(comments.filter((c) => c.number === issue.number)) }
    }
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
const updatedAt = new Map()
const prompts = []

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
      })),
    }
  },
  async inspect(id) {
    if (created.some((c) => c.sessionId === id)) return { meta: { id } }
    throw new Error('session/not-found')
  },
  async prompt({ sessionId, requestId, content }) {
    // Снимок книги на момент выдачи: запись обязана быть уже там — до первого хода.
    prompts.push({ sessionId, requestId, text: content[0].text, bookAtPrompt: readBook() })
    running.add(sessionId)
    updatedAt.set(sessionId, Date.now())
    return { accepted: true }
  },
  async cancel({ sessionId }) { running.delete(sessionId); return { accepted: true } },
  follow() {
    return (async function* empty() { yield { type: 'snapshot', records: [], cursor: 0 } })()
  },
}

// Поверхность сессии: события с usage. `throw` — сессия недоступна (прошлая смена).
const surfaces = new Map()
const sessionQuery = {
  async readSurface(id) {
    const value = surfaces.get(id)
    if (value === 'throw') throw new Error('session/not-found')
    return { events: value || [] }
  },
}

const ownedPaths = new Set()
const services = {
  timer: {},
  tools: null, // подставляется ctx.get в boot
  agents,
  sessions,
  agentPresets: { async mount() {} },
  workspaceRegistry: {
    async resolveByPath(p) { return ownedPaths.has(p) ? { path: p, attachSession() {} } : undefined },
    async create(p) { ownedPaths.add(p); return { path: p, attachSession() {} } },
  },
  sessionController,
  permissionPresets: { set() {}, current: () => 'workspace-full' },
  sessionTitle: { rename() {} },
  sessionQuery,
}

let generation = 0
async function boot(options) {
  generation += 1
  // `options.hide` — сервисов нет вовсе (сборка без sessionQuery): ctx.get отдаёт
  // undefined, как в хосте без опубликованного сервиса.
  const hidden = new Set((options && options.hide) || [])
  const mod = await import('file:///' + pluginFile.replace(/\\/g, '/') + '?v=' + generation)
  const localTools = []
  const localCtx = {
    get: (n) => {
      if (hidden.has(n)) return undefined
      return n === 'tools' ? { register(t) { localTools.push(t) } } : services[n]
    },
    effect(fn) { fn(); return () => {} },
    interval() { return () => {} },
  }
  mod.default.apply(localCtx)
  return {
    mod,
    tick: async () => {
      const parsed = JSON.parse(await localTools.find((t) => t.name === 'dev_department_tick').execute({}))
      const list = parsed.result && parsed.result.projects
      return (list && list[0]) || parsed.result
    },
    status: async () => JSON.parse(await localTools.find((t) => t.name === 'dev_department_status').execute({})),
    summary: async () => JSON.parse(await localTools.find((t) => t.name === 'dev_department_summary').execute({})),
  }
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
function checkText(name, haystack, needle) {
  const ok = String(haystack).includes(needle)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + (ok ? 'есть «' + needle + '»' : 'НЕТ «' + needle + '»'))
}
const setLabels = (number, labels) => { issues.get(number).labels = labels }
const endTurn = (sessionId) => { running.delete(sessionId); advance(3 * 60 * 1000) }
const lastPrompt = () => prompts[prompts.length - 1]
const msg = (turn, step, input, output, cacheRead = 0) => ({
  type: 'assistant/message',
  data: { turn, step, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } },
})
const usageRow = (card, role) => (card.sessions || []).find((row) => row.role === role) || {}

// ── сценарий 1: привязка пишется до первого хода и не дублируется ───────────

console.log('=== сценарий 1: книга привязок при выдаче роли ===')
issues.set(15, {
  number: 15, title: 'Считать токены по тикету', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
let app = await boot()
let step = await app.tick()
check('тикет выдан фронтенд-разработчику', step.action + ':' + step.role, 'dispatched:dev-frontend')
const devSession = step.sessionId

let book = readBook()
check('запись появилась при выдаче', book.length, 1)
check('форма записи для диспетчера', {
  project: book[0].project, issue: book[0].issue, role: book[0].role,
  session: book[0].session, source: book[0].source,
}, { project: 'workflow', issue: 15, role: 'dev-frontend', session: devSession, source: 'dispatcher' })
check('запись была в книге ДО первого хода', lastPrompt().bookAtPrompt.length, 1)
check('номер попытки записан', book[0].attempt, 1)

// Роль работает — диспетчер ждёт и книгу не трогает.
step = await app.tick()
check('пока роль работает — ждём', step.action, 'waiting')
check('ожидание книгу не меняет', readBook().length, 1)

endTurn(devSession)
setLabels(15, ['for-code-review', 'area:frontend'])
await app.tick()
step = await app.tick()
check('после разработки — код-ревьюер', step.action + ':' + step.role, 'dispatched:code-review')
const reviewSession = step.sessionId
check('у второй роли своя запись', readBook().length, 2)
check('роль второй записи', readBook()[1].role, 'code-review')
check('и она тоже была до первого хода', lastPrompt().bookAtPrompt.length, 2)

// Возврат с ревью в доработку: тот же диалог, вторая запись не появляется.
endTurn(reviewSession)
setLabels(15, ['ready-for-dev', 'area:frontend'])
step = await app.tick()
step = await app.tick()
check('доработка ушла фронтенду в тот же диалог', step.action + ':' + step.role + ':' + step.sessionId,
  'dispatched:dev-frontend:' + devSession)
check('повторная выдача не добавила вторую запись', readBook().length, 2)
check('в книге по одной записи на сессию', readBook().map((row) => row.session).sort(), [devSession, reviewSession].sort())

// ── сценарий 2: карточка usage в статусе ────────────────────────────────────

console.log('\n=== сценарий 2: карточка usage в dev_department_status ===')
const ANALYST_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TESTER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
surfaces.set(devSession, [msg(1, 1, 1000, 100), msg(2, 1, 500, 50), msg(3, 1, 400, 40)])
surfaces.set(reviewSession, [msg(1, 1, 2000, 200)])
surfaces.set(ANALYST_SESSION, [msg(1, 1, 300, 30)])
surfaces.set(TESTER_SESSION, [])
// Аналитик попал в книгу не диспетчером, а созданием постановки.
book = readBook()
book.push({ at: '2026-10-26T09:00:00.000Z', project: 'workflow', issue: 15, role: 'analyst', session: ANALYST_SESSION, attempt: null, source: 'issue-created' })
book.push({ at: '2026-10-26T09:30:00.000Z', project: 'workflow', issue: 15, role: 'tester', session: TESTER_SESSION, attempt: 1, source: 'dispatcher' })
writeBook(book)

let status = await app.status()
let row = status.projects[0]
check('активный тикет назван', row.activeIssue && row.activeIssue.number, 15)
check('у карточки есть номер тикета', row.usage && row.usage.issue, 15)
check('строки по ролям, включая аналитика', row.usage.sessions.map((s) => s.role).sort(),
  ['analyst', 'code-review', 'dev-frontend', 'tester'])
check('сессия аналитика не ушла в «не привязано», а считается в тикете',
  usageRow(row.usage, 'analyst').in, 300)
check('числа фронтенда сходятся с поверхностью сессии',
  [usageRow(row.usage, 'dev-frontend').turns, usageRow(row.usage, 'dev-frontend').in, usageRow(row.usage, 'dev-frontend').out],
  [3, 1900, 190])
check('итог карточки', row.usage.totals, { in: 4200, out: 420, cacheRead: 0, cacheWrite: 0 })
check('фронтенд-сессия — та же, что выдал диспетчер', usageRow(row.usage, 'dev-frontend').session, devSession)
check('карточка без замечаний', row.usage.problems, [])
check('замечания к числам не выдуманы', status.lastError, null)

// Критерий «карточка и отчёт по токенам показывают одни числа»: тот же тикет, те
// же стенограммы, но через CLI. Правило повтора у них одно — модуль учёта.
function writeTranscriptFor(id, events) {
  const dir = path.join(home, 'sessions', '--D-Agents-Workflow--', 'session-' + id.replace(/^session-/, ''))
  fs.mkdirSync(dir, { recursive: true })
  const rows = [{ type: 'session', version: 3, id: 'session-' + id }, ...events]
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')))
}
writeTranscriptFor(devSession, [msg(1, 1, 1000, 100), msg(2, 1, 500, 50), msg(3, 1, 400, 40)])
writeTranscriptFor(reviewSession, [msg(1, 1, 2000, 200)])
writeTranscriptFor(ANALYST_SESSION, [msg(1, 1, 300, 30)])
const cliModule = await import('file:///' + path.join(process.cwd(), '..', 'issue-tokens.mjs').replace(/\\/g, '/') + '?v=' + Date.now())
const report = await cliModule.buildReport({ dshHome: home, project: 'workflow', issue: 15 })
const cliTicket = (report.tickets.find((ticket) => ticket.issue === 15)) || { totals: {} }
check('CLI по тому же тикету считает те же числа', {
  in: cliTicket.totals.input, out: cliTicket.totals.output,
  cacheRead: cliTicket.totals.cacheRead, cacheWrite: cliTicket.totals.cacheWrite,
}, row.usage.totals)

// Сессия без ходов: карточка говорит об этом, а не молчит.
surfaces.clear()
status = await app.status()
row = status.projects[0]
checkText('сессия без ходов названа словами', row.usage.note, 'ходов ещё нет')
check('ходы при этом нулевые', usageRow(row.usage, 'dev-frontend').turns, 0)

// Тикет, начатый до выкатки учёта: книгу по нему никто не писал.
writeBook(readBook().filter((entry) => !(entry.project === 'workflow' && entry.issue === 15)))
status = await app.status()
row = status.projects[0]
check('тикет без привязки назван словами', row.usage.note, 'тикет не привязан: в книге учёта нет записи — счёт пойдёт со следующей выдачи роли')
check('и строк в карточке нет', row.usage.sessions, [])
check('итоги нулевые, а не отсутствующие', row.usage.totals, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })

// ── сценарий 3: сводка смены ────────────────────────────────────────────────

console.log('\n=== сценарий 3: сводка смены без тарифа и с тарифом ===')
telegram.length = 0
// Смена отчитывается за СВОИ выдачи ролей: возвращаем в книгу записи этой смены
// (в сценарии 2 книгу по тикету чистили, проверяя «тикет не привязан») и одну
// запись прошлой смены — в строку смены она попасть не должна, а в карточку
// статуса должна: карточка про тикет, а не про смену.
const OLD_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
surfaces.clear()
surfaces.set(devSession, [msg(1, 1, 1000, 100), msg(2, 1, 500, 50), msg(3, 1, 400, 40)])
surfaces.set(reviewSession, [msg(1, 1, 2000, 200)])
surfaces.set(OLD_SESSION, [msg(1, 1, 70000, 700)])
const shiftTime = new Date().toISOString()
writeBook([
  { at: shiftTime, project: 'workflow', issue: 15, role: 'dev-frontend', session: devSession, attempt: 1, source: 'dispatcher' },
  { at: shiftTime, project: 'workflow', issue: 15, role: 'code-review', session: reviewSession, attempt: 1, source: 'dispatcher' },
  { at: '2026-10-19T09:00:00.000Z', project: 'workflow', issue: 15, role: 'analyst', session: OLD_SESSION, attempt: null, source: 'issue-created' },
])
const closed = await app.summary()
check('смена закрыта', [closed.sent, closed.closed], [true, ['workflow']])
const summaryText = telegram.join('\n')
checkText('сводка напечатала расход по тикету смены', summaryText, 'потрачено #15:')
checkText('и общий итог смены', summaryText, 'Итого за смену:')
check('без тарифа строки с ценой нет', summaryText.includes('цена '), false)
checkText('строка расхода называет число сессий', summaryText, 'сесси')
checkText('сводка по-прежнему печатает роли смены', summaryText, 'Сессий запущено:')
// Ф2: в дневную цифру входят только выдачи этой смены (1900 + 2000), а запись
// аналитика от 19.10 (70 000) — расход прошлой смены, её здесь нет.
checkText('Ф2: в строку смены попали только её выдачи', summaryText, 'Итого за смену: вход 3 900 · выход 390')
check('Ф2: расход прошлой смены в дневную цифру не попал', summaryText.includes('70 000'), false)
// …а карточка статуса по тому же тикету видит весь тикет целиком.
status = await app.status()
check('Ф2: карточка статуса считает тикет целиком, а не смену', status.projects[0].usage.totals,
  { in: 73900, out: 1090, cacheRead: 0, cacheWrite: 0 })

// Тариф задан человеком — цена появляется; числа тарифа в коде не живут.
writeConfig({ usageRates: { inputUsdPerM: 3, outputUsdPerM: 15, cacheReadUsdPerM: 0.3, cacheWriteUsdPerM: 3 } })
issues.set(17, {
  number: 17, title: 'Токены по тикету, второй прогон', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
issues.delete(15)
surfaces.clear()
app = await boot()
step = await app.tick()
check('второй тикет выдан', step.action + ':' + step.role, 'dispatched:dev-frontend')
const paidSession = step.sessionId
surfaces.set(paidSession, [msg(1, 1, 1000000, 1000)])
telegram.length = 0
await app.summary()
const paidText = telegram.join('\n')
checkText('с тарифом цена напечатана', paidText, 'цена $')
checkText('цена стоит в строке расхода тикета', paidText, 'потрачено #17:')
checkText('и в итоге смены', paidText, 'Итого за смену:')

// ── сценарий 4: запасной путь по стенограмме ────────────────────────────────

console.log('\n=== сценарий 4: без sessionQuery — счёт по стенограмме ===')
writeConfig()
issues.set(18, {
  number: 18, title: 'Токены по стенограмме', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
issues.delete(17)
surfaces.clear()
app = await boot()
step = await app.tick()
check('третий тикет выдан', step.action + ':' + step.role, 'dispatched:dev-frontend')
const diskSession = step.sessionId
// Сессия недоступна живому чтению: прошлая смена или закрытое приложение.
surfaces.set(diskSession, 'throw')
const dir = path.join(home, 'sessions', '--D-Agents-Workflow--', 'session-' + diskSession.replace(/^session-/, ''))
fs.mkdirSync(dir, { recursive: true })
const rows = [
  { type: 'session', version: 3, id: 'session-' + diskSession },
  msg(1, 1, 700, 70),
  msg(2, 1, 300, 30),
]
fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')))
status = await app.status()
row = status.projects[0]
const diskRow = usageRow(row.usage, 'dev-frontend')
check('числа прочитаны со стенограммы', [diskRow.turns, diskRow.in, diskRow.out], [2, 1000, 100])
check('замечаний по целой стенограмме нет', row.usage.problems, [])
check('итог карточки по стенограмме', row.usage.totals, { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0 })

// ── сценарий 5: привязка аналитика при создании постановки ──────────────────
// Вторая точка записи в книгу: сессию аналитика открывает человек, номера тикета в
// её заголовке ещё нет, поэтому привязка появляется только здесь.

console.log('\n=== сценарий 5: аналитик пишет привязку при создании тикета ===')
const analystFile = path.join(process.cwd(), '..', '..', 'agent-presets', 'analyst', 'github.mjs')
const analystMod = await import('file:///' + analystFile.replace(/\\/g, '/') + '?v=' + Date.now())
const analystTools = []
analystMod.default.apply({
  get: (name) => (name === 'tools' ? { register(tool) { analystTools.push(tool) } } : services[name]),
  effect(fn) { fn(); return () => {} },
})
const analystCreate = analystTools.find((tool) => tool.name === 'gh_issue_create')
check('инструмент создания постановки есть', !!analystCreate, true)

const analystSession = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const createdIssue = JSON.parse(await analystCreate.execute(
  { title: 'Новая постановка', body: '## Промт для разработчика\n…' },
  { agent: { id: analystSession } },
))
const analystEntry = readBook().find((entry) => entry.role === 'analyst' && entry.issue === createdIssue.number)
check('запись аналитика появилась', {
  project: analystEntry && analystEntry.project,
  issue: analystEntry && analystEntry.issue,
  session: analystEntry && analystEntry.session,
  source: analystEntry && analystEntry.source,
}, { project: 'workflow', issue: createdIssue.number, session: analystSession, source: 'issue-created' })
check('ответ инструмента говорит о записи', createdIssue.usageLedger, { recorded: true, source: 'issue-created' })

// Одна сессия может создать несколько постановок — у каждого тикета своя запись.
const entriesBefore = readBook().length
const secondIssue = JSON.parse(await analystCreate.execute(
  { title: 'Вторая постановка', body: 'тело' }, { agent: { id: analystSession } },
))
check('вторая постановка — своя запись', readBook().length, entriesBefore + 1)
check('и о ней сказано в ответе', secondIssue.usageLedger.recorded, true)

// Нечитаемая книга: тикет создан, файл не перезаписан, инструмент сказал словами.
const brokenText = '{ книга не разбирается'
fs.writeFileSync(bookFile, brokenText)
const brokenCreate = JSON.parse(await analystCreate.execute(
  { title: 'Постановка при битой книге', body: 'тело' }, { agent: { id: analystSession } },
))
check('битая книга не перезаписана', fs.readFileSync(bookFile, 'utf8'), brokenText)
check('тикет всё равно создан', typeof brokenCreate.number, 'number')
check('и инструмент сказал, что привязка не записана', [brokenCreate.usageLedger.recorded, /повреждена/.test(brokenCreate.usageLedger.reason)], [false, true])
checkText('в причине назван файл', brokenCreate.usageLedger.reason, 'dev-department-usage.json')

// ── сценарий 6: сжатая контекстом сессия (Ф1) ───────────────────────────────

console.log('\n=== сценарий 6: сжатая поверхность читается по стенограмме ===')
writeConfig()
issues.clear()
issues.set(20, {
  number: 20, title: 'Сжатие контекста', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
writeBook([])
surfaces.clear()
app = await boot()
step = await app.tick()
check('тикет по сжатию выдан', step.action + ':' + step.role, 'dispatched:dev-frontend')
const compressedSession = step.sessionId
// Поверхность — то, что видит модель сейчас: прежние ходы вытеснены заменой
// (`surfaceOp.op === 'replace'`), в ответе readSurface их уже нет. Сами события
// `compaction/*` в поверхность не попадают никогда — она состоит из четырёх
// видов сообщений, поэтому признак сжатия — метка замены.
surfaces.set(compressedSession, [
  {
    type: 'user/message',
    data: { message: { role: 'user', content: [] } },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 },
  },
  msg(6, 1, 250, 25),
])
writeTranscriptFor(compressedSession, [msg(1, 1, 1000, 100), msg(2, 1, 2000, 200), msg(6, 1, 250, 25)])
status = await app.status()
row = status.projects[0]
const compactedRow = usageRow(row.usage, 'dev-frontend')
check('Ф1: сжатая сессия посчитана по стенограмме, а не по короткой поверхности',
  [compactedRow.turns, compactedRow.in, compactedRow.out], [3, 3250, 325])
check('Ф1: целая стенограмма — замечаний нет', row.usage.problems, [])

// Стенограммы ещё нет (свежая сессия не успела лечь на диск): числа поверхности
// остаются, но карточка говорит, что они меньше настоящих, — молчаливых нулей нет.
const compressedDir = path.join(home, 'sessions', '--D-Agents-Workflow--',
  'session-' + compressedSession.replace(/^session-/, ''))
fs.rmSync(compressedDir, { recursive: true, force: true })
status = await app.status()
row = status.projects[0]
check('Ф1: без стенограммы числа поверхности не выброшены', usageRow(row.usage, 'dev-frontend').in, 250)
checkText('Ф1: и о сжатии сказано человеку', (row.usage.problems || []).join(' '), 'сжата')

// ── сценарий 7: сборка без sessionQuery (Ф4) ────────────────────────────────

console.log('\n=== сценарий 7: sessionQuery не обязательная зависимость ===')
issues.clear()
issues.set(21, {
  number: 21, title: 'Сборка без сервиса опроса', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
writeBook([])
surfaces.clear()
app = await boot({ hide: ['sessionQuery'] })
check('Ф4: sessionQuery не объявлен в inject', app.mod.default.inject.includes('sessionQuery'), false)
step = await app.tick()
check('Ф4: без сервиса опроса отдел всё равно поднимается и выдаёт роль',
  step.action + ':' + step.role, 'dispatched:dev-frontend')
const noQuerySession = step.sessionId
writeTranscriptFor(noQuerySession, [msg(1, 1, 400, 40)])
status = await app.status()
row = status.projects[0]
check('Ф4: расход прочитан стенограммой', usageRow(row.usage, 'dev-frontend').in, 400)
checkText('Ф4: карточка отдаётся, а не падает', JSON.stringify(row.usage.totals), '"in":400')

// ── сценарий 8: в смене тикет без записи в книге (Ф3) ───────────────────────

console.log('\n=== сценарий 8: нули вместо расхода не печатаются ===')
issues.clear()
issues.set(22, {
  number: 22, title: 'Тикет, заведённый до книги', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
writeBook([])
surfaces.clear()
app = await boot()
step = await app.tick()
check('тикет без привязки выдан', step.action + ':' + step.role, 'dispatched:dev-frontend')
surfaces.set(step.sessionId, [msg(1, 1, 900, 90)])
// Книгу по тикету никто не писал: он заведён до выкатки учёта.
writeBook([])
telegram.length = 0
await app.summary()
const noDataText = telegram.join('\n')
checkText('Ф3: строка смены говорит словами вместо нулей', noDataText, 'потрачено #22: тикет не привязан')
check('Ф3: нулей в строке смены нет', noDataText.includes('вход 0'), false)
check('Ф3: итог из нулей не печатается', noDataText.includes('Итого за смену'), false)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
