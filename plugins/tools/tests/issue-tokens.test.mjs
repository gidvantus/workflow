// Проверка отчёта по токенам на тикет: tools/issue-tokens.mjs.
//
// Модуль учёта (profiles/desktop/plugins/usage-ledger.mjs) — половина `profiles/`
// по issue #15. Пока его нет в репозитории, здесь лежит его эталон; как только
// модуль появится, тест берёт настоящий файл вместо эталона: правило повтора
// должно быть одно на тест, на отчёт и на карточку `dev_department_status`.
//
// **Какое правило принято.** Постановка противоречит себе: в теле сказано
// «повторная попытка добавляется к итогу, а не удваивает его», а критерий 7
// требует «ту же сумму, что лог без повтора». Принято правило проекции DSH
// `tokenUsage` (stateVersion 2, `usage-projection.ts`): `llm/retry-started`
// закрывает только слот замены потока, поэтому повторная попытка
// **добавляется** к итогу (700 + 800 = 1500 на логе из S1), а `assistant/attempt`
// тоже даёт вклад — usage из последнего usage-чанка его потока, записанного
// формой DSH `{ type: 'chunk', chunk: { type: 'usage', usage: {…} } }`. Двойного
// счёта при этом нет по другой причине: повторная выборка той же попытки с теми
// же числами заменяет прежнюю, а не прибавляется (проверяется на S12 и S13).
//
// Песочный каталог установки, книга и стенограммы — в песочнице, боевой ~/.dsh
// не читается; сам модуль учёта проверяется отдельным набором своей половины.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Тест лежит в plugins/tools/tests: рядом — CLI, двумя уровнями выше — модуль учёта.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const cli = path.resolve(TEST_DIR, '..', 'issue-tokens.mjs')
const home = path.join(TEST_DIR, '.issue-tokens-home')
const homeNoModule = path.join(TEST_DIR, '.issue-tokens-nomodule-home')
// Настоящий модуль учёта: сильнее эталона, когда он есть.
const REPO_LEDGER = path.resolve(TEST_DIR, '..', '..', 'usage-ledger.mjs')
// Модуль путей состояния: он лежит рядом с модулем учёта и импортируется им
// относительным путём, поэтому в песочницу едет вместе с ним.
const REPO_STATE_PATHS = path.resolve(TEST_DIR, '..', '..', 'state-paths.mjs')

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

// ── песочница ───────────────────────────────────────────────────────────────

// Эталон контракта модуля учёта: тот же путь, куда его кладёт sync.mjs apply.
// Повторяет apply() проекции tokenUsage из DSH один в один: totals + слот last,
// замена выборки той же попытки, закрытие слота по llm/retry-started.
const REFERENCE_MODULE = `// Эталон контракта usage-ledger для tools/tests: книга + проекция tokenUsage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function readLedger() {
  const file = path.join(dshHome(), 'profiles', 'desktop', 'dsh-dev-department', 'dev-department-usage.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return []
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const bucketsFrom = (usage) => ({
  uncachedInputTokens: num(usage.inputTokens),
  outputTokens: num(usage.outputTokens),
  cacheReadTokens: num(usage.cacheReadTokens),
  cacheWriteTokens: num(usage.cacheWriteTokens),
})
const bucketsEqual = (left, right) =>
  left.uncachedInputTokens === right.uncachedInputTokens &&
  left.outputTokens === right.outputTokens &&
  left.cacheReadTokens === right.cacheReadTokens &&
  left.cacheWriteTokens === right.cacheWriteTokens
const addReplacing = (totals, previous, next) => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous ? previous.uncachedInputTokens : 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous ? previous.outputTokens : 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous ? previous.cacheReadTokens : 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous ? previous.cacheWriteTokens : 0) + next.cacheWriteTokens,
})

// Последняя запись потока нужного вида — как lastAssistantStreamChunk в DSH:
// запись лежит на двух уровнях, record.chunk.type. Настоящая форма записи в
// стенограмме DSH: { type: 'chunk', time, chunk: { type: 'usage', usage: {…} } }.
function lastStreamChunk(stream, type) {
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === type) return record.chunk
  }
  return undefined
}

// usage попытки: у assistant/message — data.usage, иначе последний usage-чанк потока.
function usageOf(event) {
  const data = event.data || {}
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (!Array.isArray(data.stream)) return undefined
  const chunk = lastStreamChunk(data.stream, 'usage')
  return chunk === undefined ? undefined : chunk.usage
}

export function usageOfEvents(events) {
  let totals = zeroBuckets()
  let last = null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'llm/retry-started') {
      const data = event.data || {}
      if (last !== null && last.turn === data.turn && last.step === data.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const sample = usageOf(event)
    if (sample === undefined) continue
    const data = event.data || {}
    const previous = last !== null && last.turn === data.turn && last.step === data.step ? last.buckets : undefined
    const buckets = bucketsFrom(sample)
    if (previous !== undefined && bucketsEqual(previous, buckets)) continue
    totals = addReplacing(totals, previous, buckets)
    last = { turn: data.turn, step: data.step, buckets }
  }
  return totals
}

// Правило «ходов» тоже живёт в модуле: отчёт берёт его отсюда, а не считает своё.
export function turnsOfEvents(events) {
  const turns = new Set()
  let started = 0
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') started += 1
    if (event.type !== 'assistant/message') continue
    const turn = event.data && event.data.turn
    if (typeof turn === 'number') turns.add(turn)
  }
  return turns.size > 0 ? turns.size : started
}
`

