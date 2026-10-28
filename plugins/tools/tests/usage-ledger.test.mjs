// Проверка модуля учёта токенов: plugins/usage-ledger.mjs.
//
// Модуль — единственное место, где живут книга привязок «сессия → тикет» и правило
// повтора. Поэтому проверяется именно он, а не его копия в тесте отчёта: карточка
// `dev_department_status`, сводка смены и `tools/issue-tokens.mjs` обязаны считать
// одними и теми же числами.
//
// Настоящий ~/.dsh не читается и не пишется: весь тест живёт в песочном $DSH_HOME,
// который подставляется в `process.env.DSH_HOME` — модуль читает каталог установки
// в момент вызова, а не на момент импорта, и это здесь же проверяется.
// Запуск: node usage-ledger.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Тест лежит в plugins/tools/tests, модуль учёта — в plugins/.
const moduleFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'usage-ledger.mjs')
const home = path.join(process.cwd(), '.usage-ledger-home')
const homeEmpty = path.join(process.cwd(), '.usage-ledger-empty-home')
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeEmpty, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(homeEmpty, { recursive: true })
process.env.DSH_HOME = home

const ledger = await import('file:///' + moduleFile.replace(/\\/g, '/') + '?v=' + Date.now())

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

const book = () => path.join(home, 'dev-department-usage.json')
const readBook = () => JSON.parse(fs.readFileSync(book(), 'utf8'))

const S1 = '11111111-1111-1111-1111-111111111111'
const S2 = '22222222-2222-2222-2222-222222222222'
const S3 = '33333333-3333-3333-3333-333333333333'

// ── книга привязок ──────────────────────────────────────────────────────────

console.log('=== книга привязок ===')
check('каталог установки читается на момент вызова', ledger.ledgerFile(), book())
check('книги нет — пустой массив, а не падение', ledger.readLedger(), [])
check('битых записей нет и файла тоже', fs.existsSync(book()), false)

const first = ledger.appendLedgerEntry({
  at: '2026-10-26T10:00:00.000Z', project: 'workflow', issue: 15, role: 'dev-frontend',
  session: S1, attempt: 1, source: 'dispatcher',
})
check('первая запись добавлена', [first.added, first.duplicate, first.reason], [true, false, null])
check('в книге одна запись', readBook().length, 1)
check('форма записи', readBook()[0], {
  at: '2026-10-26T10:00:00.000Z', project: 'workflow', issue: 15, role: 'dev-frontend',
  session: S1, attempt: 1, source: 'dispatcher',
})
check('readLedger отдаёт её же', ledger.readLedger().length, 1)

// Повторная выдача роли в тот же диалог: та же сессия, тот же тикет. Ключ один —
// запись вторая не появляется. Префикс session- книгу не обманывает.
const again = ledger.appendLedgerEntry({
  at: '2026-10-26T10:05:00.000Z', project: 'workflow', issue: 15, role: 'dev-frontend',
  session: 'session-' + S1, attempt: 1, source: 'dispatcher',
})
check('повтор не добавил вторую запись', [again.added, again.duplicate], [false, true])
check('в книге по-прежнему одна запись', readBook().length, 1)

// Другая роль и другая сессия — своя запись.
ledger.appendLedgerEntry({ project: 'workflow', issue: 15, role: 'analyst', session: S2, source: 'issue-created' })
check('вторая роль — вторая запись', readBook().length, 2)
check('at подставлен, если его не передали', typeof readBook()[1].at, 'string')
check('попытка и роль не выдуманы', [readBook()[1].attempt, readBook()[1].role], [null, 'analyst'])

const incomplete = ledger.appendLedgerEntry({ project: 'workflow', issue: 15, role: 'analyst' })
check('запись без сессии отвергнута и объяснена', [incomplete.added, /нужны project, issue, session/.test(incomplete.reason)], [false, true])
const badIssue = ledger.appendLedgerEntry({ project: 'workflow', issue: 'пятнадцать', session: S3 })
check('номер тикета обязан быть числом', [badIssue.added, /нужны project, issue, session/.test(badIssue.reason)], [false, true])
check('битые записи в книгу не попали', readBook().length, 2)

