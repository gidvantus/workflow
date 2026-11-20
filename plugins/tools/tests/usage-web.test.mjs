// Проверка отправки журнала расхода в веб: `plugins/usage-web.mjs` (issue #57).
//
// Набор проверяет ровно контракт половины harness:
//
//   - тело `POST /api/usage/shifts` собирается из карточек смены: сессии с токенами,
//     цена из `costOf`, итог — сумма округлённых цен;
//   - успех (в том числе `200` с `changed: false`) снимает смену с очереди;
//   - временный отказ (сеть, `401`, `5xx`) оставляет смену в очереди и называет
//     причину в строке сводки;
//   - отказ по существу (`422`) в очередь не ложится;
//   - три неудачных попытки выбрасывают смену, вытеснение держит потолок очереди;
//   - очередь лежит в каталоге состояния отдела, а не рядом с модулем.
//
// Сеть не трогается: `request` подменяется функцией набора. Каталог установки
// подменяется песочным в `$DSH_HOME`, причём во временном каталоге системы — набор
// не оставляет мусора в рабочей копии.
// Запуск: node usage-web.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// ── песочница ───────────────────────────────────────────────────────────────

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-web-home-'))
process.env.DSH_HOME = sandbox
const STATE_DIR = path.join(sandbox, 'profiles', 'desktop', 'dsh-dev-department')

const usage = await import(new URL('../../usage-web.mjs', import.meta.url).href)
const statePaths = await import(new URL('../../state-paths.mjs', import.meta.url).href)

// ── адрес ручки ─────────────────────────────────────────────────────────────

console.log('\n=== адрес приёма смен ===')
check('из базы API', usage.shiftReportUrl('http://localhost:8096'), 'http://localhost:8096/api/usage/shifts')
check('хвостовой слэш не даёт двойного слэша', usage.shiftReportUrl('http://localhost:8096/'), 'http://localhost:8096/api/usage/shifts')
check('подкаталог стенда сохраняется', usage.shiftReportUrl('http://host/dsh'), 'http://host/dsh/api/usage/shifts')
check('пустая база — пустой адрес', usage.shiftReportUrl(''), '')
// Прямой `registry.apiUrl` — тоже законный вход: `/api` и его хвост отбрасываются.
check('адрес ручки реестра не даёт /api/api', usage.shiftReportUrl('http://localhost:8096/api/registry'), 'http://localhost:8096/api/usage/shifts')
check('подкаталог стенда и ручка реестра', usage.shiftReportUrl('http://host/dsh/api/registry'), 'http://host/dsh/api/usage/shifts')
check('слэш после /api', usage.shiftReportUrl('http://host/dsh/api/'), 'http://host/dsh/api/usage/shifts')
check('мусор вместо URL не роняет', usage.shiftReportUrl('  '), '')

// ── деньги ──────────────────────────────────────────────────────────────────

console.log('\n=== округление денег ===')
check('шесть знаков', usage.roundMoney(0.1 + 0.2), 0.3)
check('ровно знак', usage.roundMoney(1), 1)
check('вниз', usage.roundMoney(1.0000004), 1)
check('вверх', usage.roundMoney(1.0000005), 1.000001)
check('не число — ноль', usage.roundMoney('дорого'), 0)

// ── тело запроса ────────────────────────────────────────────────────────────

console.log('\n=== тело смены ===')
const RATES = { inputUsdPerM: 3, cacheReadUsdPerM: 0.3, cacheWriteUsdPerM: 3.75, outputUsdPerM: 15 }
// Та же формула, что `costOf` в книге учёта, но своя: набор не должен проверять
// чужую функцию её же кодом.
const costOf = (tokens, rates) => (tokens.in * rates.inputUsdPerM +
  tokens.out * rates.outputUsdPerM +
  tokens.cacheRead * rates.cacheReadUsdPerM +
  tokens.cacheWrite * rates.cacheWriteUsdPerM) / 1e6

const session = (over) => ({
  role: 'dev-backend',
  session: 'abc-123',
  source: 'issue-created',
  turns: 4,
  in: 1000,
  out: 200,
  cacheRead: 4000,
  cacheWrite: 0,
  ...over,
})

const report = usage.buildShiftReport({
  project: { id: 'workflow', title: 'Workflow' },
  shiftKey: '2024-05-01',
  startedAt: '2024-05-01T10:00:00Z',
  endedAt: '2024-05-01T18:00:00Z',
  reason: 'window',
  rates: RATES,
  costOf,
  cards: [
    { issue: 57, title: 'Журнал расхода', sessions: [session({}), session({ session: 'def-456', source: null, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })] },
    { issue: 42, title: 'Другое', sessions: [session({ role: 'reviewer', session: 'ghi-789', in: 0, out: 100, cacheRead: 0, cacheWrite: 0 })] },
  ],
})