// Модуль учёта для песочницы: настоящий из репозитория, если он уже есть, иначе
// эталон. Так тест не может разойтись с продуктом в правиле повтора.
//
// Модуль учёта берёт пути состояния относительным `./state-paths.mjs`, поэтому
// модуль состояния едет в песочницу рядом с ним: без него копия модуля учёта
// падает на импорте, а не на проверяемом правиле.
function installLedger(targetHome) {
  const dir = path.join(targetHome, 'profiles', 'desktop', 'plugins')
  fs.mkdirSync(dir, { recursive: true })
  const source = fs.existsSync(REPO_LEDGER) ? fs.readFileSync(REPO_LEDGER, 'utf8') : REFERENCE_MODULE
  fs.writeFileSync(path.join(dir, 'usage-ledger.mjs'), source)
  if (fs.existsSync(REPO_STATE_PATHS)) fs.copyFileSync(REPO_STATE_PATHS, path.join(dir, 'state-paths.mjs'))
  return fs.existsSync(REPO_LEDGER) ? 'настоящий модуль репозитория' : 'эталон проекции в тесте'
}

// Файлы состояния отдела лежат в каталоге профиля, а не в корне каталога
// установки: набор сеет их туда же, куда пишет боевой модуль.
const stateFile = (base, name) => {
  const dir = path.join(base, 'profiles', 'desktop', 'dsh-dev-department')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

const msg = (turn, step, input, output, cacheRead = 0, cacheWrite = 0) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
  },
})
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { retryId: 'r-1', turn, step, retry: 1 } })

// Стенограмма пишется кадрами zstd: пишем в два кадра, чтобы проверять и разбор
// многокадрового файла (приём взят из tools/session-tail.mjs).
function writeTranscript(base, workspace, id, title, events, frames = 1) {
  const dir = path.join(base, 'sessions', workspace, 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  const rows = [{ type: 'session', version: 3, id: 'session-' + id, createdAt: '2026-10-26T10:00:00.000Z' }]
  if (title !== null) rows.push({ type: 'session/title', seq: 1, time: 1, data: { title, messageSeqs: [] } })
  events.forEach((event, index) => rows.push({ type: event.type, seq: index + 2, time: 1000 + index, data: event.data }))
  const lines = rows.map((row) => JSON.stringify(row) + '\n')
  const perFrame = Math.ceil(lines.length / frames)
  const chunks = []
  for (let i = 0; i < lines.length; i += perFrame) {
    chunks.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + perFrame).join(''), 'utf8')))
  }
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(chunks))
}

const S1 = '11111111-1111-1111-1111-111111111111'
const S2 = '22222222-2222-2222-2222-222222222222'
const S3 = '33333333-3333-3333-3333-333333333333'
const S4 = '44444444-4444-4444-4444-444444444444'
const S5 = '55555555-5555-5555-5555-555555555555'
const S6 = '66666666-6666-6666-6666-666666666666'
const S7 = '77777777-7777-7777-7777-777777777777'
const S8 = '88888888-8888-8888-8888-888888888888'
const S9 = '99999999-9999-9999-9999-999999999999'
const S10 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const S11 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const S12 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const S13 = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const S14 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

