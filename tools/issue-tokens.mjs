#!/usr/bin/env node
// Отчёт по токенам на тикет: книга привязок «сессия → тикет» и стенограммы сессий.
//
//   node tools/issue-tokens.mjs                 все проекты, все тикеты
//   node tools/issue-tokens.mjs workflow        один проект
//   node tools/issue-tokens.mjs workflow 14     один тикет
//
// Каталог установки: $DSH_HOME, иначе ~/.dsh; переопределяется ключом
// --dsh-home <путь> (ключ можно ставить где угодно в строке запуска).
//
// Отчёт не считает токены сам: правило «повтор шага после llm/retry-started
// считается один раз» — достояние модуля учёта
// profiles/desktop/plugins/usage-ledger.mjs, здесь только раскладка чисел по
// тикетам и печать. Модуль берётся из каталога установки (туда его кладёт
// `node sync.mjs apply`), а если его там ещё нет — из репозитория рядом с этим
// файлом: так отчёт работает в рабочей копии до раскладки.
//
// Привязка сессии к тикету, в порядке старшинства:
//   1) запись книги ~/.dsh/dev-department-usage.json — её пишут диспетчер при
//      запуске роли и аналитик при создании тикета;
//   2) заголовок сессии вида «Бэкенд-разработчик [workflow] #14 — …» (роли
//      конвейера, но не аналитик: у него в заголовке нет номера) — такие строки
//      дополнительно попадают в блок «восстановлено по заголовку»;
//   3) ничего не совпало — блок «не привязано»; сессия не теряется.
// Проект сессии, не названный ни книгой, ни заголовком, берётся из каталога
// рабочей области (~/.dsh/projects.json: workspace и humanClone).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readTranscript } from './zstd-frames.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(SCRIPT_DIR)

// Модуль учёта: единственное место, где живёт правило повтора.
const LEDGER_MODULE = path.join('profiles', 'desktop', 'plugins', 'usage-ledger.mjs')
// Книга привязок рядом с каталогом установки.
const LEDGER_FILE = 'dev-department-usage.json'
// Заголовок сессии конвейера: «Код-ревьюер [workflow] #14 — …».
const TITLE_PATTERN = /\[([\w-]+)\]\s*#(\d+)/
// Контракт модуля учёта зафиксирован: ведра проекции tokenUsage называются ровно
// так, и других имён отчёт не принимает — иначе переименование ведра в модуле
// молча превратится в нули вместо честного расхождения на контракте.
const USAGE_FIELDS = {
  input: 'uncachedInputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
}

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// ── разбор чисел и печать ───────────────────────────────────────────────────

// Неразрывные пробелы из toLocaleString ломают колонки и поиск в выводе.
const fmt = (value) => num(value).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')
const cells = (text) => String(text === undefined || text === null ? '' : text)
const SESSIONS = ['сессия', 'сессии', 'сессий']

function plural(count, forms) {
  const n = Math.abs(count) % 100
  const tail = n % 10
  if (n > 10 && n < 20) return forms[2]
  if (tail > 1 && tail < 5) return forms[1]
  if (tail === 1) return forms[0]
  return forms[2]
}

// Таблица с выравниванием: числовые колонки прижимаются вправо, текстовые влево.
function table(headers, rows, align = []) {
  const isRight = (index) => align[index] === 'right'
  const widths = headers.map((header, index) =>
    Math.max(cells(header).length, ...rows.map((row) => cells(row[index]).length)))
  const line = (values) => values
    .map((value, index) => (isRight(index) ? cells(value).padStart(widths[index]) : cells(value).padEnd(widths[index])))
    .join('  ')
    .trimEnd()
  return [line(headers), ...rows.map(line)]
}

// ── окружение ───────────────────────────────────────────────────────────────

