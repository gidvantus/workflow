// Проверка второй половины учёта токенов на РЕАЛЬНОМ модуле диспетчера
// (plugins/dev-department.mjs и его usage-ledger.mjs рядом).
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
// Запуск: node dev-department-usage.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { pluginFile as hostPluginFile } from '../plugin-paths.mjs'

// Раскладки знает помощник: боевой модуль берётся из рабочей копии, из
// установленного пакета или из старой раскладки — что найдётся.
const pluginFile = hostPluginFile('dev-department')
const home = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dev-department-usage-home')
fs.rmSync(home, { recursive: true, force: true })
const WORKSPACE = path.join(home, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true })
fs.mkdirSync(path.join(home, 'mcp', 'github-mcp-server'), { recursive: true })
fs.writeFileSync(path.join(home, 'mcp', 'github-mcp-server', 'token'), 'test-token\n')
// Файлы состояния отдела лежат в каталоге профиля, а не в корне каталога
// установки: набор сеет их туда же, куда пишет боевой модуль.
const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
// Бот проекта живёт только в реестре: сводку тест ловит поддельным Telegram,
// поэтому бот задан полем telegram записи проекта, а не общим файлом.
fs.writeFileSync(path.join(stateDir, 'projects.json'), JSON.stringify({
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
      telegram: { token: 't', chatId: '1' },
    },
  },
}, null, 2))
const configFile = path.join(stateDir, 'dev-department.json')
const writeConfig = (extra) => fs.writeFileSync(configFile, JSON.stringify(Object.assign({
  windows: [{ start: '00:00', stop: '23:59' }],
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, extra || {}), null, 2))
writeConfig()
process.env.DSH_HOME = home

const bookFile = path.join(stateDir, 'dev-department-usage.json')
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

// Диспетчер говорит с GitHub только по MCP (с переездом GitHub на сервер), поэтому
// поддельный сервер отвечает на те же инструменты, что и штатный
// github-mcp-server: list_issues, issue_read, add_issue_comment, list_pull_requests,
// issue_write. HTTP к api.github.com не перехватывается: если диспетчер вернётся к
// своему REST-клиенту, тест упадёт на реальной сети, а не тихо пройдёт на заглушке.
const mcpCalls = []

function replyText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
}

function replyError(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function issueShape(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    labels: (issue.labels || []).slice(),
    created_at: issue.created_at || '2026-10-01T00:00:00Z',
    updated_at: issue.updated_at || '2026-10-01T00:00:00Z',
    user: { login: 'gidvantus' },
    assignees: [],
  }
}

function mcpTool(name, args) {
  mcpCalls.push({ name, args })
  if (name === 'list_issues') {
    const open = [...issues.values()].filter((i) => i.state === 'open').sort((a, b) => a.number - b.number)
    return replyText({ issues: open.map(issueShape), totalCount: open.length, pageInfo: { hasNextPage: false } })
  }
  if (name === 'issue_read') {
    const issue = issues.get(Number(args.issue_number))
    if (!issue) return replyError('failed to get issue: 404 Not Found')
    if (args.method === 'get') return replyText(issueShape(issue))
    if (args.method === 'get_labels') {
      const labels = issue.labels || []
      return replyText({ labels: labels.map((label) => ({ name: label })), totalCount: labels.length })
    }
    if (args.method === 'get_comments') {
      const page = Number(args.page || 1)
      const perPage = Number(args.perPage || 30)
      const all = comments.filter((c) => c.number === issue.number)
      return replyText(all.slice((page - 1) * perPage, page * perPage)
        .map((c, at) => ({ id: 1000 + at, body: c.body, user: { login: c.user } })))
    }
    return replyError('unsupported method ' + args.method)
  }
  if (name === 'add_issue_comment') {
    const issue = issues.get(Number(args.issue_number))
    if (!issue) return replyError('failed to create comment: 404 Not Found')
    comments.push({ number: issue.number, body: args.body, user: 'dispatcher' })
    return replyText({ id: 5000 + comments.length, url: 'https://github.com/x/y/issues/' + issue.number })
  }
  if (name === 'list_pull_requests') return replyText([])
  if (name === 'issue_write') {
    const issue = issues.get(Number(args.issue_number))
    if (!issue) return replyError('failed to update issue: 404 Not Found')
    // Как у настоящего сервера: набор меток ЗАМЕНЯЕТСЯ целиком.
    if (args.method === 'update' && Array.isArray(args.labels)) issue.labels = args.labels.slice()
    return replyText({ id: String(issue.number), url: 'https://github.com/x/y/issues/' + issue.number })
  }
  return replyError('unknown tool ' + name)
}