// Песочница «модуль учёта нарушил контракт ведра»: такой модуль отчёт обязан
// отвергнуть ошибкой, а не показать нули под чужими именами.
const homeBadContract = path.join(process.cwd(), '.issue-tokens-badcontract-home')
fs.rmSync(homeBadContract, { recursive: true, force: true })
fs.mkdirSync(path.join(homeBadContract, 'profiles', 'desktop', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(homeBadContract, 'profiles', 'desktop', 'plugins', 'usage-ledger.mjs'), [
  'export function readLedger() { return [] }',
  'export function usageOfEvents() { return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }',
  'export function turnsOfEvents() { return 0 }',
  '',
].join('\n'))
fs.writeFileSync(stateFile(homeBadContract, 'projects.json'), JSON.stringify({ version: 1, projects: {} }))

// Песочница «в модуле учёта нет правила ходов»: отчёт обязан отказаться, а не
// считать ходы по своей копии правила — иначе колонка «ходов» разойдётся с
// карточкой `dev_department_status`, которая берёт правило из модуля (Б2).
const homeNoTurns = path.join(process.cwd(), '.issue-tokens-noturns-home')
fs.rmSync(homeNoTurns, { recursive: true, force: true })
fs.mkdirSync(path.join(homeNoTurns, 'profiles', 'desktop', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(homeNoTurns, 'profiles', 'desktop', 'plugins', 'usage-ledger.mjs'), [
  'export function readLedger() { return [] }',
  'export function usageOfEvents() { return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }',
  '',
].join('\n'))
fs.writeFileSync(stateFile(homeNoTurns, 'projects.json'), JSON.stringify({ version: 1, projects: {} }))

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeNoModule, { recursive: true, force: true })
const ledgerSource = installLedger(home)
fs.writeFileSync(stateFile(home, 'projects.json'), JSON.stringify({
  version: 1,
  default: 'workflow',
  projects: {
    workflow: { repo: 'gidvantus/workflow', base: 'main', workspace: 'D:\\Agents\\Workflow', humanClone: 'D:\\Development\\VideCoding\\Workflow' },
    vahta: { repo: 'gidvantus/vahta', base: 'develop-m', workspace: 'D:\\Agents\\Vahta' },
  },
}, null, 2))

// Книга: сессия бэкенда записана с префиксом session- (как её зовёт карта диалогов)
// и дважды — повтор обязан схлопнуться; одна запись битая, одна — для другого
// проекта, одна — на сессию, которой нет на диске.
const book = [
  { at: '2026-10-26T10:00:00.000Z', project: 'workflow', issue: 14, role: 'dev-backend', session: 'session-' + S1, attempt: 1, source: 'dispatcher' },
  { at: '2026-10-26T10:05:00.000Z', project: 'workflow', issue: 14, role: 'dev-backend', session: S1, attempt: 1, source: 'dispatcher' },
  { at: '2026-10-26T11:00:00.000Z', project: 'workflow', issue: 14, role: 'code-review', session: S2, attempt: 1, source: 'dispatcher' },
  { at: '2026-10-26T12:00:00.000Z', project: 'workflow', issue: 14, role: 'analyst', session: S7, attempt: 1, source: 'issue-created' },
  { at: '2026-10-26T13:00:00.000Z', project: 'vahta', issue: 193, role: 'dev-backend', session: S6, attempt: 1, source: 'dispatcher' },
  { at: '2026-10-26T14:00:00.000Z', project: 'workflow', issue: 14, role: 'dev-frontend' },
]
fs.writeFileSync(stateFile(home, 'dev-department-usage.json'), JSON.stringify(book, null, 2))

// S1: три хода, во втором ходе две ступени, в третьем — повтор шага после
// llm/retry-started: 700 не должна попасть в сумму, 800 — должна.
writeTranscript(home, '--D-Agents-Workflow--', S1, 'Бэкенд-разработчик [workflow] #14 — Обновление кэша', [
  msg(1, 1, 1000, 10, 200, 0),
  msg(1, 2, 500, 5, 0, 0),
  msg(2, 1, 300, 3, 0, 50),
  msg(3, 1, 700, 7, 0, 0),
  retryStarted(3, 1),
  msg(3, 1, 800, 8, 0, 0),
], 2)
writeTranscript(home, '--D-Agents-Workflow--', S2, 'Код-ревьюер [workflow] #14 — Обновление кэша', [msg(1, 1, 2000, 20, 100, 0)])
// S3: в книге нет — тикет виден только по заголовку.
writeTranscript(home, '--D-Agents-Workflow--', S3, 'Тестировщик [workflow] #14 — Обновление кэша', [msg(1, 1, 400, 4, 0, 0)])
// S8: второй тикет того же проекта — сверка при запуске с номером тикета не
// должна принимать его сессии за потерянные.
writeTranscript(home, '--D-Agents-Workflow--', S8, 'Девопс-доставка [workflow] #15 — Выкатка', [msg(1, 1, 60, 6, 0, 0)])
// S4: номер в заголовке не назван — «не привязано», проект из рабочей области.
writeTranscript(home, '--D-Agents-Workflow--', S4, 'Подсчёт токенов по задачам', [msg(1, 1, 100, 1, 10, 0)])
// S5: каталог сессии не из реестра проектов — проект неизвестен.
writeTranscript(home, '--D-Elsewhere--', S5, null, [msg(1, 1, 50, 0, 0, 0)])
// S6: другой проект, в отчёт по workflow не входит.
writeTranscript(home, '--D-Agents-Vahta--', S6, 'Бэкенд-разработчик [vahta] #193 — Подписка', [msg(1, 1, 90, 9, 0, 0)])
// S7: запись книги без стенограммы.
fs.mkdirSync(homeNoModule, { recursive: true })

// ── песочница с повреждёнными стенограммами ─────────────────────────────────
// Сбои разбора (битый кадр, неразобранная строка, пустой разбор) не должны
// проглатываться: иначе отчёт показывает заниженные числа как полные.
const homeBroken = path.join(process.cwd(), '.issue-tokens-broken-home')
fs.rmSync(homeBroken, { recursive: true, force: true })
fs.mkdirSync(homeBroken, { recursive: true })
installLedger(homeBroken)
fs.writeFileSync(stateFile(homeBroken, 'projects.json'), fs.readFileSync(stateFile(home, 'projects.json')))

function transcriptDir(base, workspace, id) {
  const dir = path.join(base, 'sessions', workspace, 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// S9: первый кадр цел, но в нём неразобранная строка; второй кадр — мусор после
// магического числа zstd, распаковать его нельзя.
{
  const dir = transcriptDir(homeBroken, '--D-Agents-Workflow--', S9)
  const head = [
    { type: 'session', version: 3, id: 'session-' + S9 },
    { type: 'session/title', seq: 1, time: 1, data: { title: 'Бэкенд-разработчик [workflow] #14 — Обрыв', messageSeqs: [] } },
    msg(1, 1, 100, 10),
  ].map((row) => JSON.stringify(row) + '\n').join('')
  const first = zlib.zstdCompressSync(Buffer.from(head + '{ это не json\n', 'utf8'))
  const junkFrame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('junkjunkjunk')])
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([first, junkFrame]))
}

