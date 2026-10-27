// Книга привязок «сессия → тикет» и счёт потраченных токенов.
//
// Зачем книга. DSH и так пишет расход на каждый шаг (`assistant/message.data.usage`
// и usage-чанк потока попытки), но не знает, к какому тикету относится сессия.
// Заголовок сессии закрывает роли конвейера, а аналитика — нет: его сессию открывает
// человек, и номера тикета в ней ещё нет. Поэтому привязку пишут в момент, когда она
// рождается: диспетчер — при запуске роли по тикету (`source: "dispatcher"`), и он же
// привязывает сессию, в которой тикет родился (`source: "issue-created"`, см.
// `findDraftSession`; своего крючка на создание issue у отдела нет — GitHub идёт
// через MCP-сервер).
//
// Файл книги — `<DSH_HOME>/dev-department-usage.json`, append-only массив записей
// `{ at, project, issue, role, session, attempt, source }`. Каталог читается НА
// МОМЕНТ ВЫЗОВА (`process.env.DSH_HOME || ~/.dsh`), а не на момент импорта модуля:
// так отчёт `tools/issue-tokens.mjs` может указать другой каталог установки.
//
// Главное правило здесь — правило повтора, и оно одно на весь отдел: карточка
// `dev_department_status`, сводка смены и отчёт по токенам обязаны показывать одни
// числа. Правило взято у проекции DSH `tokenUsage` (stateVersion 2) и повторяет её
// `apply()` один в один:
//   • `llm/retry-started` только закрывает слот замены — повторная попытка шага
//     ДОБАВЛЯЕТСЯ к итогу, а не удваивает его;
//   • `assistant/attempt` тоже даёт вклад — usage из последнего usage-чанка его
//     потока, записанного формой DSH `{ type: 'chunk', chunk: { type: 'usage' } }`;
//   • повторная выборка той же попытки с теми же числами заменяет прежнюю, а не
//     прибавляется.
// Вёдра отдаются контрактными именами проекции: `uncachedInputTokens`,
// `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`. Отчёт по токенам проверяет
// эти имена пробным вызовом: переименование ведра не должно молча стать нулями.
//
// Запасной путь — стенограмма на диске (`readUsageFromDisk`): он нужен сессиям, до
// которых `sessionQuery.readSurface` не дотянулся (сессия прошлых смен, закрытое
// приложение). Приём разбора кадров `zstd` повторяет `tools/zstd-frames.mjs`:
// импортировать его отсюда нельзя, каталог `tools/` в установку не раскладывается.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// Имя книги рядом с каталогом установки.
export const LEDGER_NAME = 'dev-department-usage.json'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// Путь книги считается на каждый вызов: DSH_HOME читается в момент обращения.
export function ledgerFile() {
  return path.join(dshHome(), LEDGER_NAME)
}

// Журнал отдела есть всегда; строка о проблеме книги не должна ломать смену.
function logLine(text) {
  try {
    fs.appendFileSync(path.join(dshHome(), 'dev-department.log'),
      '\n===== ' + new Date().toISOString() + ' =====\nкнига учёта: ' + text + '\n')
  } catch (error) {
    // журнал не должен мешать работе
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

// ── книга привязок ──────────────────────────────────────────────────────────

// Книга и каталог сессий зовут сессию по-разному: с префиксом session- и без.
export function normalizeSessionId(session) {
  return String(session === undefined || session === null ? '' : session).trim().replace(/^session-/, '')
}

function entryKey(entry) {
  return String(entry.project).trim() + '|' + Number(entry.issue) + '|' + normalizeSessionId(entry.session)
}

// Запись книги в канонической форме или null, если её не из чего собрать.
function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const project = typeof entry.project === 'string' ? entry.project.trim() : ''
  const session = typeof entry.session === 'string' ? entry.session.trim() : ''
  const issue = Number(entry.issue)
  if (project === '' || session === '' || !Number.isInteger(issue) || issue <= 0) return null
  const attempt = Number(entry.attempt)
  return {
    at: typeof entry.at === 'string' && entry.at !== '' ? entry.at : new Date().toISOString(),
    project,
    issue,
    role: typeof entry.role === 'string' && entry.role !== '' ? entry.role : null,
    session,
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    source: typeof entry.source === 'string' && entry.source !== '' ? entry.source : null,
  }
}

// Чтение файла с различением трёх исходов: нет файла (пустая книга), файл не
// читается, файл не разбирается. Различать нужно: нечитаемую книгу нельзя
// перезаписывать, иначе теряется вся история привязок.
function readRaw() {
  const file = ledgerFile()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], missing: true, broken: null }
    return { entries: [], missing: false, broken: 'не читается ' + file + ': ' + (error && error.message ? error.message : String(error)) }
  }
  try {
    const data = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : [])
    return { entries: list, missing: false, broken: null }
  } catch (error) {
    return {
      entries: [],
      missing: false,
      broken: 'книга ' + file + ' повреждена: ' + (error && error.message ? error.message : String(error)) +
        ' — файл не перезаписан, история привязок сохранена',
    }
  }
}