function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function parseArgs(argv) {
  const rest = []
  let dshHome = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh-home') {
      dshHome = argv[i + 1] || null
      i += 1
      continue
    }
    if (arg.startsWith('--dsh-home=')) {
      dshHome = arg.slice('--dsh-home='.length)
      continue
    }
    if (arg === '--help' || arg === '-h') return { help: true }
    rest.push(arg)
  }
  const [project, issue] = rest
  const parsed = { dshHome: dshHome || defaultDshHome() }
  if (project) parsed.project = project
  if (issue !== undefined) {
    const number = Number(issue)
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error('номер тикета должен быть целым числом, получено: ' + issue)
    }
    parsed.issue = number
  }
  if (rest.length > 2) parsed.extra = rest.slice(2)
  return parsed
}

// Реестр проектов: каталог рабочей области и клон человека → имя проекта.
// Оба каталога — один проект: сессия в клоне человека тоже его.
export function workspaceIndex(projectsFile) {
  const index = new Map()
  let data
  try {
    data = JSON.parse(fs.readFileSync(projectsFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { index, problems: ['реестр проектов не читается: ' + projectsFile + ' — ' + error.message] }
  }
  const projects = data && typeof data.projects === 'object' && data.projects !== null ? data.projects : {}
  for (const [id, project] of Object.entries(projects)) {
    for (const key of ['workspace', 'humanClone']) {
      const value = project && project[key]
      if (typeof value === 'string' && value.trim() !== '') {
        index.set(workspaceDirName(value).toLowerCase(), id)
      }
    }
  }
  return { index, problems: [] }
}

// DSH зовёт каталог сессий именем рабочей области: D:\Agents\Workflow →
// --D-Agents-Workflow--. Сверяем регистронезависимо: диск Windows.
export function workspaceDirName(workspace) {
  return '--' + String(workspace).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '') + '--'
}

// ── стенограммы ─────────────────────────────────────────────────────────────

// Кадры zstd и разбор строк — общий хелпер `tools/zstd-frames.mjs` (тот же, что
// в `tools/session-tail.mjs`): один разбор на два инструмента, один счётчик сбоев.

// Заголовок сессии — последнее событие session/title: человек мог переименовать.
function titleOf(rows) {
  let title = null
  for (const row of rows) {
    if (row.type === 'session/title' && row.data && typeof row.data.title === 'string') title = row.data.title
  }
  return title
}

// «ходов» — ходы, в которых модель что-то произвела: по событию assistant/message
// на ход. Ход без единого сообщения токенов не тратит, поэтому его не считаем.
function turnsOf(rows) {
  const turns = new Set()
  for (const row of rows) {
    if (row.type !== 'assistant/message' || !row.data) continue
    if (typeof row.data.turn === 'number') turns.add(row.data.turn)
  }
  if (turns.size > 0) return turns.size
  let started = 0
  for (const row of rows) if (row.type === 'turn/start') started += 1
  return started
}

// Модуль учёта отдаёт ведра проекции tokenUsage под их контрактными именами;
// отчёт переводит их в короткие имена своих колонок.
export function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {}
  return {
    input: num(source[USAGE_FIELDS.input]),
    output: num(source[USAGE_FIELDS.output]),
    cacheRead: num(source[USAGE_FIELDS.cacheRead]),
    cacheWrite: num(source[USAGE_FIELDS.cacheWrite]),
  }
}