check('проект', [report.project_ref, report.project_title], ['workflow', 'Workflow'])
check('ключ смены и причина', [report.shift_key, report.reason], ['2024-05-01', 'window'])
check('интервал — ISO', [report.started_at, report.ended_at], ['2024-05-01T10:00:00.000Z', '2024-05-01T18:00:00.000Z'])
check('тарифы уехали как есть', report.rates, RATES)
check('сессий столько же, сколько в карточках', report.sessions.length, 3)
check('первая сессия', report.sessions[0], {
  issue_number: 57,
  issue_title: 'Журнал расхода',
  role: 'dev-backend',
  session: 'abc-123',
  source: 'issue-created',
  turns: 4,
  tokens: { in: 1000, out: 200, cacheRead: 4000, cacheWrite: 0 },
  cost_usd: 0.0072,
})
check('нулевая сессия остаётся в теле', report.sessions[1].cost_usd, 0)
check('сессия без источника', report.sessions[1].source, null)
check('итог — сумма сессий', report.totals.cost_usd, 0.0087)

// Тикет без номера — не повод терять сессию: `issue_number` в контракте nullable.
const loose = usage.buildShiftReport({
  project: { id: 'workflow' },
  shiftKey: '2024-05-02',
  endedAt: '2024-05-02T18:00:00Z',
  reason: 'manual',
  rates: RATES,
  costOf,
  cards: [{ title: null, sessions: [session({ session: 'x' })] }],
})
check('без номера тикета и без названия', [loose.sessions[0].issue_number, loose.sessions[0].issue_title], [null, null])
check('название проекта по умолчанию — id', loose.project_title, 'workflow')
check('начало без старта смены — конец', loose.started_at, loose.ended_at)
check('без карточек сессий нет', usage.buildShiftReport({ project: {}, shiftKey: 'k', reason: 'window', rates: RATES, costOf, cards: [] }).sessions.length, 0)

// ── очередь: файл и место ───────────────────────────────────────────────────

console.log('\n=== очередь ===')
check('файл очереди — имя из контракта',
  [usage.queueFile(), statePaths.STATE_FILES.usageQueue],
  [path.join(STATE_DIR, 'dev-department-usage-queue.json'), 'dev-department-usage-queue.json'])
check('очереди нет — пусто', usage.readQueue(), [])
check('очередь кладётся файлом', usage.enqueue(report, { error: 'сеть' }).queued, 1)
check('запись читается обратно', usage.readQueue()[0].report.shift_key, '2024-05-01')
check('причина запоминается', usage.readQueue()[0].lastError, 'сеть')

// Испорченный файл — пустая очередь, а не падение: журнал не должен останавливать смену.
fs.writeFileSync(usage.queueFile(), 'не json')
check('испорченный файл читается как пустая очередь', usage.readQueue(), [])
usage.writeQueue([])

// Потолок: старое вытесняется, файл не растёт бесконечно.
for (let i = 0; i < usage.QUEUE_LIMIT + 5; i += 1) {
  usage.enqueue({ ...report, shift_key: 'k' + i }, { error: 'сеть' })
}
const capped = usage.readQueue()
check('потолок очереди', capped.length, usage.QUEUE_LIMIT)
check('вытеснены самые старые', [capped[0].report.shift_key, capped[capped.length - 1].report.shift_key],
  ['k5', 'k' + (usage.QUEUE_LIMIT + 4)])
usage.writeQueue([])

// ── отправка одной смены ────────────────────────────────────────────────────

console.log('\n=== отправка смены ===')
const URL_OK = 'http://localhost:8096/api/usage/shifts'
const answer = (status, body) => async () => ({ status, body: JSON.stringify(body) })

let sent = null
const ok = await usage.deliverShift(report, {
  url: URL_OK,
  token: 't',
  request: async (url, token, body) => {
    sent = { url, token, body }
    return { status: 201, body: JSON.stringify({ shift_id: 1, accepted: 3, skipped: 0, sessions_count: 3, cost_usd: '0.007680', changed: true }) }
  },
})
check('адрес и токен дошли', [sent.url, sent.token], [URL_OK, 't'])
check('тело — то, что собрано', sent.body.shift_key, '2024-05-01')
check('успех', [ok.ok, ok.queued], [true, 0])
check('строка об успехе', ok.line,
  'Журнал расхода: смена 2024-05-01 сохранена в вебе (принято сессий: 3, пропущено: 0)')

const repeat = await usage.deliverShift(report, { url: URL_OK, request: answer(200, { changed: false, accepted: 0, skipped: 3 }) })
check('повтор смены — успех, а не отказ', [repeat.ok, repeat.queued], [true, 0])
check('строка о повторе', repeat.line,
  'Журнал расхода: смена 2024-05-01 уже была в журнале (принято сессий: 0, пропущено: 3)')

// Сеть лежит: смена ждёт в очереди, строка говорит, что она не потеряна.
const offline = await usage.deliverShift(report, { url: URL_OK, request: async () => { throw new Error('ECONNREFUSED') } })
check('сеть лежит — в очередь', [offline.ok, offline.queued], [false, 1])
check('строка о недоставке', offline.line,
  'Журнал расхода: смена 2024-05-01 не отправлена — ECONNREFUSED; останется в очереди')