// Дедуп по ключу «проект|тикет|сессия»: повторная выдача роли в тот же диалог не
// должна добавлять вторую запись, иначе отчёт посчитал бы сессию дважды.
function dedupe(list) {
  const seen = new Set()
  const entries = []
  for (const raw of list) {
    const entry = cleanEntry(raw)
    if (entry === null) continue
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

// Книга целиком. Ошибка чтения не перезаписывает файл: пишем строку в журнал
// отдела и возвращаем пустую книгу.
export function readLedger() {
  const raw = readRaw()
  if (raw.broken) {
    logLine(raw.broken)
    return []
  }
  return dedupe(raw.entries)
}

// Атомарная запись книги: соседний временный файл и переименование. Половинчатая
// книга хуже отсутствующей — по ней теряются все прежние привязки.
function writeLedger(entries) {
  const file = ledgerFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    // На Windows переименование поверх занятого файла иногда отказывает: тогда
    // пишем на месте, но только после успешного чтения книги (см. appendLedgerEntry).
    fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n')
    try { fs.rmSync(tmp, { force: true }) } catch (cleanup) { /* временный файл уберётся сам */ }
  }
}

// Дозапись привязки. Возвращает `{ added, duplicate, reason, file }`.
// Нечитаемую книгу НЕ перезаписываем: пропускаем привязку и говорим об этом
// вызывающему, чтобы он сказал человеку.
export function appendLedgerEntry(entry) {
  const clean = cleanEntry(entry)
  if (clean === null) return { added: false, duplicate: false, reason: 'запись неполная: нужны project, issue, session', file: ledgerFile() }
  const raw = readRaw()
  if (raw.broken) {
    logLine(raw.broken)
    return { added: false, duplicate: false, reason: raw.broken, file: ledgerFile() }
  }
  const entries = dedupe(raw.entries)
  const key = entryKey(clean)
  if (entries.some((existing) => entryKey(existing) === key)) {
    return { added: false, duplicate: true, reason: null, file: ledgerFile() }
  }
  try {
    writeLedger([...entries, clean])
  } catch (error) {
    const reason = 'книга ' + ledgerFile() + ' не записалась: ' + (error && error.message ? error.message : String(error))
    logLine(reason)
    return { added: false, duplicate: false, reason, file: ledgerFile() }
  }
  return { added: true, duplicate: false, reason: null, file: ledgerFile() }
}

// ── счёт токенов: правило проекции tokenUsage ───────────────────────────────

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

// Последняя запись потока нужного вида — как lastAssistantStreamChunk в DSH: запись
// лежит на двух уровнях, `record.chunk.type`. Плоская форма `{ type: 'usage' }` в
// стенограммах DSH не встречается и вклада не даёт — иначе счёт разошёлся бы с
// проекцией, которую показывает GUI.
function lastStreamChunk(stream, type) {
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === type) return record.chunk
  }
  return undefined
}

function usageOf(event) {
  const data = (event && event.data) || {}
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (!Array.isArray(data.stream)) return undefined
  const chunk = lastStreamChunk(data.stream, 'usage')
  return chunk === undefined ? undefined : chunk.usage
}