export function addUsage(left, right) {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

// ── модуль учёта и книга привязок ───────────────────────────────────────────

export async function loadLedgerModule(dshHome) {
  const candidates = [
    path.join(dshHome, LEDGER_MODULE), // как разложил sync.mjs apply
    path.join(REPO_ROOT, LEDGER_MODULE), // рабочая копия до раскладки
  ]
  const found = candidates.find((file) => fs.existsSync(file))
  if (found === undefined) {
    throw new Error(
      'модуль учёта не найден: ' + candidates.join(' или ') + '\n' +
      '  его кладёт `node sync.mjs apply` из ' + path.join(REPO_ROOT, LEDGER_MODULE) + '\n' +
      '  без модуля считать нечем: правило повтора живёт только там')
  }
  // Модуль читает книгу по $DSH_HOME, поэтому каталог установки выставляем до
  // импорта и не восстанавливаем: отчёт — короткий процесс с одним каталогом.
  process.env.DSH_HOME = dshHome
  const module = await import(pathToFileURL(found).href + '?v=' + Date.now())
  for (const name of ['readLedger', 'usageOfEvents']) {
    if (typeof module[name] !== 'function') {
      throw new Error('в модуле учёта нет функции ' + name + ': ' + found)
    }
  }
  // Контракт ведра проверяем сразу, пробным вызовом: иначе переименованное ведро
  // в модуле стало бы нулями в готовом отчёте, а не честной ошибкой на контракте.
  let probe
  try {
    probe = module.usageOfEvents([])
  } catch (error) {
    throw new Error('модуль учёта не отвечает на usageOfEvents([]): ' + error.message + ' · ' + found)
  }
  const missing = Object.values(USAGE_FIELDS).filter((field) => typeof probe[field] !== 'number')
  if (missing.length > 0) {
    throw new Error('в ведре модуля учёта нет контрактных имён: ' + missing.join(', ') + ' · ' + found)
  }
  return { module, file: found }
}

// Книга: append-only массив записей { at, project, issue, role, session, attempt,
// source }. Форму { entries: [...] } тоже принимаем: отчёт не должен падать из-за
// того, что модуль завернул массив в объект.
export function normalizeLedger(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : [])
  const entries = []
  const seen = new Set()
  let duplicates = 0
  let broken = 0
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { broken += 1; continue }
    const issue = Number(entry.issue)
    const project = typeof entry.project === 'string' ? entry.project.trim() : ''
    const session = typeof entry.session === 'string' ? entry.session.trim() : ''
    if (project === '' || !Number.isInteger(issue) || issue <= 0 || session === '') { broken += 1; continue }
    const key = project + '|' + issue + '|' + normalizeSessionId(session)
    if (seen.has(key)) { duplicates += 1; continue }
    seen.add(key)
    entries.push({
      at: typeof entry.at === 'string' ? entry.at : null,
      project,
      issue,
      role: typeof entry.role === 'string' && entry.role !== '' ? entry.role : null,
      session: normalizeSessionId(session),
      attempt: Number(entry.attempt) || null,
      source: typeof entry.source === 'string' ? entry.source : null,
    })
  }
  return { entries, duplicates, broken }
}

// Книга и каталог сессий называют сессию по-разному: с префиксом session- и без.
export function normalizeSessionId(session) {
  return String(session).trim().replace(/^session-/, '')
}

// ── сессии на диске ─────────────────────────────────────────────────────────

export function collectSessions(dshHome, usageOfEvents, workspaceProject) {
  const root = path.join(dshHome, 'sessions')
  const sessions = []
  const problems = []
  if (!fs.existsSync(root)) return { sessions, problems }
  for (const workspace of fs.readdirSync(root)) {
    const base = path.join(root, workspace)
    if (!fs.statSync(base).isDirectory()) continue
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name)
      if (!fs.statSync(dir).isDirectory()) continue
      const id = normalizeSessionId(name)
      const file = path.join(dir, 'session.v3.jsonl.zstd')
      const session = {
        id,
        dir: name,
        workspace,
        project: workspaceProject.get(workspace.toLowerCase()) || null,
        title: null,
        turns: 0,
        usage: zeroUsage(),
        hasTranscript: fs.existsSync(file),
        brokenFrames: 0,
        droppedLines: 0,
      }
      if (!session.hasTranscript) {
        problems.push('нет стенограммы: ' + path.relative(root, dir))
        sessions.push(session)
        continue
      }
      let parsed
      try {
        parsed = readTranscript(file)
      } catch (error) {
        problems.push('стенограмма не читается: ' + path.relative(root, dir) + ' — ' + error.message)
        sessions.push(session)
        continue
      }
      // Сбой разбора — это недосчёт, а не «полные цифры»: такой сессии верим
      // меньше, и в замечаниях отчёта это сказано прямо.
      const where = path.relative(root, dir)
      session.brokenFrames = parsed.brokenFrames
      session.droppedLines = parsed.droppedLines
      if (parsed.brokenFrames > 0) {
        problems.push('кадр стенограммы не разобран целиком: ' + where + ' — кадров: ' + parsed.brokenFrames +
          '; события из них попали в сумму не полностью, числа по сессии меньше настоящих')
      }
      if (parsed.droppedLines > 0) {
        problems.push('строка стенограммы не разобралась: ' + where + ' — строк: ' + parsed.droppedLines +
          '; стенограмма оборвана или повреждена, числа по сессии меньше настоящих')
      }
      const silentEmpty = parsed.brokenFrames === 0 && parsed.droppedLines === 0 &&
        parsed.rows.length === 0 && fs.statSync(file).size > 0
      if (silentEmpty) {
        problems.push('стенограмма не дала ни одного события: ' + where +
          ' — файл повреждён или ещё дописывается, числа по сессии неполные')
      }
      const rows = parsed.rows
      session.title = titleOf(rows)
      session.turns = turnsOf(rows)
      try {
        session.usage = normalizeUsage(usageOfEvents(rows))
      } catch (error) {
        problems.push('модуль учёта не посчитал сессию ' + id + ': ' + error.message)
      }
      sessions.push(session)
    }
  }
  return { sessions, problems }
}