// S10: единственный кадр оборван посреди записи — zstd отдаёт из него пустоту и
// не падает, поэтому пустой разбор обязан стать замечанием.
{
  const dir = transcriptDir(homeBroken, '--D-Agents-Workflow--', S10)
  const rows = [
    { type: 'session', version: 3, id: 'session-' + S10 },
    { type: 'session/title', seq: 1, time: 1, data: { title: 'Тестировщик [workflow] #15 — Оборванная запись', messageSeqs: [] } },
    msg(1, 1, 700, 70),
    msg(2, 1, 300, 30),
  ].map((row) => JSON.stringify(row) + '\n').join('')
  const whole = zlib.zstdCompressSync(Buffer.from(rows, 'utf8'))
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), whole.subarray(0, Math.floor(whole.length / 2)))
}

// S11 (Б6): многокадровая стенограмма, целы только первые кадры, последний
// оборван — ровно тот случай, когда DSH убит или диск кончился на дописи кадра.
// Самые свежие события теряются, и отчёт обязан это сказать, а не показать
// заниженные числа как полные.
const S11_PARTIAL = 'недописанная запись, обрыв на середине'
{
  const dir = transcriptDir(homeBroken, '--D-Agents-Workflow--', S11)
  const frame = (rows) => zlib.zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row) + '\n').join(''), 'utf8'))
  const first = frame([
    { type: 'session', version: 3, id: 'session-' + S11 },
    { type: 'session/title', seq: 1, time: 1, data: { title: 'Бэкенд-разработчик [workflow] #14 — Длинная стенограмма', messageSeqs: [] } },
    msg(1, 1, 1000, 10),
  ])
  const second = frame([msg(2, 1, 2000, 20)])
  // Третий кадр с запасом по длине, чтобы обрыв дал непустой обрывок записи.
  const third = frame([{
    type: 'assistant/message',
    seq: 3,
    time: 3,
    data: { turn: 3, step: 1, usage: { inputTokens: 4000, outputTokens: 40 }, pad: S11_PARTIAL.repeat(300) },
  }])
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'),
    Buffer.concat([first, second, third.subarray(0, Math.floor(third.length * 0.6))]))
}

// ── песочница правила повтора ───────────────────────────────────────────────
// Проекция tokenUsage не удваивает счёт так: повторная выборка той же попытки с
// теми же числами заменяет прежнюю, а usage из потока assistant/attempt входит в
// итог наравне с usage готового сообщения.
const homeRule = path.join(process.cwd(), '.issue-tokens-rule-home')
fs.rmSync(homeRule, { recursive: true, force: true })
fs.mkdirSync(homeRule, { recursive: true })
installLedger(homeRule)
fs.writeFileSync(stateFile(homeRule, 'projects.json'), fs.readFileSync(stateFile(home, 'projects.json')))