// Нечитаемая книга: файл не перезаписывается, append не проходит.
const brokenText = '{ это не книга привязок'
fs.writeFileSync(book(), brokenText)
check('битая книга читается как пустая', ledger.readLedger(), [])
check('битая книга не перезаписана', fs.readFileSync(book(), 'utf8'), brokenText)
const onBroken = ledger.appendLedgerEntry({ project: 'workflow', issue: 16, role: 'tester', session: S3, source: 'dispatcher' })
check('запись в битую книгу отвергнута', onBroken.added, false)
checkText('и причина названа словами', onBroken.reason, 'повреждена')
checkText('и сказано, что файл сохранён', onBroken.reason, 'файл не перезаписан')
check('битая книга не тронута и после append', fs.readFileSync(book(), 'utf8'), brokenText)

// Форма { entries: [...] } принимается: книга не должна зависеть от обёртки.
fs.writeFileSync(book(), JSON.stringify({
  entries: [
    { project: 'workflow', issue: 17, role: 'dev-backend', session: S1, source: 'dispatcher' },
    { project: 'workflow', issue: 17, role: 'dev-backend', session: S1, source: 'dispatcher' },
    { мусор: true },
  ],
}, null, 2))
const wrapped = ledger.readLedger()
check('обёртка entries принята, повтор схлопнут, мусор отброшен',
  [wrapped.length, wrapped[0].issue, wrapped[0].role], [1, 17, 'dev-backend'])

// Каталог установки — не константа модуля.
process.env.DSH_HOME = homeEmpty
check('DSH_HOME перечитан: другой каталог — другая книга', [ledger.ledgerFile(), ledger.readLedger().length],
  [path.join(homeEmpty, 'dev-department-usage.json'), 0])
process.env.DSH_HOME = home

// ── правило повтора ─────────────────────────────────────────────────────────

console.log('\n=== счёт токенов: ведра и правило повтора ===')
const msg = (turn, step, input, output, cacheRead = 0, cacheWrite = 0) => ({
  type: 'assistant/message',
  data: { turn, step, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } },
})
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { retryId: 'r-1', turn, step, retry: 1 } })
const attempt = (turn, step, input, output) => ({
  type: 'assistant/attempt',
  data: {
    turn,
    step,
    stream: [
      { type: 'chunk', time: 1, chunk: { type: 'text', text: '' } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output } } },
    ],
  },
})

check('пустой лог — вёдра контрактными именами и нули', ledger.usageOfEvents([]), {
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
})
check('мусор вместо событий не ломает счёт', ledger.usageOfEvents(null), {
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
})
check('вёдра раздельные: кэш-чтение не прячется в тотал', ledger.usageOfEvents([
  msg(1, 1, 1000, 10, 200, 50),
  msg(1, 2, 500, 5),
]), { uncachedInputTokens: 1500, outputTokens: 15, cacheReadTokens: 200, cacheWriteTokens: 50 })

// Повтор шага: llm/retry-started закрывает слот, поэтому вторая попытка (800)
// ДОБАВЛЯЕТСЯ к итогу — 700 + 800. Это правило проекции tokenUsage, и отчёт с
// карточкой статуса обязаны показывать именно его.
check('повтор шага добавляет вторую попытку', ledger.usageOfEvents([
  msg(3, 1, 700, 7), retryStarted(3, 1), msg(3, 1, 800, 8),
]).uncachedInputTokens, 1500)