// ── привязка сессия → тикет ─────────────────────────────────────────────────

// Книга может хранить id полностью или его начало: принимаем однозначный префикс
// (не короче 6 символов), неоднозначный — не угадываем.
function resolveSessionId(value, known) {
  const id = normalizeSessionId(value)
  if (known.has(id)) return id
  if (id.length < 6) return null
  const matches = [...known.keys()].filter((candidate) => candidate.startsWith(id))
  return matches.length === 1 ? matches[0] : null
}

export function attribute({ sessions, entries, problems }) {
  const known = new Map(sessions.map((session) => [session.id, session]))
  const attachments = new Map()
  const ledgerOnly = []

  for (const entry of entries) {
    const id = resolveSessionId(entry.session, known)
    if (id === null) {
      // Запись есть, стенограммы нет: числа по ней нулевые, но тикет её видит.
      // Строку строим сразу в той же форме, что и строки найденных сессий: id,
      // hasTranscript и missing — единственное, чем она отличается.
      ledgerOnly.push({
        id: entry.session,
        dir: null,
        workspace: null,
        project: entry.project,
        issue: entry.issue,
        role: entry.role,
        source: 'ledger',
        title: null,
        turns: 0,
        usage: zeroUsage(),
        hasTranscript: false,
        missing: true,
      })
      continue
    }
    const previous = attachments.get(id)
    if (previous !== undefined) {
      if (previous.project !== entry.project || previous.issue !== entry.issue) {
        problems.push('в книге одна сессия привязана к двум тикетам: ' + id + ' — ' +
          previous.project + ' #' + previous.issue + ' и ' + entry.project + ' #' + entry.issue + '; считаем по первой записи')
      }
      continue
    }
    attachments.set(id, { project: entry.project, issue: entry.issue, role: entry.role, source: 'ledger' })
  }

  const tickets = []
  const unbound = []
  for (const session of sessions) {
    let attachment = attachments.get(session.id)
    const byTitle = TITLE_PATTERN.exec(session.title || '')
    if (attachment === undefined) {
      attachment = byTitle === null
        ? { project: session.project, issue: null, role: null, source: 'none' }
        : { project: byTitle[1], issue: Number(byTitle[2]), role: null, source: 'title' }
    } else if (byTitle !== null && (byTitle[1] !== attachment.project || Number(byTitle[2]) !== attachment.issue)) {
      problems.push('книга и заголовок расходятся: сессия ' + session.id + ' — в книге ' +
        attachment.project + ' #' + attachment.issue + ', в заголовке ' + byTitle[1] + ' #' + byTitle[2] + '; считаем по книге')
    }
    const row = {
      ...session,
      project: attachment.project,
      issue: attachment.issue,
      role: attachment.role,
      source: attachment.source,
      title: session.title,
      missing: false,
    }
    if (row.issue === null) unbound.push(row)
    else tickets.push(row)
  }
  for (const row of ledgerOnly) tickets.push(row)
  return { tickets, unbound, ledgerOnly }
}