// Подмена spawn: поддельный сервер MCP живёт в том же процессе. Штатный диспетчер
// импортирует spawn из node:child_process, поэтому правим сам модуль и
// синхронизируем именованные экспорты (syncBuiltinESMExports).
const { createRequire } = await import('node:module')
const { syncBuiltinESMExports } = await import('node:module')
const requireCjs = createRequire(import.meta.url)
const childProcess = requireCjs('node:child_process')
childProcess.spawn = () => {
  const stdoutHandlers = []
  const child = {
    stdout: {
      setEncoding() {},
      on(event, fn) { if (event === 'data') stdoutHandlers.push(fn) },
    },
    stderr: { setEncoding() {}, on() {} },
    stdin: {
      writable: true,
      write(line) {
        let message
        try { message = JSON.parse(line) } catch (error) { return }
        setImmediate(() => {
          let answer
          if (message.method === 'initialize') {
            answer = {
              jsonrpc: '2.0', id: message.id,
              result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-github-mcp', version: '0.0.0' } },
            }
          } else if (message.method === 'tools/call') {
            answer = { jsonrpc: '2.0', id: message.id, result: mcpTool(message.params.name, message.params.arguments || {}) }
          } else {
            return
          }
          for (const handler of stdoutHandlers) handler(JSON.stringify(answer) + '\n')
        })
        return true
      },
    },
    on() { return child },
    kill() {},
  }
  return child
}
syncBuiltinESMExports()

// Telegram по-прежнему идёт HTTP: его канал не менялся.
function respondTelegram(options, payload) {
  if (options.host === 'api.telegram.org') {
    telegram.push(JSON.parse(payload).text)
    return { statusCode: 200, body: '{"ok":true}' }
  }
  return { statusCode: 500, body: '{"message":"неожиданный HTTP: диспетчер должен ходить в GitHub только через MCP"}' }
}

https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    process.nextTick(() => {
      const result = respondTelegram(options, payload)
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
// Упавшая попытка шага: usage приходит потоком, в настоящей форме стенограммы DSH
// ({ type: 'chunk', chunk: { type: 'usage', usage: {…} } }).
const attemptUsage = (turn, step, input, output) => ({
  type: 'assistant/attempt',
  data: {
    turn,
    step,
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output } } }],
  },
})
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { retryId: 'r-1', turn, step, retry: 1 } })
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
// Б4: `source` записи книги доходит до строки карточки. На этой машине сессию
// постановки открывает человек под пресетом `standard`, поэтому по одной роли её
// от роли конвейера не отличить — признак живёт в `source`.
check('Б4: origin записи книги виден в строке карточки',
  [usageRow(row.usage, 'analyst').source, usageRow(row.usage, 'dev-frontend').source],
  ['issue-created', 'dispatcher'])
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
const cliModule = await import('file:///' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'issue-tokens.mjs').replace(/\\/g, '/') + '?v=' + Date.now())
const report = await cliModule.buildReport({ dshHome: home, project: 'workflow', issue: 15 })
const cliTicket = (report.tickets.find((ticket) => ticket.issue === 15)) || { totals: {} }
check('CLI по тому же тикету считает те же числа', {
  in: cliTicket.totals.input, out: cliTicket.totals.output,
  cacheRead: cliTicket.totals.cacheRead, cacheWrite: cliTicket.totals.cacheWrite,
}, row.usage.totals)

// Сессия без ходов: карточка говорит об этом, а не молчит. Стенограммы этих сессий
// появились выше только для сверки с отчётом, и пока их нет, источник — живая
// поверхность: свежая сессия ещё не легла на диск, и это нормальное состояние.
for (const id of [devSession, reviewSession, ANALYST_SESSION]) {
  fs.rmSync(path.join(home, 'sessions', '--D-Agents-Workflow--', 'session-' + id.replace(/^session-/, '')),
    { recursive: true, force: true })
}
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

// ── сценарий 5: сессия постановки привязывается к тикету ────────────────────
// Своего крючка «тикет создан» у отдела больше нет: постановку создаёт MCP-сервер
// (чужой процесс), а сессию открывает человек, и номера тикета в её заголовке ещё
// нет. Поэтому привязку даёт первый тик, увидевший новый тикет: он берёт сессию
// каталога проекта, чья жизнь накрывает `created_at` тикета и которая ещё ни к
// какому тикету не привязана.