usage.writeQueue([])

const rejected = await usage.deliverShift(report, {
  url: URL_OK,
  request: answer(422, { detail: 'Не переданы тарифы расчёта' }),
})
check('отказ по существу в очередь не ложится', [rejected.ok, rejected.queued], [false, 0])
check('строка об отказе', rejected.line,
  'Журнал расхода: смена 2024-05-01 не принята — Не переданы тарифы расчёта')
check('очередь пуста после отказа', usage.readQueue().length, 0)

const unprocessable = await usage.deliverShift(report, { url: URL_OK, request: answer(500, '') })
check('5xx — временный отказ, в очередь', [unprocessable.ok, unprocessable.queued], [false, 1])
usage.writeQueue([])

// `409` — штатная гонка двух отправок (одновременная запись смены в вебе): повтор тем
// же телом проходит, потому что сессии уже в базе и уйдут в `skipped`. Выбросить
// смену из-за него — потерять расход навсегда.
const raced = await usage.deliverShift(report, {
  url: URL_OK,
  request: answer(409, { detail: 'Смену не удалось записать: одновременная отправка' }),
})
check('409 — временный отказ, смена в очереди', [raced.ok, raced.queued], [false, 1])
check('409 назван в строке сводки', raced.line,
  'Журнал расхода: смена 2024-05-01 не отправлена — Смену не удалось записать: одновременная отправка; останется в очереди')
const racedAgain = await usage.flushQueue({
  url: URL_OK,
  request: async () => ({ status: 201, body: JSON.stringify({ changed: true, accepted: 3, skipped: 0 }) }),
})
check('после 409 смена досылается повтором', [racedAgain.sent, racedAgain.left], [1, 0])
usage.writeQueue([])

console.log('\n=== что считается временным ===')
check('2xx — не повторять', usage.isRetryable(200), false)
check('401 — повторять', usage.isRetryable(401), true)
check('408 — повторять', usage.isRetryable(408), true)
check('409 — повторять', usage.isRetryable(409), true)
check('429 — повторять', usage.isRetryable(429), true)
check('500 — повторять', usage.isRetryable(500), true)
check('422 — не повторять', usage.isRetryable(422), false)
check('404 — не повторять', usage.isRetryable(404), false)

// ── досылка очереди ─────────────────────────────────────────────────────────

console.log('\n=== досылка очереди ===')
const failuresSeen = []
usage.writeQueue([
  { report: { ...report, shift_key: 'a' }, attempts: 0, lastError: null, at: null },
  { report: { ...report, shift_key: 'b' }, attempts: 0, lastError: null, at: null },
  { report: { ...report, shift_key: 'c' }, attempts: 0, lastError: null, at: null },
])
const partial = await usage.flushQueue({
  url: URL_OK,
  token: 't',
  request: async (url, token, body) => {
    failuresSeen.push(body.shift_key)
    if (body.shift_key === 'a') return { status: 201, body: '{}' }
    return { status: 401, body: JSON.stringify({ detail: 'Токен реестра не принят' }) }
  },
})
check('первая ушла, вторая ждёт', [partial.sent, partial.dropped, partial.left], [1, 0, 2])
check('третью не трогали: канал лежит', failuresSeen, ['a', 'b'])
check('попытка приросла', usage.readQueue()[0].attempts, 1)
check('третья попыток не тратила', usage.readQueue()[1].attempts, 0)

// Три попытки — потолок: следующая неудача выбрасывает запись.
usage.writeQueue([{ report: report, attempts: 2, lastError: 'сеть', at: null }])
const exhausted = await usage.flushQueue({ url: URL_OK, request: async () => ({ status: 500, body: '' }) })
check('после третьей попытки выброшена', [exhausted.sent, exhausted.dropped, exhausted.left], [0, 1, 0])
check('очередь пуста', usage.readQueue().length, 0)

// Отказ по существу выбрасывается сразу, без траты попыток.
usage.writeQueue([{ report: report, attempts: 0, lastError: null, at: null }])
const refused = await usage.flushQueue({ url: URL_OK, request: answer(422, { detail: 'Смена должна иметь начало и конец' }) })
check('422 выброшен сразу', [refused.dropped, refused.left], [1, 0])

// Пустая очередь и отсутствие адреса — не поводы стучаться в сеть.
let touched = 0
const empty = await usage.flushQueue({ url: URL_OK, request: async () => { touched += 1; return { status: 201, body: '{}' } } })
check('пустую очередь не отправляем', [empty.sent, empty.left, touched], [0, 0, 0])
usage.writeQueue([{ report: report, attempts: 0, lastError: null, at: null }])
const noUrl = await usage.flushQueue({ url: '', request: async () => { touched += 1; return { status: 201, body: '{}' } } })
check('без адреса не отправляем', [noUrl.left, noUrl.error, touched], [1, 'адрес журнала не задан', 0])

// ── итог ────────────────────────────────────────────────────────────────────

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛЕНО ПРОВЕРОК: ' + failures)
process.exit(failures === 0 ? 0 : 1)