// Повторная выборка той же попытки с теми же числами — один раз.
check('та же попытка с теми же числами считается один раз', ledger.usageOfEvents([
  msg(1, 1, 1000, 100), msg(1, 1, 1000, 100), msg(2, 1, 500, 50),
]).uncachedInputTokens, 1500)
check('и выход по тому же правилу', ledger.usageOfEvents([
  msg(1, 1, 1000, 100), msg(1, 1, 1000, 100), msg(2, 1, 500, 50),
]).outputTokens, 150)

// usage шага приходит потоком попытки, а потом готовым сообщением: вклад один.
check('usage из потока попытки входит в итог', ledger.usageOfEvents([
  attempt(1, 1, 200, 20), msg(1, 1, 200, 20),
]), { uncachedInputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 })
// Плоская запись потока — выдуманная форма: настоящая лежит на двух уровнях.
check('плоская запись потока не считается', ledger.usageOfEvents([{
  type: 'assistant/attempt',
  data: { turn: 1, step: 1, stream: [{ type: 'usage', usage: { inputTokens: 900, outputTokens: 90 } }] },
}]).uncachedInputTokens, 0)
check('события без usage пропускаются', ledger.usageOfEvents([
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [] } } },
]).uncachedInputTokens, 0)

console.log('\n=== ходы ===')
check('ходы считаются по сообщениям, а не по шагам', ledger.turnsOfEvents([
  msg(1, 1, 10, 1), msg(1, 2, 10, 1), msg(2, 1, 10, 1),
]), 2)
check('без номеров ходов — по turn/start', ledger.turnsOfEvents([
  { type: 'turn/start', data: {} }, { type: 'turn/start', data: {} }, { type: 'assistant/message', data: {} },
]), 2)
check('пустая сессия — ноль ходов', ledger.turnsOfEvents([]), 0)

// ── стенограмма на диске ────────────────────────────────────────────────────

console.log('\n=== запасной путь по стенограмме ===')

// Стенограмма DSH — конкатенация кадров zstd, в кадре целое число строк JSONL.
function writeTranscript(base, workspace, id, rows, options) {
  const dir = path.join(base, 'sessions', workspace, 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  const lines = rows.map((row) => JSON.stringify(row) + '\n')
  const frame = (slice) => zlib.zstdCompressSync(Buffer.from(slice.join(''), 'utf8'))
  let chunks
  if (options && options.truncate) {
    const whole = frame(lines)
    chunks = [whole.subarray(0, Math.floor(whole.length * (options.truncate / 100)))]
  } else if (options && options.frames === 2) {
    const half = Math.ceil(lines.length / 2)
    chunks = [frame(lines.slice(0, half)), frame(lines.slice(half))]
  } else {
    chunks = [frame(lines)]
  }
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(chunks))
  return dir
}

writeTranscript(home, '--D-Agents-Workflow--', S1, [
  { type: 'session', version: 3, id: 'session-' + S1 },
  msg(1, 1, 1000, 10, 200, 0),
  msg(2, 1, 500, 5),
], { frames: 2 })
const fromDisk = ledger.readUsageFromDisk(home, S1)
check('числа по стенограмме', [fromDisk.usage.uncachedInputTokens, fromDisk.usage.outputTokens, fromDisk.usage.cacheReadTokens], [1500, 15, 200])
check('ходы по стенограмме', fromDisk.turns, 2)
check('целая стенограмма — без замечаний', fromDisk.problems, [])
check('id с префиксом session- тоже находится', ledger.readUsageFromDisk(home, 'session-' + S1).usage.uncachedInputTokens, 1500)
check('неизвестная сессия названа замечанием', ledger.readUsageFromDisk(home, S2).problems.length, 1)
checkText('и причина названа', ledger.readUsageFromDisk(home, S2).problems[0], 'сессия не найдена')
// `missing` различает «стенограммы ещё нет» (обычное состояние свежей сессии —
// диспетчер читает её живой поверхностью) и «стенограмма есть, но не дочиталась»
// (недосчёт, о котором надо сказать).
check('стенограммы нет — missing', ledger.readUsageFromDisk(home, S2).missing, true)
check('стенограмма прочиталась — не missing', fromDisk.missing, false)