// Название тикета берём из заголовка сессии: «… [workflow] #14 — Обновление…».
function ticketTitle(row) {
  const match = TITLE_PATTERN.exec(row.title || '')
  if (match === null) return null
  const rest = (row.title || '').slice(match.index + match[0].length).replace(/^\s*[—–-]\s*/, '').trim()
  return rest === '' ? null : rest
}

function totalsOf(rows) {
  let usage = zeroUsage()
  for (const row of rows) usage = addUsage(usage, row.usage)
  return usage
}

// ── отчёт ───────────────────────────────────────────────────────────────────

const usageLine = (usage, withCacheWrite) => {
  const parts = ['вход ' + fmt(usage.input), 'выход ' + fmt(usage.output), 'кэш-чтение ' + fmt(usage.cacheRead)]
  if (withCacheWrite === true || usage.cacheWrite !== 0) parts.push('кэш-запись ' + fmt(usage.cacheWrite))
  return parts.join(' · ')
}

export async function buildReport({ dshHome, project, issue } = {}) {
  const home = dshHome || defaultDshHome()
  if (!fs.existsSync(home)) throw new Error('каталог установки не найден: ' + home + ' (задай --dsh-home)')

  const problems = []
  const ledger = await loadLedgerModule(home)
  const ledgerPath = path.join(home, LEDGER_FILE)

  let rawLedger = []
  try {
    rawLedger = await ledger.module.readLedger()
  } catch (error) {
    // Модуль обещает не затирать нечитаемую книгу, но и падение чтения не повод
    // терять отчёт: показываем стенограммы без привязок.
    problems.push('книга привязок не читается: ' + ledgerPath + ' — ' + error.message)
  }
  const book = normalizeLedger(rawLedger)

  const registry = workspaceIndex(path.join(home, 'projects.json'))
  problems.push(...registry.problems)

  const collected = collectSessions(home, ledger.module.usageOfEvents, registry.index)
  problems.push(...collected.problems)

  const attributed = attribute({ sessions: collected.sessions, entries: book.entries, problems })
  const allTickets = attributed.tickets
  const allUnbound = attributed.unbound

  // Отбор по запросу: проект и номер тикета сужают только таблицы, вне отчёта
  // остаётся ровно то, что видно в строке «вне отчёта».
  const inScope = (row) => project === undefined || row.project === project
  const tickets = allTickets.filter((row) => inScope(row) && (issue === undefined || row.issue === issue))

  const byTicket = new Map()
  for (const row of tickets) {
    const key = row.project + '#' + row.issue
    if (!byTicket.has(key)) byTicket.set(key, { project: row.project, issue: row.issue, rows: [], title: null })
    const group = byTicket.get(key)
    group.rows.push(row)
    if (group.title === null) group.title = ticketTitle(row)
  }

  const groups = [...byTicket.values()]
  for (const group of groups) {
    group.rows.sort((left, right) =>
      String(left.role || '').localeCompare(String(right.role || ''), 'ru') || left.id.localeCompare(right.id))
    group.totals = totalsOf(group.rows)
  }
  groups.sort((left, right) => left.project.localeCompare(right.project) || left.issue - right.issue)

  // «не привязано»: сессии без тикета. Без фильтра по проекту — все, с фильтром —
  // только своего проекта; чужие попадают в строку «вне отчёта».
  const byRow = (left, right) =>
    String(left.project || '\uffff').localeCompare(String(right.project || '\uffff')) ||
    (left.issue === null ? 0 : left.issue) - (right.issue === null ? 0 : right.issue) ||
    left.id.localeCompare(right.id)
  const unboundRows = allUnbound.filter((row) => inScope(row)).sort(byRow)
  const unboundOutside = allUnbound.length - unboundRows.length
  const recovered = tickets.filter((row) => row.source === 'title').sort(byRow)

  // Сверка: каждая стенограмма проекта попала либо в таблицу тикета, либо в
  // «не привязано» — суммы обязаны сойтись. Считаем по всем тикетам проекта, а не
  // по напечатанным: номер тикета сужает только таблицы, иначе при запуске
  // `workflow 14` сессии тикета #15 объявлялись бы потерей раскладки.
  // Право на расхождение остаётся только у записи книги без стенограммы: её нет
  // на диске, поэтому и в счёте диска нет.
  const diskInScope = collected.sessions.filter((session) => project === undefined || session.project === project)
  const attachedInScope = allTickets.filter((row) => inScope(row) && row.missing !== true)
  const accounted = new Set([...attachedInScope, ...unboundRows].map((row) => row.id))
  const lost = diskInScope.filter((session) => !accounted.has(session.id))
  for (const session of lost) problems.push('сессия выпала из отчёта: ' + session.id + ' — ошибка раскладки, а не данных')

  return {
    dshHome: home,
    ledgerModule: ledger.file,
    ledgerPath,
    book: { entries: book.entries.length, duplicates: book.duplicates, broken: book.broken },
    tickets: groups,
    recovered,
    unbound: { rows: unboundRows, totals: totalsOf(unboundRows) },
    ledgerOnly: attributed.ledgerOnly,
    counts: {
      disk: collected.sessions.length,
      diskInScope: diskInScope.length,
      attached: attachedInScope.length,
      unbound: unboundRows.length,
      unboundOutside,
      ledgerOnly: attributed.ledgerOnly.filter((row) => inScope(row)).length,
      outOfTicketScope: allTickets.filter((row) => !(inScope(row) && (issue === undefined || row.issue === issue))).length,
    },
    problems,
  }
}