// Сумма usage событий сессии. Чистая функция: ни диска, ни сервисов.
export function usageOfEvents(events) {
  let totals = zeroBuckets()
  let last = null
  for (const event of events || []) {
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

// Ходы, в которых модель что-то произвела: ход без единого сообщения токенов не
// тратит, поэтому его не считаем. Без номеров ходов — считаем turn/start.
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

// ── запасной путь: стенограмма на диске ─────────────────────────────────────

// Магическое число кадра zstd (little-endian 0xFD2FB528).
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const isFrameStart = (bytes, index) =>
  bytes[index] === FRAME_MAGIC[0] && bytes[index + 1] === FRAME_MAGIC[1] &&
  bytes[index + 2] === FRAME_MAGIC[2] && bytes[index + 3] === FRAME_MAGIC[3]

// Кадры подряд → текст и счёт сбоев. Обрывок кадра zstd не бросает исключение, а
// отдаёт пустую строку или недописанную запись, поэтому кадр считается сбоем, если
// его текст пуст или не кончается переводом строки (полный кадр DSH — целое число
// строк JSONL).
function unzstdFrames(bytes) {
  const parts = []
  let brokenFrames = 0
  let start = -1
  const flush = (end) => {
    let text
    try {
      text = zlib.zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
    } catch (error) {
      brokenFrames += 1
      return
    }
    if (text === '' || !text.endsWith('\n')) brokenFrames += 1
    parts.push(text)
  }
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (!isFrameStart(bytes, i)) continue
    if (start >= 0) flush(i)
    start = i
  }
  if (start >= 0) flush(bytes.length)
  return { text: parts.join('\n'), brokenFrames }
}

// Все стенограммы каталога сессий: id → файл. Каталог сессии DSH зовёт
// `session-<id>`, книга может хранить id с префиксом или без.
export function findTranscript(home, sessionId) {
  const root = path.join(home || dshHome(), 'sessions')
  const wanted = normalizeSessionId(sessionId)
  let workspaces
  try {
    workspaces = fs.readdirSync(root)
  } catch (error) {
    return { file: null, problems: ['каталога сессий нет: ' + root] }
  }
  for (const workspace of workspaces) {
    const base = path.join(root, workspace)
    let names
    try {
      names = fs.readdirSync(base)
    } catch (error) {
      continue
    }
    for (const name of names) {
      if (normalizeSessionId(name) !== wanted) continue
      const file = path.join(base, name, 'session.v3.jsonl.zstd')
      if (!fs.existsSync(file)) return { file: null, problems: ['стенограммы нет: ' + file] }
      return { file, problems: [] }
    }
  }
  return { file: null, problems: ['сессия не найдена в каталоге сессий: ' + wanted] }
}

// Usage сессии по стенограмме. Сбои разбора не проглатываются: возвращаются
// счётчиками, чтобы вызывающий сказал человеку, что числа меньше настоящих.
export function readUsageFromDisk(home, sessionId) {
  const found = findTranscript(home, sessionId)
  if (found.file === null) {
    return { usage: zeroBuckets(), turns: 0, events: 0, brokenFrames: 0, droppedLines: 0, problems: found.problems }
  }
  const problems = []
  let bytes
  try {
    bytes = fs.readFileSync(found.file)
  } catch (error) {
    return {
      usage: zeroBuckets(), turns: 0, events: 0, brokenFrames: 0, droppedLines: 0,
      problems: ['стенограмма не читается: ' + found.file + ' — ' + (error && error.message ? error.message : String(error))],
    }
  }
  const { text, brokenFrames } = unzstdFrames(bytes)
  const events = []
  let droppedLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      droppedLines += 1
    }
  }
  if (brokenFrames > 0) {
    problems.push('кадр стенограммы не разобран целиком: ' + found.file + ' — кадров: ' + brokenFrames +
      '; события из них попали в сумму не полностью, числа по сессии меньше настоящих')
  }
  if (droppedLines > 0) {
    problems.push('строка стенограммы не разобралась: ' + found.file + ' — строк: ' + droppedLines)
  }
  return {
    usage: usageOfEvents(events),
    turns: turnsOfEvents(events),
    events: events.length,
    brokenFrames,
    droppedLines,
    problems,
    file: found.file,
  }
}

// ── сессия, в которой родился тикет ─────────────────────────────────────────
//
// Аналитика конвейер не запускает: сессию постановки открывает человек, и номера
// тикета в её заголовке ещё нет. Крючка на создание issue у отдела тоже нет — с
// переездом GitHub на MCP-сервер постановку создаёт чужой процесс, а не наш код.
// Поэтому «сессия, в которой родился тикет» не пишется, а ищется по времени: на
// первом тике, который увидел новый тикет, диспетчер берёт сессию проекта, чья
// жизнь накрывает `created_at` тикета и которая ещё ни к одному тикету не
// привязана. Догадка проверяемая — она опирается на данные DSH, а не на слова
// агента, — и когда подходящей сессии нет, привязки просто нет.

const SESSION_FILE = 'session.v3.jsonl.zstd'
// Событие `session` — самое первое в стенограмме, и в нём уже есть `cwd`,
// `agentPreset` и `createdAt`. Целую стенограмму ради этого не читаем.
const HEAD_BYTES = 256 * 1024