// Запись потока — в настоящей форме стенограммы DSH: { type: 'chunk', time,
// chunk: { type: 'usage', usage: {…} } }. Выдуманная плоская форма { type: 'usage',
// usage } в стенограммах DSH не встречается, и тест это отдельно проверяет (S14).
const attemptUsage = (turn, step, input, output) => ({
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
// Плоская запись потока: такой формы в стенограммах DSH нет, счёт по ней нулевой.
const inventedAttemptUsage = (turn, step, input, output) => ({
  type: 'assistant/attempt',
  data: { turn, step, stream: [{ type: 'usage', usage: { inputTokens: input, outputTokens: output } }] },
})

// S12: та же попытка пришла дважды с теми же числами — считается один раз.
writeTranscript(homeRule, '--D-Agents-Workflow--', S12, 'Код-ревьюер [workflow] #16 — Двойной счёт', [
  msg(1, 1, 1000, 100),
  msg(1, 1, 1000, 100),
  msg(2, 1, 500, 50),
])
// S13: usage шага пришёл потоком assistant/attempt и повторился готовым сообщением.
writeTranscript(homeRule, '--D-Agents-Workflow--', S13, 'Тестировщик [workflow] #16 — Поток', [
  attemptUsage(1, 1, 200, 20),
  msg(1, 1, 200, 20),
])
// S14: единственное событие попытки с плоской записью потока — в DSH такой нет.
writeTranscript(homeRule, '--D-Agents-Workflow--', S14, 'Бэкенд-разработчик [workflow] #17 — Не форма DSH', [
  inventedAttemptUsage(1, 1, 900, 90),
])

const mod = await import('file:///' + cli.replace(/\\/g, '/') + '?v=' + Date.now())

// ── разбор аргументов ───────────────────────────────────────────────────────

console.log('=== разбор запуска ===')
check('проект и номер', (() => { const a = mod.parseArgs(['workflow', '14']); return [a.project, a.issue] })(), ['workflow', 14])
check('без аргументов — без фильтра', (() => { const a = mod.parseArgs([]); return [a.project, a.issue] })(), [undefined, undefined])
check('--dsh-home перед проектом', mod.parseArgs(['--dsh-home', 'D:\\tmp', 'vahta']).dshHome, 'D:\\tmp')
check('--dsh-home= в одном слове', mod.parseArgs(['--dsh-home=D:\\tmp', 'vahta']).dshHome, 'D:\\tmp')
let badArg = null
try { mod.parseArgs(['workflow', 'четырнадцать']) } catch (error) { badArg = error.message }
check('нечисловой номер объяснён', /номер тикета должен быть целым числом/.test(badArg || ''), true)

console.log('\n=== каталог сессии в каталоге установки ===')
check('D:\\Agents\\Workflow → --D-Agents-Workflow--', mod.workspaceDirName('D:\\Agents\\Workflow'), '--D-Agents-Workflow--')
const index = mod.workspaceIndex(stateFile(home, 'projects.json'))
check('реестр: рабочая область и клон человека — один проект',
  [index.index.get('--d-agents-workflow--'), index.index.get('--d-development-videcoding-workflow--')], ['workflow', 'workflow'])
check('реестр: чужой проект подписан своим именем', index.index.get('--d-agents-vahta--'), 'vahta')

// ── книга привязок ──────────────────────────────────────────────────────────

console.log('\n=== книга привязок ===')
const normalized = mod.normalizeLedger(JSON.parse(fs.readFileSync(stateFile(home, 'dev-department-usage.json'), 'utf8')))
check('четыре годные записи, повтор схлопнут', [normalized.entries.length, normalized.duplicates], [4, 1])
check('битая запись отброшена и посчитана', normalized.broken, 1)
check('префикс session- убран', normalized.entries[0].session, S1)
check('форма { entries: [...] } тоже принимается', mod.normalizeLedger({ entries: book }).entries.length, 4)
check('мёртвого problems в книге нет', Object.keys(normalized).sort(), ['broken', 'duplicates', 'entries'])

console.log('\n=== контракт ведра модуля учёта ===')
check('контрактные имена ведра переводятся в колонки', mod.normalizeUsage({
  uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
}), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
check('чужие имена ведра не принимаются молча', mod.normalizeUsage({
  in: 10, out: 20, cacheRead: 30, cacheWrite: 40,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

// ── отчёт по тикету ─────────────────────────────────────────────────────────

const report = await mod.buildReport({ dshHome: home, project: 'workflow', issue: 14 })
const tickets = report.tickets
check('один тикет в отчёте', tickets.length, 1)
check('номер тикета', [tickets[0] && tickets[0].project, tickets[0] && tickets[0].issue], ['workflow', 14])
check('название тикета из заголовка', tickets[0].title, 'Обновление кэша')

const rowOf = (id) => tickets[0].rows.find((row) => row.id === id)
const row = (id) => rowOf(id) || {}
console.log('\n=== строки тикета ===')
check('сессия из книги с префиксом session- найдена', [row(S1).role, row(S1).source], ['dev-backend', 'ledger'])
// Принятое правило — проекция tokenUsage: повтор шага после llm/retry-started
// добавляет вторую попытку (700 + 800), а не заменяет первую.
check('повтор шага добавляет вторую попытку, как проекция tokenUsage', row(S1).usage.input, 3300)
check('выход по тому же правилу', row(S1).usage.output, 33)
check('кэш-чтение и кэш-запись раздельно', [row(S1).usage.cacheRead, row(S1).usage.cacheWrite], [200, 50])
check('ходов: три хода, а не шесть сообщений', row(S1).turns, 3)
check('роль код-ревьюера из книги', row(S2).role, 'code-review')
check('сессия без записи в книге взята по заголовку', [row(S3).role, row(S3).source], [null, 'title'])
check('у привязки по заголовку роль не выдумана', row(S3).role, null)
check('запись книги без стенограммы видна в тикете', [row(S7).missing, row(S7).usage.input], [true, 0])
check('чужая сессия в тикет не попала', row(S6), {})
check('итоги тикета сложены из строк', tickets[0].totals, { input: 5700, output: 57, cacheRead: 300, cacheWrite: 50 })

console.log('\n=== восстановлено по заголовку ===')
check('в блоке ровно одна сессия', report.recovered.map((row) => row.id), [S3])

console.log('\n=== не привязано ===')
check('сессии без тикета в проекте', report.unbound.rows.map((row) => row.id), [S4])
check('сумма непривязанных', report.unbound.totals, { input: 100, output: 1, cacheRead: 10, cacheWrite: 0 })
check('сессия чужого каталога осталась вне проекта', report.counts.unboundOutside, 1)
check('запись книги без стенограммы посчитана отдельно', report.counts.ledgerOnly, 1)

console.log('\n=== сверка чисел ===')
check('привязанные + не привязанные = все стенограммы проекта',
  [report.counts.attached, report.counts.unbound, report.counts.diskInScope], [4, 1, 5])
check('ни одна сессия не выпала', report.problems.filter((p) => p.includes('выпала')), [])

// Запуск с номером тикета сужает только таблицы: сессии других тикетов того же
// проекта посчитаны и названы «вне отчёта», а не потеряны (возврат Б1).
const scoped = await mod.buildReport({ dshHome: home, project: 'workflow', issue: 14 })
const scopedText = mod.formatReport(scoped)
console.log('\n=== запуск с номером тикета ===')
check('сессии другого тикета проекта не объявлены потерей',
  scoped.problems.filter((p) => p.includes('выпала')), [])
check('сверка сходится по всему проекту',
  [scoped.counts.attached, scoped.counts.unbound, scoped.counts.diskInScope], [4, 1, 5])
checkText('в сводке галочка, а не расхождение', scopedText, '4+1=5 ✓')
check('крестика расхождения нет', scopedText.includes('✗'), false)
checkText('сужение названо строкой «вне отчёта»', scopedText, 'вне отчёта:')
checkText('в таблице только запрошенный тикет', scopedText, '=== workflow #14 — Обновление кэша ===')
check('таблица второго тикета не напечатана', scopedText.includes('=== workflow #15'), false)

const full = await mod.buildReport({ dshHome: home })
console.log('\n=== без фильтра по проекту ===')
check('тикеты двух проектов', full.tickets.map((t) => t.project + '#' + t.issue), ['vahta#193', 'workflow#14', 'workflow#15'])
check('все стенограммы посчитаны', [full.counts.attached + full.counts.unbound, full.counts.diskInScope], [7, 7])
check('непривязанные — только сессии без тикета',
  full.unbound.rows.map((row) => row.id).sort(), [S4, S5].sort())
check('проект неизвестной сессии не выдуман', (full.unbound.rows.find((row) => row.id === S5) || {}).project, null)

const onlyIssue = await mod.buildReport({ dshHome: home, project: 'workflow' })
check('фильтр без номера — два тикета проекта', onlyIssue.tickets.map((t) => t.project + '#' + t.issue), ['workflow#14', 'workflow#15'])

console.log('\n=== правило повтора (проекция tokenUsage) ===')
console.log('источник правила: ' + ledgerSource)
const rule = await mod.buildReport({ dshHome: homeRule, project: 'workflow', issue: 16 })
const ruleRow = (id) => ((rule.tickets[0] && rule.tickets[0].rows.find((row) => row.id === id)) || {})
check('та же попытка с теми же числами не посчитана дважды', ruleRow(S12).usage.input, 1500)
check('выход по тому же правилу', ruleRow(S12).usage.output, 150)
check('usage из потока assistant/attempt входит в итог', ruleRow(S13).usage.input, 200)
check('выход по тому же правилу', ruleRow(S13).usage.output, 20)
check('и повтор сообщения его не удваивает', ruleRow(S13).usage.output, 20)
check('итог тикета сложен из строк', rule.tickets[0] && rule.tickets[0].totals,
  { input: 1700, output: 170, cacheRead: 0, cacheWrite: 0 })

// Б8: в стенограмме DSH запись потока — { type: 'chunk', chunk: { type: 'usage', … } },
// поэтому плоская форма { type: 'usage', usage } не должна давать вклад: иначе
// эталон разойдётся с проекцией tokenUsage и половина `profiles/` повторит ошибку.
const legacy = await mod.buildReport({ dshHome: homeRule, project: 'workflow', issue: 17 })
const legacyRow = (legacy.tickets[0] && legacy.tickets[0].rows.find((row) => row.id === S14)) || {}
check('плоская запись потока из выдуманной формы не считается', [legacyRow.usage.input, legacyRow.usage.output], [0, 0])
check('и тикет при этом виден', legacy.tickets.map((t) => t.project + '#' + t.issue), ['workflow#17'])

// ── сбои разбора стенограммы ────────────────────────────────────────────────

const broken = await mod.buildReport({ dshHome: homeBroken, project: 'workflow', issue: 14 })
const brokenText = mod.formatReport(broken)
const brokenRow = (id) => (broken.tickets.flatMap((ticket) => ticket.rows).find((row) => row.id === id)) || {}
const brokenProblem = (id, needle) => broken.problems.filter((p) => p.includes(id) && p.includes(needle)).length
console.log('\n=== повреждённая стенограмма ===')
check('битый кадр посчитан', brokenRow(S9).brokenFrames, 1)
check('неразобранная строка посчитана', brokenRow(S9).droppedLines, 1)
check('целые события битого кадра всё равно посчитаны', brokenRow(S9).usage.input, 100)
check('замечание про кадр адресовано сессии', brokenProblem(S9, 'кадр стенограммы не разобран целиком'), 1)
check('замечание про строку есть', brokenProblem(S9, 'строка стенограммы не разобралась'), 1)
// Б6: оборванный последний кадр среди целых — zstd отдаёт из него пустоту или
// обрывок записи и не бросает, поэтому детект держится на «текст не кончается \n».
check('единственный оборванный кадр назван', brokenProblem(S10, 'кадр стенограммы не разобран целиком'), 1)
check('последний кадр многокадровой стенограммы посчитан сбоем', brokenRow(S11).brokenFrames, 1)
check('замечание по нему есть', brokenProblem(S11, 'кадр стенограммы не разобран целиком'), 1)
check('числа по целым кадрам сохранены', brokenRow(S11).usage.input, 3000)
check('выход по целым кадрам тоже сохранён', brokenRow(S11).usage.output, 30)
checkText('замечания доходят до печати', brokenText, '=== замечания ===')
checkText('в печати назван оборванный кадр', brokenText, 'кадр стенограммы не разобран целиком')

// ── печать ──────────────────────────────────────────────────────────────────

console.log('\n=== вывод отчёта ===')
const text = mod.formatReport(report)
checkText('колонки таблицы', text, 'тикет')
checkText('колонка роль', text, 'роль')
checkText('колонка сессия', text, 'сессия')
checkText('колонка ходов', text, 'ходов')
checkText('колонка вход', text, 'вход')
checkText('колонка выход', text, 'выход')
checkText('колонка кэш-чтение', text, 'кэш-чтение')
checkText('заголовок тикета с названием', text, '=== workflow #14 — Обновление кэша ===')
checkText('строка с числом сессий', text, '4 сессии')
checkText('итоги тикета', text, 'итого: вход 5 700 · выход 57 · кэш-чтение 300')
checkText('кэш-запись отдельной величиной', text, 'кэш-запись 50')
checkText('блок «не привязано»', text, '=== не привязано ===')
checkText('блок «восстановлено по заголовку»', text, '=== восстановлено по заголовку ===')
checkText('пометка привязки по заголовку', text, 'привязка по заголовку, не из книги')
checkText('сверка сошлась', text, '4+1=5 ✓')
checkText('запись без стенограммы названа', text, 'только в книге, без стенограммы: 1')
// Б4: строка постановки не выдаёт себя за роль конвейера. На живой машине сессию
// постановки открывает человек под пресетом `standard`, поэтому признак — `source`
// записи книги, а не роль.
check('origin записи книги доходит до строки (Б4)', [row(S1).origin, row(S7).origin], ['dispatcher', 'issue-created'])
checkText('строка постановки помечена (Б4)', text, 'analyst (постановка)')
check('у роли конвейера пометки нет', text.includes('dev-backend (постановка)'), false)
const emptyText = mod.formatReport(await mod.buildReport({ dshHome: home, project: 'workflow', issue: 99 }))
checkText('пустой тикет — не пустой вывод', emptyText, 'тикетов не найдено')

// ── запуск из командной строки ──────────────────────────────────────────────

// Вывод перенаправляем в файлы, а не в канал: так запуск работает и там, где
// каналы между процессами запрещены.
function runCli(args, budget = 20000, cliPath = cli) {
  const outFile = path.join(home, 'cli-out.txt')
  const errFile = path.join(home, 'cli-err.txt')
  fs.rmSync(outFile, { force: true })
  fs.rmSync(errFile, { force: true })
  const out = fs.openSync(outFile, 'w')
  const err = fs.openSync(errFile, 'w')
  const result = spawnSync(process.execPath, [cliPath, ...args], { stdio: ['ignore', out, err], timeout: budget })
  fs.closeSync(out)
  fs.closeSync(err)
  return {
    status: result.status,
    out: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
    err: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
  }
}

// «Модуля учёта нет» проверяется в каталоге, где его нет вовсе. В песочнице
// каталога установки модуль отсутствует, но отчёт ищет запасной кандидат рядом с
// собой, а половина `profiles/` уже положила туда настоящий модуль — поэтому
// запускаем копию отчёта со своим хелпером кадров из каталога без `profiles/`.
const bareDir = path.join(process.cwd(), '.issue-tokens-bare')
fs.rmSync(bareDir, { recursive: true, force: true })
fs.mkdirSync(bareDir, { recursive: true })
fs.copyFileSync(cli, path.join(bareDir, 'issue-tokens.mjs'))
fs.copyFileSync(path.resolve(TEST_DIR, '..', 'zstd-frames.mjs'), path.join(bareDir, 'zstd-frames.mjs'))
// Помощник раскладок — сосед отчёта по импорту: без него копия не загрузится.
fs.copyFileSync(path.resolve(TEST_DIR, '..', 'plugin-paths.mjs'), path.join(bareDir, 'plugin-paths.mjs'))
const bareCli = path.join(bareDir, 'issue-tokens.mjs')

console.log('\n=== запуск node tools/issue-tokens.mjs ===')
const live = runCli(['--dsh-home', home, 'workflow', '14'])
check('код возврата 0', live.status, 0)
checkText('числа дошли до печати', live.out, 'итого: вход 5 700 · выход 57 · кэш-чтение 300')
checkText('книга прочитана из --dsh-home', live.out, 'dev-department-usage.json')
const none = runCli(['--dsh-home', home, 'workflow', '99'])
check('тикет без сессий — тоже успех', none.status, 0)
checkText('и об этом сказано', none.out, 'тикетов не найдено')
const usage = runCli(['--help'])
checkText('справка печатается', usage.out, 'node tools/issue-tokens.mjs [проект] [номер]')
const noModule = runCli(['--dsh-home', homeNoModule, 'workflow'], 20000, bareCli)
check('без модуля учёта — код 2', noModule.status, 2)
checkText('и объяснение, чего не хватает', noModule.err, 'модуль учёта не найден')
// Модуль с чужим именем ведра — честная ошибка на контракте, а не нули в отчёте.
const badContract = runCli(['--dsh-home', homeBadContract, 'workflow'])
check('нарушенный контракт ведра — код 2', badContract.status, 2)
checkText('и названы пропавшие имена', badContract.err, 'нет контрактных имён: uncachedInputTokens')
// Б2: правило «ходов» одно на отдел и живёт в модуле учёта; модуль без него отчёт
// отвергает, а не считает своей копией правила.
const noTurns = runCli(['--dsh-home', homeNoTurns, 'workflow'])
check('модуль без правила ходов — код 2', noTurns.status, 2)
checkText('и названа пропавшая функция', noTurns.err, 'нет функции turnsOfEvents')
// Живой запуск на повреждённых стенограммах: сбой виден человеку, а не только тесту.
const liveBroken = runCli(['--dsh-home', homeBroken, 'workflow', '14'])
check('с повреждёнными стенограммами отчёт всё равно печатается', liveBroken.status, 0)
checkText('и говорит о недосчёте', liveBroken.out, 'кадр стенограммы не разобран целиком')

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeNoModule, { recursive: true, force: true })
fs.rmSync(homeBroken, { recursive: true, force: true })
fs.rmSync(homeRule, { recursive: true, force: true })
fs.rmSync(homeBadContract, { recursive: true, force: true })
fs.rmSync(homeNoTurns, { recursive: true, force: true })
fs.rmSync(bareDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