export function formatReport(report) {
  const lines = []
  lines.push('каталог установки: ' + report.dshHome)
  lines.push('модуль учёта:      ' + report.ledgerModule)
  lines.push('книга привязок:    ' + report.ledgerPath +
    ' · записей: ' + report.book.entries +
    ', повторов отброшено: ' + report.book.duplicates +
    ', битых: ' + report.book.broken)
  lines.push('стенограмм на диске: ' + report.counts.diskInScope +
    (report.counts.disk === report.counts.diskInScope ? '' : ' (всего ' + report.counts.disk + ')'))

  const ticketHeader = ['тикет', 'роль', 'сессия', 'ходов', 'вход', 'выход', 'кэш-чтение']
  const ticketAlign = ['left', 'left', 'left', 'right', 'right', 'right', 'right']
  const rowsOf = (rows) => rows.map((row) => [
    row.project === null || row.project === undefined ? '—' : row.project + '#' + (row.issue === null ? '—' : row.issue),
    row.role === null ? '—' : row.role,
    row.id.slice(0, 8),
    fmt(row.turns),
    fmt(row.usage.input),
    fmt(row.usage.output),
    fmt(row.usage.cacheRead),
  ])

  if (report.tickets.length === 0) {
    lines.push('')
    lines.push('тикетов не найдено')
  }
  for (const group of report.tickets) {
    lines.push('')
    lines.push('=== ' + group.project + ' #' + group.issue + (group.title === null ? '' : ' — ' + group.title) + ' ===')
    lines.push('')
    const tableLines = table(ticketHeader, rowsOf(group.rows), ticketAlign)
    lines.push(...tableLines)
    const width = Math.max(...tableLines.map((line) => line.length))
    lines.push('─'.repeat(width))
    lines.push(group.rows.length + ' ' + plural(group.rows.length, SESSIONS))
    lines.push('итого: ' + usageLine(group.totals))
    const missing = group.rows.filter((row) => row.missing)
    if (missing.length > 0) {
      lines.push('из них ' + missing.length + ' без стенограммы (числа нулевые): ' + missing.map((row) => row.id.slice(0, 8)).join(', '))
    }
  }

  if (report.recovered.length > 0) {
    lines.push('')
    lines.push('=== восстановлено по заголовку ===')
    lines.push('')
    lines.push(...table(
      ['тикет', 'роль', 'сессия', 'ходов', 'вход', 'выход', 'кэш-чтение', 'пометка'],
      report.recovered.map((row) => [
        row.project === null || row.project === undefined ? '—' : row.project + '#' + row.issue,
        '—',
        row.id.slice(0, 8),
        fmt(row.turns),
        fmt(row.usage.input),
        fmt(row.usage.output),
        fmt(row.usage.cacheRead),
        'привязка по заголовку, не из книги',
      ]),
      ticketAlign,
    ))
    lines.push('эти строки уже посчитаны в таблицах тикетов выше — блок показывает, где привязка не из книги')
  }

  lines.push('')
  lines.push('=== не привязано ===')
  if (report.unbound.rows.length === 0) {
    lines.push('таких сессий нет: у каждой есть тикет')
  } else {
    lines.push('')
    lines.push(...table(
      ['проект', 'роль', 'сессия', 'ходов', 'вход', 'выход', 'кэш-чтение', 'причина'],
      report.unbound.rows.map((row) => [
        row.project === null || row.project === undefined ? '—' : row.project,
        row.role === null ? '—' : row.role,
        row.id.slice(0, 8),
        fmt(row.turns),
        fmt(row.usage.input),
        fmt(row.usage.output),
        fmt(row.usage.cacheRead),
        row.hasTranscript ? 'ни в книге, ни в заголовке' : 'нет стенограммы',
      ]),
      ticketAlign,
    ))
    lines.push(report.unbound.rows.length + ' ' + plural(report.unbound.rows.length, SESSIONS))
    lines.push('итого: ' + usageLine(report.unbound.totals))
  }

  lines.push('')
  const sums = report.counts.attached + report.counts.unbound
  lines.push('всего стенограмм: ' + report.counts.diskInScope +
    ' · в тикетах: ' + report.counts.attached +
    ' · не привязано: ' + report.counts.unbound +
    ' · ' + report.counts.attached + '+' + report.counts.unbound + '=' + sums +
    (sums === report.counts.diskInScope ? ' ✓' : ' ✗ (расхождение: ' + (report.counts.diskInScope - sums) + ')'))
  if (report.counts.ledgerOnly > 0) {
    lines.push('только в книге, без стенограммы: ' + report.counts.ledgerOnly +
      ' — записанные в книгу сессии, которых нет в каталоге сессий')
  }
  if (report.counts.unboundOutside > 0 || report.counts.outOfTicketScope > 0) {
    lines.push('вне отчёта: ' + (report.counts.unboundOutside + report.counts.outOfTicketScope) +
      ' — другой проект или другой тикет, сужено фильтром')
  }

  if (report.problems.length > 0) {
    lines.push('')
    lines.push('=== замечания ===')
    for (const problem of report.problems) lines.push('  ! ' + problem)
  }
  return lines.join('\n')
}

// ── запуск ──────────────────────────────────────────────────────────────────

const HELP = [
  'Отчёт по токенам на тикет.',
  '',
  'Запуск: node tools/issue-tokens.mjs [проект] [номер] [--dsh-home <путь>]',
  '',
  '  без аргументов   все проекты, все тикеты',
  '  workflow         один проект',
  '  workflow 14      один тикет',
  '',
  'Каталог установки: $DSH_HOME, иначе ~/.dsh.',
].join('\n')

export async function run(argv = process.argv.slice(2), io = console) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.error(error.message)
    return 2
  }
  if (args.help === true) {
    io.log(HELP)
    return 0
  }
  if (args.extra !== undefined && args.extra.length > 0) {
    io.error('лишние аргументы: ' + args.extra.join(' ') + '\nзапуск: node tools/issue-tokens.mjs [проект] [номер]')
    return 2
  }
  try {
    const report = await buildReport(args)
    io.log(formatReport(report))
    return 0
  } catch (error) {
    io.error(error.message)
    return 2
  }
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = await run()
}