// Оборванный кадр: zstd отдаёт обрывок и не падает, поэтому сбой обязан стать
// замечанием — иначе недосчёт выглядит как полные числа.
writeTranscript(home, '--D-Agents-Workflow--', S3, [
  { type: 'session', version: 3, id: 'session-' + S3 },
  msg(1, 1, 700, 70),
  msg(2, 1, 300, 30),
], { truncate: 50 })
const truncated = ledger.readUsageFromDisk(home, S3)
checkText('обрыв стенограммы назван', (truncated.problems || []).join(' '), 'кадр стенограммы не разобран целиком')
check('обрыв не превращается в падение', Array.isArray(truncated.problems), true)
check('оборванная стенограмма — не missing: это недосчёт, а не отсутствие файла', truncated.missing, false)

// ── сумма по тикету ─────────────────────────────────────────────────────────

console.log('\n=== сумма по тикету ===')
const entries = [
  { project: 'workflow', issue: 15, role: 'analyst', session: S2, source: 'issue-created' },
  { project: 'workflow', issue: 15, role: 'dev-frontend', session: S1, source: 'dispatcher' },
  { project: 'workflow', issue: 15, role: 'dev-frontend', session: 'session-' + S1, source: 'dispatcher' },
]
const card = await ledger.summarizeIssue(entries, async (entry) => ({
  usage: entry.session === S2
    ? { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 0 }
    : { uncachedInputTokens: 200, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 3 },
  turns: entry.session === S2 ? 1 : 2,
}))
check('одна строка на сессию, повтор не посчитан дважды', card.sessions.length, 2)
check('строки по ролям с короткими именами ведра', [card.sessions[0].role, card.sessions[0].in, card.sessions[0].out], ['analyst', 100, 10])
check('итоги сложены из строк', card.totals, { in: 300, out: 30, cacheRead: 3, cacheWrite: 3 })

const failedRead = await ledger.summarizeIssue([entries[1]], async () => { throw new Error('сессия недоступна') })
check('сбой чтения одной сессии не роняет карточку', failedRead.totals, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
checkText('и назван замечанием', (failedRead.problems || []).join(' '), 'usage сессии')

const emptyCard = await ledger.summarizeIssue([], async () => ({}))
check('пустой тикет — нули и пустые строки', [emptyCard.sessions.length, emptyCard.totals], [0, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }])

// ── строка для человека и цена ──────────────────────────────────────────────

console.log('\n=== строка расхода и цена ===')
const totals = { in: 1234, out: 56, cacheRead: 7890, cacheWrite: 0 }
check('строка расхода', ledger.usageLine(totals), 'вход 1 234 · выход 56 · кэш-чтение 7 890')
check('кэш-запись печатается только при ненулевой', ledger.usageLine({ ...totals, cacheWrite: 4 }),
  'вход 1 234 · выход 56 · кэш-чтение 7 890 · кэш-запись 4')
check('без тарифа цены нет', ledger.costOf(totals, null), null)
check('пустой тариф — тоже нет', ledger.costOf(totals, {}), null)
check('цена по тарифу за миллион токенов', ledger.costOf(
  { in: 1000000, out: 0, cacheRead: 0, cacheWrite: 0 }, { inputUsdPerM: 3 }), 3)
check('кэш-чтение считается отдельным тарифом', ledger.costOf(
  { in: 0, out: 0, cacheRead: 2000000, cacheWrite: 0 }, { cacheReadUsdPerM: 0.3 }), 0.6)
check('мелкая цена не превращается в ноль', ledger.formatCost(0.0004), '$0.0004')
check('обычная цена в центах', ledger.formatCost(1.2345), '$1.23')

// ── сессия, в которой родился тикет ─────────────────────────────────────────