// Пути сравниваем без регистра и с одним видом разделителя: реестр проектов,
// рабочая область и событие `session` пишут один и тот же каталог по-разному.
function pathKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Заголовок одной сессии: первое событие стенограммы и время последней записи.
// null — стенограмма не прочиталась; о такой сессии говорит `problems`.
export function readSessionHead(file, folder) {
  let bytes
  let stat
  try {
    stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    try {
      const want = Math.min(stat.size, HEAD_BYTES)
      bytes = Buffer.alloc(want)
      fs.readSync(fd, bytes, 0, want, 0)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    return null
  }
  // Декодируем только первый кадр: остальные для привязки не нужны, а стенограмма
  // тянет мегабайты. Недописанный кадр отдаёт обрывок текста — до первой строки
  // JSONL этого хватает.
  let end = bytes.length
  for (let i = 4; i + 4 <= bytes.length; i += 1) {
    if (isFrameStart(bytes, i)) {
      end = i
      break
    }
  }
  let text
  try {
    text = zlib.zstdDecompressSync(bytes.subarray(0, end)).toString('utf8')
  } catch (error) {
    return null
  }
  const line = text.split('\n').find((row) => row.trim() !== '')
  if (!line) return null
  let event
  try {
    event = JSON.parse(line)
  } catch (error) {
    return null
  }
  if (!event || event.type !== 'session') return null
  return {
    session: normalizeSessionId(event.id || folder),
    cwd: String(event.cwd || ''),
    preset: String(event.agentPreset || ''),
    createdAt: Number(event.createdAt),
    updatedAt: Number(stat.mtimeMs),
  }
}

// Заголовки всех сессий каталога установки: `session-<id>` — и ещё id из события
// `session`, потому что книга и каталог пишут его по-разному.
export function listSessionHeads(home) {
  const root = path.join(home || dshHome(), 'sessions')
  const heads = []
  const problems = []
  let workspaces
  try {
    workspaces = fs.readdirSync(root)
  } catch (error) {
    return { heads, problems: ['каталога сессий нет: ' + root] }
  }
  for (const workspace of workspaces) {
    const base = path.join(root, workspace)
    let names
    try {
      names = fs.readdirSync(base)
    } catch (error) {
      continue
    }
    for (const name of names) {
      const file = path.join(base, name, SESSION_FILE)
      if (!fs.existsSync(file)) continue
      const head = readSessionHead(file, name)
      if (head === null) {
        problems.push('заголовок сессии не прочитался: ' + file)
        continue
      }
      heads.push(head)
    }
  }
  return { heads, problems }
}

// Какая сессия проекта накрывает момент рождения тикета. Чистая функция: заголовки
// ей подаёт `listSessionHeads`, привязку — вызывающий. Правила:
//   • сессия, уже привязанная к тикету, не рассматривается вовсе;
//   • каталог сессии должен быть каталогом проекта (рабочая область или клон человека);
//   • жизнь сессии накрывает `created` с допуском `slackMs` в обе стороны;
//   • из подходящих берётся самая поздняя по началу: долго живущий диалог человека
//     накрывает все новые тикеты, и без этого правила он забирал бы их себе.
//   • начало сессии не раньше `created - windowMs`: тот же долгий диалог не должен
//     притягивать тикет, заведённый спустя недели.
export function findDraftSession(heads, options) {
  const opts = options || {}
  const created = Number(opts.created)
  if (!Number.isFinite(created)) return null
  const cwds = (opts.cwds || []).filter(Boolean).map(pathKey)
  const bound = new Set((opts.bound || []).map(normalizeSessionId))
  const slack = Number.isFinite(opts.slackMs) ? opts.slackMs : 60 * 60 * 1000
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 3 * 24 * 60 * 60 * 1000
  let best = null
  for (const head of heads || []) {
    if (!head || !head.session) continue
    if (bound.has(normalizeSessionId(head.session))) continue
    if (cwds.length > 0) {
      const where = pathKey(head.cwd)
      if (where === '' || cwds.indexOf(where) === -1) continue
    }
    const started = Number(head.createdAt)
    const stopped = Number(head.updatedAt)
    if (!Number.isFinite(started) || !Number.isFinite(stopped)) continue
    if (started > created + slack) continue
    if (started < created - windowMs) continue
    if (stopped < created - slack) continue
    if (best === null || started > best.createdAt) best = head
  }
  return best
}

// ── сумма по тикету ─────────────────────────────────────────────────────────

const shortBuckets = (buckets) => ({
  in: num(buckets.uncachedInputTokens),
  out: num(buckets.outputTokens),
  cacheRead: num(buckets.cacheReadTokens),
  cacheWrite: num(buckets.cacheWriteTokens),
})

// `readUsage(entry)` — как читать одну сессию: `{ usage, turns, problems? }`, где
// usage — вёдра проекции (можно и короткие имена: они поймутся). Живой путь —
// `sessionQuery.readSurface`, запасной — `readUsageFromDisk`.
function normalizeReadResult(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw
  const buckets = {
    uncachedInputTokens: num(usage.uncachedInputTokens !== undefined ? usage.uncachedInputTokens : usage.in),
    outputTokens: num(usage.outputTokens !== undefined ? usage.outputTokens : usage.out),
    cacheReadTokens: num(usage.cacheReadTokens !== undefined ? usage.cacheReadTokens : usage.cacheRead),
    cacheWriteTokens: num(usage.cacheWriteTokens !== undefined ? usage.cacheWriteTokens : usage.cacheWrite),
  }
  const turns = Number.isFinite(Number(raw.turns)) ? Number(raw.turns) : 0
  const problems = Array.isArray(raw.problems) ? raw.problems : []
  return { buckets, turns, problems }
}

// Сумма по всем сессиям одного тикета: строки по ролям и итог. Записи книги уже
// дедуплицированы по ключу «проект|тикет|сессия», поэтому одна сессия — одна строка.
export async function summarizeIssue(entries, readUsage) {
  const list = []
  const seen = new Set()
  for (const raw of entries || []) {
    const entry = cleanEntry(raw)
    if (entry === null) continue
    // Сессия — одна строка, даже если книга пришла с повтором (id с префиксом
    // session- и без него): иначе расход посчитался бы дважды.
    const key = normalizeSessionId(entry.session)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(entry)
  }
  const issue = list.length > 0 ? list[0].issue : null
  const project = list.length > 0 ? list[0].project : null
  const sessions = []
  const problems = []
  for (const entry of list) {
    let result
    try {
      result = normalizeReadResult(await readUsage(entry))
    } catch (error) {
      problems.push('usage сессии ' + entry.session + ' не прочитан: ' + (error && error.message ? error.message : String(error)))
      result = normalizeReadResult({})
    }
    for (const problem of result.problems) problems.push(problem)
    sessions.push({
      role: entry.role,
      session: entry.session,
      attempts: entry.attempt,
      source: entry.source,
      turns: result.turns,
      in: result.buckets.uncachedInputTokens,
      out: result.buckets.outputTokens,
      cacheRead: result.buckets.cacheReadTokens,
      cacheWrite: result.buckets.cacheWriteTokens,
    })
  }
  const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  for (const row of sessions) {
    totals.in += row.in
    totals.out += row.out
    totals.cacheRead += row.cacheRead
    totals.cacheWrite += row.cacheWrite
  }
  return { project, issue, sessions, totals, problems }
}

// Строка для человека: «вход 1 234 · выход 56 · кэш-чтение 7 890».
const fmtNumber = (value) => num(value).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')

export function usageLine(totals, options) {
  const opts = options || {}
  const parts = [
    'вход ' + fmtNumber(totals.in),
    'выход ' + fmtNumber(totals.out),
    'кэш-чтение ' + fmtNumber(totals.cacheRead),
  ]
  if (opts.withCacheWrite === true || num(totals.cacheWrite) !== 0) parts.push('кэш-запись ' + fmtNumber(totals.cacheWrite))
  return parts.join(' · ')
}

// Цена по тарифу. Числа тарифа приходят из ~/.dsh/dev-department.json
// (`usageRates`), в коде их нет: валюта и тариф — решение человека, а не отдела.
// Незаданный тариф — строки с ценой нет вовсе, а не «$0.00» рядом с нулём.
export function costOf(totals, rates) {
  if (!rates || typeof rates !== 'object') return null
  const take = (key) => (typeof rates[key] === 'number' && Number.isFinite(rates[key]) && rates[key] >= 0 ? rates[key] : 0)
  const input = take('inputUsdPerM')
  const output = take('outputUsdPerM')
  const cacheRead = take('cacheReadUsdPerM')
  const cacheWrite = take('cacheWriteUsdPerM')
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  const usd = (num(totals.in) * input + num(totals.out) * output +
    num(totals.cacheRead) * cacheRead + num(totals.cacheWrite) * cacheWrite) / 1000000
  return usd
}

export function formatCost(usd) {
  if (usd === null || usd === undefined) return null
  return '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2))
}
