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
// PR тестового проекта: номер → { number, head: { ref, sha } }. Пустой список
// значит «PR нет»: тогда маршрут решает метка, как раньше.
const pulls = new Map()
// Файлы PR и счётчик их чтений. Список отдаётся, но диспетчер нового поколения
// его не запрашивает: маршрут решают пути замечаний, а не состав PR.
let pullFiles = []
let pullFilesReads = 0
// Замечания и вердикты ревьюера живут комментариями PR — как в жизни.
const reviewer = (number, text) => comments.push({ number, body: text, user: 'reviewer' })

function respond(options, payload) {
  if (options.host === 'api.telegram.org') {
    telegram.push(JSON.parse(payload).text)
    return { statusCode: 200, body: '{"ok":true}' }
  }
  const url = new URL('https://api.github.com' + options.path)
  const parts = url.pathname.split('/').filter(Boolean)
  const body = payload ? JSON.parse(payload) : null
  if (parts[0] !== 'repos') return { statusCode: 404, body: '{"message":"nf"}' }
  if (parts[3] === 'pulls') {
    if (parts.length === 4) return { statusCode: 200, body: JSON.stringify([...pulls.values()]) }
    if (parts[5] === 'files') {
      pullFilesReads += 1
      return { statusCode: 200, body: JSON.stringify(pullFiles) }
    }
    return { statusCode: 404, body: '{"message":"nf"}' }
  }
  if (parts[3] !== 'issues') return { statusCode: 404, body: '{"message":"nf"}' }
  const tail = parts.slice(4)
  if (tail.length === 0) {
    const open = [...issues.values()].filter((i) => i.state === 'open')
    return { statusCode: 200, body: JSON.stringify(open) }
  }
  const issue = issues.get(Number(tail[0]))
  if (!issue) return { statusCode: 404, body: '{"message":"nf"}' }
  if (tail.length === 1) return { statusCode: 200, body: JSON.stringify(issue) }
  if (tail[1] === 'comments') {
    if (options.method === 'GET') {
      return { statusCode: 200, body: JSON.stringify(comments.filter((c) => c.number === issue.number)) }
    }
    comments.push({ number: issue.number, body: body.body, user: 'dispatcher' })
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
check('первый шаг — разработчик', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
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
check('диалоги записаны с проектом', Object.keys((await app.status()).dialogs).sort(), ['vahta:code-review:100', 'vahta:dev-fullstack:100'])

endTurn(reviewDialog)
setLabels(100, ['ready-for-test'])
await tick(app)
step = await tick(app)
check('ревьюер принял — тестировщик', step.result.action + ':' + step.result.role, 'dispatched:tester')
const testerDialog = step.result.sessionId
check('диалоги всех трёх ролей', Object.keys((await app.status()).dialogs).sort(), ['vahta:code-review:100', 'vahta:dev-fullstack:100', 'vahta:tester:100'])

endTurn(testerDialog)
setLabels(100, ['test-failed'])
await tick(app)
step = await tick(app)
check('возврат из теста в доработку', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
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
await tick(app)
step = await tick(app)
check('финал конвейера — DevOps-инженер', step.result.action + ':' + step.result.role, 'dispatched:devops-delivery')
const mergeSession = step.result.sessionId
endTurn(mergeSession)
setLabels(100, ['merged'])
issues.get(100).state = 'closed'
await tick(app)
check('после слияния карта диалогов пуста', (await app.status()).dialogs, {})

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
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')

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

console.log('\n=== сценарий 6: нужен макет — дизайнер рисует его до разработки ===')
// Человек поставил ready-for-dev заранее: макет всё равно идёт первым.
reset({ number: 600, title: 'Демо-тикет 600', labels: ['needs-mockup', 'ready-for-dev'], state: 'open' })
app = await boot()
step = await tick(app)
check('первым берётся макет, а не разработка', step.result.action + ':' + step.result.role, 'dispatched:design')
const designDialog = step.result.sessionId
check('задание по скиллу макета', lastPrompt().text.includes('mockup-delivery'), true)
check('сказано, что это макет', lastPrompt().text.includes('МАКЕТ'), true)
check('реализацию не просят', lastPrompt().text.includes('PR НЕ открывать'), true)
check('диалог открыт для роли design', Object.keys((await app.status()).dialogs).includes('vahta:design:600'), true)

// Дизайнер закончил ход, но mockups-ready не поставил: ступень повторяется.
endTurn(designDialog)
setLabels(600, ['needs-mockup', 'ready-for-dev'])
step = await tick(app)
check('ход без готового макета — не прогресс', step.result.outcome, 'без изменения меток')
step = await tick(app)
check('без mockups-ready макет выдаётся снова', step.result.action + ':' + step.result.role, 'dispatched:design')
check('и это тот же диалог дизайнера', step.result.sessionId, designDialog)
endTurn(designDialog)

// Дизайнер сдал макет: тикет уходит в разработку.
setLabels(600, ['needs-mockup', 'mockups-ready', 'ready-for-dev'])
step = await tick(app)
check('сдача макета — это прогресс', step.result.outcome, 'макет постановки готов, ждёт человека')
step = await tick(app)
check('после макета — разработчик полного стека', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
check('макет назван в задании разработчику', lastPrompt().text.includes('mockups/600'), true)
check('готовый макет не считается доработкой', step.state.projects.vahta.rework[600], undefined)

console.log('\n=== сценарий 7: возврат из ревью уходит половине по путям замечаний ===')
// В PR перевес бэкенд-файлов (20 против 5), но замечания назвали только
// фронтенд-пути. Маршрут по составу PR увёл бы доработку бэкендеру, который по
// границам frontend/ не правит: именно так vahta #193 потерял три доработки.
reset({ number: 700, title: 'Демо-тикет 700', labels: ['ready-for-dev', 'area:backend'], state: 'open' })
pulls.clear()
comments.length = 0
pullFilesReads = 0
pullFiles = [
  ...Array.from({ length: 20 }, (_, i) => ({ filename: 'backend/app/module' + i + '.py' })),
  ...Array.from({ length: 5 }, (_, i) => ({ filename: 'frontend/src/screen' + i + '.js' })),
]
pulls.set(700, { number: 700, head: { ref: 'feature/700-subscription', sha: 'sha-700-1' } })
app = await boot()
step = await tick(app)
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev-backend')
const dev7 = step.result.sessionId
endTurn(dev7)
setLabels(700, ['for-code-review'])
await tick(app)
step = await tick(app)
check('ревьюер смотрит PR', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const review7 = step.result.sessionId
reviewer(700, 'BLOCKED\n\nfrontend/src/lib/vacancySubscription.js:41 — не показан признак отписки\nfrontend/src/api/auth.js — у запроса нет заголовка')
endTurn(review7)
setLabels(700, ['ready-for-dev'])
const closing7 = await tick(app)
check('возврат ревьюера — это движение', closing7.result.outcome, 'код-ревьюер вернул в доработку')
step = await tick(app)
check('доработка ушла половине из замечаний', step.result.action + ':' + step.result.role, 'dispatched:dev-frontend')
check('в задании названы пути замечаний', lastPrompt().text.includes('frontend/src/lib/vacancySubscription.js'), true)
check('в задании сказано, чья это половина', lastPrompt().text.includes('в твоей половине'), true)
check('в комментарии тикета есть след маршрута', comments.some((c) => c.number === 700 && c.body.includes('→ dev-frontend: frontend/src/lib/vacancySubscription.js')), true)
check('счётчик доработок вырос', step.state.projects.vahta.rework[700], 1)
check('состав PR больше не читается', pullFilesReads, 0)

console.log('\n=== сценарий 8: круг без нового коммита не тратит ревью ===')
reset({ number: 800, title: 'Демо-тикет 800', labels: ['ready-for-dev'], state: 'open' })
pulls.clear()
comments.length = 0
pullFiles = []
pulls.set(800, { number: 800, head: { ref: 'feature/800-empty-round', sha: 'sha-800-1' } })
app = await boot()
step = await tick(app)
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
const dev8 = step.result.sessionId
endTurn(dev8)
setLabels(800, ['for-code-review'])
await tick(app)
step = await tick(app)
check('ревьюер вызван впервые', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const review8 = step.result.sessionId
// Ревьюер вернул тикет, разработчик отчитался о правке, но нового коммита нет:
// head PR остался тем же.
endTurn(review8)
setLabels(800, ['ready-for-dev'])
await tick(app)
step = await tick(app)
check('возврат из ревью — доработка разработчику', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
endTurn(dev8)
setLabels(800, ['for-code-review'])
await tick(app)
step = await tick(app)
check('ревизия не менялась — ревьюер не зван', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
check('счётчик доработок не вырос', step.state.projects.vahta.rework[800], 1)
check('в issue сказано про неизменённую ревизию', comments.some((c) => c.number === 800 && c.body.includes('ветка не менялась с прошлого ревью')), true)
check('ревьюер за пустой круг не звался', created.filter((c) => c.preset === 'code-review').length, 1)
check('о снятии речи нет', comments.some((c) => c.number === 800 && c.body.includes('два круга подряд без нового коммита')), false)
// Новый коммит снимает пустой круг: ревизия сменилась, ревьюер снова нужен, и
// накопленный noop обнуляется — иначе честный круг стоил бы тикету одного пустого.
endTurn(dev8)
setLabels(800, ['for-code-review'])
pulls.set(800, { number: 800, head: { ref: 'feature/800-empty-round', sha: 'sha-800-2' } })
await tick(app)
step = await tick(app)
check('новый коммит снова зовёт ревьюера', step.result.action + ':' + step.result.role, 'dispatched:code-review')
check('счётчик доработок не изменился', step.state.projects.vahta.rework[800], 1)
const review8b = step.result.sessionId
// Ревьюер вернул, а коммита снова нет: это первый пустой круг после честного.
endTurn(review8b)
setLabels(800, ['ready-for-dev'])
await tick(app)
step = await tick(app)
check('возврат из ревью снова доработка', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
endTurn(dev8)
setLabels(800, ['for-code-review'])
await tick(app)
step = await tick(app)
check('после честного круга пустой круг снова первый', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
check('тикет ещё на конвейере', step.result.action, 'dispatched')
// Второй пустой круг подряд: тикет уходит человеку.
const unchangedBefore = comments.filter((c) => c.number === 800 && c.body.includes('ветка не менялась')).length
endTurn(dev8)
setLabels(800, ['for-code-review'])
await tick(app)
step = await tick(app)
check('второй пустой круг снимает тикет', step.result.action, 'dropped')
check('причина снятия названа', step.result.reason, 'two review rounds without a new commit')
check('человеку сказано про два круга', comments.some((c) => c.number === 800 && c.body.includes('два круга подряд без нового коммита')), true)
check('метки стадий сняты', issues.get(800).labels, [])
check('на снятом круге обещания выдачи нет', comments.filter((c) => c.number === 800 && c.body.includes('ветка не менялась')).length, unchangedBefore)

console.log('\n=== сценарий 9: сбой модели на ходе ревьюера не выдаёт себя за пустой круг ===')
// Ход ревьюера не начался (провайдер): ревизию он не видел, значит и записанной
// просмотренной ревизии быть не должно — иначе следующий тик объявит «ветка не
// менялась» и спишет сбой на разработчика.
reset({ number: 900, title: 'Демо-тикет 900', labels: ['ready-for-dev'], state: 'open' })
pulls.clear()
comments.length = 0
pullFiles = []
pulls.set(900, { number: 900, head: { ref: 'feature/900-provider-fail', sha: 'sha-900-1' } })
app = await boot()
step = await tick(app)
const dev9 = step.result.sessionId
endTurn(dev9)
setLabels(900, ['for-code-review'])
await tick(app)
step = await tick(app)
check('ревьюер вызван', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const review9 = step.result.sessionId
turnTails.set(review9, brokenTurn('SSE stream ended without [DONE]'))
endTurn(review9)
step = await tick(app)
check('сбой модели распознан', step.result.action, 'provider-error')
advance(11 * 60 * 1000)
step = await tick(app)
check('после паузы ревьюер позван снова', step.result.action + ':' + step.result.role, 'dispatched:code-review')
check('пустого круга не объявляли', comments.some((c) => c.number === 900 && c.body.includes('ветка не менялась с прошлого ревью')), false)
check('бюджет доработок не тронут', step.state.projects.vahta.rework[900], undefined)

console.log('\n=== сценарий 10: пути .tsx/.jsx не обрезаются до .ts/.js ===')
// Фронтенд проекта — React + TypeScript, поэтому .tsx здесь норма. В alternation
// расширений выигрывает первая ветвь: с `ts` раньше `tsx` путь обрывался до
// несуществующего файла, и в тикете с заданием назывался файл, которого нет.
reset({ number: 1000, title: 'Демо-тикет 1000', labels: ['ready-for-dev', 'area:frontend'], state: 'open' })
pulls.clear()
comments.length = 0
pullFiles = []
pulls.set(1000, { number: 1000, head: { ref: 'feature/1000-tsx', sha: 'sha-1000-1' } })
app = await boot()
step = await tick(app)
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev-frontend')
const dev10 = step.result.sessionId
endTurn(dev10)
setLabels(1000, ['for-code-review', 'area:frontend'])
await tick(app)
step = await tick(app)
check('ревьюер смотрит PR', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const review10 = step.result.sessionId
reviewer(1000, 'FIX: 1\n\nfrontend/src/pages/Vacancy.tsx:41 — не показан признак отписки\nfrontend/src/components/Card.jsx — потерян key')
endTurn(review10)
setLabels(1000, ['ready-for-dev', 'area:frontend'])
await tick(app)
step = await tick(app)
check('доработка ушла фронтендеру', step.result.action + ':' + step.result.role, 'dispatched:dev-frontend')
check('в задании .tsx с номером строки', lastPrompt().text.includes('frontend/src/pages/Vacancy.tsx:41'), true)
check('в задании .jsx', lastPrompt().text.includes('frontend/src/components/Card.jsx'), true)
check('след в тикете без номера строки', comments.some((c) => c.number === 1000 && c.body.includes('→ dev-frontend: frontend/src/pages/Vacancy.tsx, frontend/src/components/Card.jsx')), true)
check('обрезанных путей в тикете нет', comments.some((c) => c.number === 1000 && /frontend\/src\/pages\/Vacancy\.ts(?!x)/.test(c.body)), false)

console.log('\n=== сценарий 11: круг ревью в новом формате — заголовок у каждого замечания ===')
// По правилу «заголовок роли в первой строке» у КАЖДОГО замечания свой
// комментарий с заголовком, поэтому начало круга — последний комментарий
// ревьюера СО СТРОКОЙ ВЕРДИКТА в шапке. Если брать просто последний комментарий
// с ролью, круг схлопывается до последнего замечания и пути остальных (вместе с
// половиной работы) теряются: ровно та ошибка, от которой защищает комментарий
// над roleForRework. Второй способ потерять круг — искать вердикт по всему телу:
// замечание, которое цитирует строку вердикта (в тикетах про форматы это норма),
// объявляло бы себя началом круга.
reset({ number: 1100, title: 'Демо-тикет 1100', labels: ['ready-for-dev', 'area:backend'], state: 'open' })
pulls.clear()
comments.length = 0
pullFiles = []
pulls.set(1100, { number: 1100, head: { ref: 'feature/1100-role-header', sha: 'sha-1100-1' } })
app = await boot()
step = await tick(app)
check('разработчик взял тикет', step.result.action + ':' + step.result.role, 'dispatched:dev-backend')
const dev11 = step.result.sessionId
endTurn(dev11)
setLabels(1100, ['for-code-review'])
await tick(app)
step = await tick(app)
check('ревьюер смотрит PR', step.result.action + ':' + step.result.role, 'dispatched:code-review')
const review11 = step.result.sessionId
reviewer(1100, '**Роль:** код-ревьюер · вердикт FIX: два замечания\nFIX: 2\n\nbackend/app/api/orders.py:41 — пустой список\nfrontend/src/lib/vacancySubscription.js:41 — нет признака отписки')
reviewer(1100, '**Роль:** код-ревьюер · замечание по пустому списку\n\nbackend/app/api/orders.py:41 — пустой список не отличим от 404')
reviewer(1100, '**Роль:** код-ревьюер · замечание про признак отписки\n\nfrontend/src/lib/vacancySubscription.js:41 — нет признака отписки')
// Замечание с цитатой вердикта: строка `FIX: 2` стоит в теле с начала строки,
// путей в нём нет. Началом круга оно быть не должно — вердикт читается в шапке.
reviewer(1100, '**Роль:** код-ревьюер · замечание про формат строки вердикта\n\nВердикт пишется второй строкой, например:\n\n```\nFIX: 2\n```\n\nТак диспетчер находит начало круга.')
endTurn(review11)
// Метка маршрута остаётся на тикете, как в жизни: если круг разберётся неверно,
// доработка уйдёт бэкенду по метке — ровно как в дефекте, который ловит тест.
setLabels(1100, ['ready-for-dev', 'area:backend'])
await tick(app)
step = await tick(app)
check('круг открыт вердиктом, а не последним замечанием и не цитатой', step.result.action + ':' + step.result.role, 'dispatched:dev-fullstack')
check('в задании пути обеих половин', [
  lastPrompt().text.includes('backend/app/api/orders.py'),
  lastPrompt().text.includes('frontend/src/lib/vacancySubscription.js'),
], [true, true])
// След маршрута — только комментарии диспетчера: замечания ревьюера пути тоже
// содержат, и проверка по всем комментариям проходила бы при любом разборе.
const dispatcherComments = comments.filter((c) => c.number === 1100 && String(c.body).startsWith('**Роль:** диспетчер'))
check('в следе тикета пути обеих половин', [
  dispatcherComments.some((c) => c.body.includes('backend/app/api/orders.py')),
  dispatcherComments.some((c) => c.body.includes('frontend/src/lib/vacancySubscription.js')),
], [true, true])

console.log('\n=== служебное ===')
const ids = allRequestIds.map((p) => p.requestId)
check('requestId уникальны', new Set(ids).size, ids.length)
const reused = allRequestIds.filter((p, i) => allRequestIds.findIndex((q) => q.sessionId === p.sessionId) < i)
console.log('заданий всего: ' + allRequestIds.length + ', из них в уже открытые диалоги: ' + reused.length)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