console.log('\n=== сессия постановки: заголовок на диске и выбор по времени ===')
// Заголовок сессии — первое событие `session`: в нём `cwd`, `agentPreset` и
// `createdAt`. Целую стенограмму для привязки читать не нужно и нельзя — она тянет
// мегабайты.
const bindHome = path.join(process.cwd(), '.usage-ledger-bind-home')
fs.rmSync(bindHome, { recursive: true, force: true })
const ISSUE_AT = new Date('2026-10-26T09:00:00Z').getTime()
const headDir = (workspace, id, createdAt, updatedAt, cwd) => {
  const dir = writeTranscript(bindHome, workspace, id, [
    { type: 'session', version: 3, id: 'session-' + id, createdAt, cwd: cwd || 'D:\\Agents\\Workflow', agentPreset: 'analyst' },
    msg(1, 1, 400, 40),
  ])
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  const at = new Date(updatedAt)
  fs.utimesSync(file, at, at)
  return file
}
const BIND_A = '11111111-1111-4111-8111-111111111111'
const BIND_B = '22222222-2222-4222-8222-222222222222'
const BIND_OLD = '33333333-3333-4333-8333-333333333333'
// Ранняя сессия человека: началась за сутки до тикета и живёт до сих пор.
headDir('--D-Agents-Workflow--', BIND_A, ISSUE_AT - 24 * 3600 * 1000, ISSUE_AT + 3600 * 1000)
// Сессия постановки: началась за десять минут до тикета — она и должна победить.
headDir('--D-Agents-Workflow--', BIND_B, ISSUE_AT - 10 * 60 * 1000, ISSUE_AT + 5 * 60 * 1000)
// Сессия из чужой рабочей области: другой каталог, к проекту не относится.
headDir('--Elsewhere--', BIND_OLD, ISSUE_AT - 5 * 60 * 1000, ISSUE_AT + 5 * 60 * 1000, 'D:\\Agents\\Vahta')

const listed = ledger.listSessionHeads(bindHome)
check('заголовки всех сессий прочитаны', listed.heads.length, 3)
check('заголовок несёт каталог и пресет', { cwd: listed.heads[0].cwd, preset: listed.heads[0].preset },
  { cwd: 'D:\\Agents\\Workflow', preset: 'analyst' })
check('в заголовке нет мусора от вызовов', listed.problems, [])

const workspace = 'D:\\Agents\\Workflow'
const picked = ledger.findDraftSession(listed.heads, {
  created: ISSUE_AT,
  cwds: [workspace, ''],
  bound: [],
})
check('выбрана самая поздняя сессия, накрывающая рождение тикета', picked && picked.session, BIND_B)
check('чужая рабочая область не выбрана', picked.session === BIND_OLD, false)
// Уже привязанная сессия повторно не выбирается: очередь доходит до следующей,
// которая накрывает тот же момент (в жизни это следующий по времени диалог).
check('уже привязанная сессия не выбирается повторно',
  ledger.findDraftSession(listed.heads, { created: ISSUE_AT, cwds: [workspace], bound: [BIND_B] }).session === BIND_B,
  false)
check('без подходящего каталога — никого', ledger.findDraftSession(listed.heads, {
  created: ISSUE_AT, cwds: ['D:\\Other'], bound: [],
}), null)
check('неразбираемая дата тикета — никого', ledger.findDraftSession(listed.heads, {
  created: NaN, cwds: [workspace], bound: [],
}), null)
// Окно: тикет, заведённый через неделю после начала сессии, к ней не относится —
// иначе долго живущий диалог человека забирал бы себе все новые тикеты.
check('сессия вне окна не притягивает тикет', ledger.findDraftSession(listed.heads, {
  created: ISSUE_AT + 7 * 24 * 3600 * 1000, cwds: [workspace], bound: [], windowMs: 3 * 24 * 3600 * 1000,
}), null)
fs.rmSync(bindHome, { recursive: true, force: true })

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeEmpty, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