console.log('\n=== сценарий 5: сессия постановки привязывается к тикету ===')

// Сессия постановки: каталог проекта, пресет аналитика. Первое событие стенограммы —
// `session` с `cwd`, `agentPreset` и `createdAt`; его и читает привязка.
function writeSessionHead(id, options) {
  const opts = options || {}
  const dir = path.join(home, 'sessions', '--D-Agents-Workflow--', 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  const head = {
    type: 'session',
    version: 3,
    id: 'session-' + id,
    createdAt: opts.createdAt || Date.now(),
    cwd: opts.cwd || WORKSPACE,
    agentPreset: opts.preset || 'analyst',
  }
  const rows = [head, msg(1, 1, 400, 40)]
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')))
  // Время последней записи — это «когда сессия ещё жила». Часы в тесте поддельные,
  // поэтому mtime ставим руками: иначе привязка зависела бы от настоящего времени.
  const at = new Date(opts.updatedAt || Date.now())
  fs.utimesSync(file, at, at)
  return id
}

issues.clear()
writeBook([])
surfaces.clear()
const ANALYST_BIND = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
writeSessionHead(ANALYST_BIND)
issues.set(40, {
  number: 40, title: 'Постановка аналитика', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
  created_at: new Date().toISOString(),
})
app = await boot()
step = await app.tick()
check('новый тикет выдан роли', step.action, 'dispatched')
const bound = readBook().find((entry) => entry.issue === 40 && entry.source === 'issue-created')
check('сессия постановки привязана к тикету', {
  project: bound && bound.project,
  issue: bound && bound.issue,
  role: bound && bound.role,
  session: bound && bound.session,
  source: bound && bound.source,
}, { project: 'workflow', issue: 40, role: 'analyst', session: ANALYST_BIND, source: 'issue-created' })

// Повторный тик второй записи не делает: сессия уже привязана.
const bookAfterBind = readBook().length
await app.tick()
check('повторный тик привязку не дублирует', readBook().length, bookAfterBind)

// Тикет, заведённый до выкатки учёта, задним числом в книгу не попадает: его
// история видна только блоком «восстановлено по заголовку» в отчёте.
writeBook([])
issues.clear()
issues.set(41, {
  number: 41, title: 'Тикет из прошлого', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
  created_at: '2026-09-01T00:00:00Z',
})
app = await boot()
await app.tick()
check('старый тикет задним числом не привязан',
  readBook().filter((entry) => entry.issue === 41 && entry.source === 'issue-created').length, 0)

// Сессия вне каталога проекта (чужая рабочая область) не привязывается: правило
// проекта — по каталогу, а не «любая свежая сессия».
writeBook([])
issues.clear()
const STRANGER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
writeSessionHead(STRANGER, { cwd: path.join(home, 'somewhere-else') })
issues.set(42, {
  number: 42, title: 'Чужая сессия', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
  created_at: new Date().toISOString(),
})
app = await boot()
await app.tick()
check('сессия чужого каталога к тикету не привязывается',
  readBook().filter((entry) => entry.session === STRANGER).length, 0)
issues.delete(42)

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

// Стенограммы ещё нет (свежая сессия не успела лечь на диск): источник — живая
// поверхность, и это обычное состояние, а не сбой: отчёт по токенам эту сессию тоже
// ещё не видит, поэтому расхождения «карточка ≠ отчёт» здесь нет. Молчаливых нулей
// по-прежнему не бывает: числа поверхности не выбрасываются.
const compressedDir = path.join(home, 'sessions', '--D-Agents-Workflow--',
  'session-' + compressedSession.replace(/^session-/, ''))
fs.rmSync(compressedDir, { recursive: true, force: true })
status = await app.status()
row = status.projects[0]
check('Б3: без стенограммы живая поверхность — законный источник', usageRow(row.usage, 'dev-frontend').in, 250)
check('Б3: и замечания об этом нет — это не недосчёт', row.usage.problems, [])

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

// ── сценарий 9: доработка в том же диалоге на следующей смене ───────────────
// Воспроизведение возврата ревьюера: привязка у диалога одна (дедуп книги), поэтому
// у доработки `at` остаётся от прошлой смены, и отсечка по времени выбрасывала её из
// дневной сводки — «потрачено» пропадало ровно на самом дорогом участке конвейера.

console.log('\n=== сценарий 9: расход продолженного диалога попадает в свою смену ===')
writeConfig()
issues.clear()
issues.set(30, {
  number: 30, title: 'Доработка через сутки', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
writeBook([])
surfaces.clear()
app = await boot()
step = await app.tick()
check('смена 1 выдала роль', step.action + ':' + step.role, 'dispatched:dev-frontend')
const carriedSession = step.sessionId
surfaces.set(carriedSession, [msg(1, 1, 1000, 100)])
endTurn(carriedSession)
setLabels(30, ['for-code-review', 'area:frontend'])
await app.tick()
step = await app.tick()
check('смена 1 довела до ревью', step.action + ':' + step.role, 'dispatched:code-review')
surfaces.set(step.sessionId, [])
endTurn(step.sessionId)
const bookAfterShift1 = readBook().length
check('в книге две привязки смены 1', bookAfterShift1, 2)
await app.summary()

// Сутки спустя: доработка идёт в ТОТ ЖЕ диалог разработчика. Дедуп книги второй
// записи не делает, `at` остаётся от смены 1 — а расход в эту смену есть.
advance(24 * 60 * 60 * 1000)
setLabels(30, ['ready-for-dev', 'area:frontend'])
surfaces.set(carriedSession, [msg(1, 1, 1000, 100), msg(2, 1, 1500, 150)])
// Первый тик новой смены закрывает шаг, закончившийся до её начала; выдачу даёт
// следующий — ровно как в сценарии 1.
step = await app.tick()
if (step.action === 'finished-session') step = await app.tick()
check('смена 2 продолжила тот же диалог', step.action + ':' + step.role + ':' + step.sessionId,
  'dispatched:dev-frontend:' + carriedSession)
check('второй записи в книге нет', readBook().length, bookAfterShift1)
telegram.length = 0
await app.summary()
const carriedText = telegram.join('\n')
checkText('Ф1: расход продолженного диалога посчитан в своей смене', carriedText, 'потрачено #30: вход 2 500')
checkText('Ф1: продолженный диалог назван пометкой', carriedText, 'в т.ч. продолженный диалог: 1')
checkText('Ф1: итог смены напечатан', carriedText, 'Итого за смену: вход 2 500')
check('Ф1: «не выделен» больше не печатается', carriedText.includes('не выделен'), false)

// ── сценарий 10: шаг с повтором — карточка считает как отчёт (Б3) ───────────
// Живая поверхность состоит из четырёх видов сообщений (`SurfaceEventType`) и не
// несёт ни `assistant/attempt`, ни `llm/retry-started`. Пока карточка читала
// поверхность, шаг с повтором считался по ней короче, чем в стенограмме, и
// «Готово, когда 5» (числа карточки равны числам CLI) ломалось ровно на повторах.
// Теперь источник — стенограмма, а поверхность остаётся свежей сессии без файла.

console.log('\n=== сценарий 10: повтор шага считается по стенограмме (Б3) ===')
writeConfig()
issues.clear()
// `created_at` не задан — тикет не кандидат на привязку сессии постановки, и
// единственная запись книги у него будет от диспетчера.
issues.set(50, {
  number: 50, title: 'Повтор шага', state: 'open', body: 'постановка',
  labels: ['ready-for-dev', 'area:frontend'], assignees: [],
})
writeBook([])
surfaces.clear()
app = await boot()
step = await app.tick()
check('тикет с повтором выдан', step.action + ':' + step.role, 'dispatched:dev-frontend')
const retrySession = step.sessionId
// Поверхность: только готовое сообщение — попытки и события повтора в ней нет.
surfaces.set(retrySession, [msg(1, 1, 800, 80)])
writeTranscriptFor(retrySession, [attemptUsage(1, 1, 700, 70), retryStarted(1, 1), msg(1, 1, 800, 80)])
status = await app.status()
row = status.projects[0]
check('Б3: карточка читает стенограмму, а не короткую поверхность',
  [usageRow(row.usage, 'dev-frontend').in, usageRow(row.usage, 'dev-frontend').out], [1500, 150])
check('Б3: целая стенограмма — замечаний нет', row.usage.problems, [])
const retryReport = await cliModule.buildReport({ dshHome: home, project: 'workflow', issue: 50 })
const retryTicket = retryReport.tickets.find((ticket) => ticket.issue === 50) || { totals: {} }
check('Б3: числа карточки равны числам отчёта',
  [retryTicket.totals.input, retryTicket.totals.output], [row.usage.totals.in, row.usage.totals.out])

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
