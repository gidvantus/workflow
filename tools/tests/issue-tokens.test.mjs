// Проверка отчёта по токенам на тикет: tools/issue-tokens.mjs.
//
// Модуль учёта (profiles/desktop/plugins/usage-ledger.mjs) — вторая половина
// работы по issue #15, поэтому здесь лежит его эталон: каталог установки
// поддельный, книга и стенограммы — в песочнице, боевой ~/.dsh не читается.
// Эталон реализует ровно тот контракт, что описан в issue: readLedger() отдаёт
// записи книги, usageOfEvents(events) суммирует data.usage и сбрасывает слот
// (turn, step) на llm/retry-started. Отчёт проверяется на нём, а сам модуль —
// отдельным набором другой половины.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

const cli = path.join(process.cwd(), '..', 'issue-tokens.mjs')
const home = path.join(process.cwd(), '.issue-tokens-home')
const homeNoModule = path.join(process.cwd(), '.issue-tokens-nomodule-home')

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
const REFERENCE_MODULE = `// Эталон контракта usage-ledger для tools/tests: книга + правило повтора.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function readLedger() {
  const file = path.join(dshHome(), 'dev-department-usage.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return []
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const keyOf = (data) => (data ? data.turn : '') + ':' + (data ? data.step : '')

export function usageOfEvents(events) {
  const slots = new Map()
  for (const event of events) {
    if (!event) continue
    if (event.type === 'llm/retry-started') {
      slots.delete(keyOf(event.data))
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data && event.data.usage
    if (!usage) continue
    slots.set(keyOf(event.data), {
      uncachedInputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheWriteTokens: num(usage.cacheWriteTokens),
    })
  }
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const slot of slots.values()) for (const field of Object.keys(total)) total[field] += slot[field]
  return total
}
`

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

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeNoModule, { recursive: true, force: true })
fs.mkdirSync(path.join(home, 'profiles', 'desktop', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'plugins', 'usage-ledger.mjs'), REFERENCE_MODULE)
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
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
fs.writeFileSync(path.join(home, 'dev-department-usage.json'), JSON.stringify(book, null, 2))

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
fs.mkdirSync(path.join(homeBroken, 'profiles', 'desktop', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(homeBroken, 'profiles', 'desktop', 'plugins', 'usage-ledger.mjs'), REFERENCE_MODULE)
fs.writeFileSync(path.join(homeBroken, 'projects.json'), fs.readFileSync(path.join(home, 'projects.json')))

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

// S10: последний кадр оборван посреди записи — zstd отдаёт из него пустоту и не
// падает, поэтому ноль событий тоже обязан стать замечанием.
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
const index = mod.workspaceIndex(path.join(home, 'projects.json'))
check('реестр: рабочая область и клон человека — один проект',
  [index.index.get('--d-agents-workflow--'), index.index.get('--d-development-videcoding-workflow--')], ['workflow', 'workflow'])
check('реестр: чужой проект подписан своим именем', index.index.get('--d-agents-vahta--'), 'vahta')

// ── книга привязок ──────────────────────────────────────────────────────────

console.log('\n=== книга привязок ===')
const normalized = mod.normalizeLedger(JSON.parse(fs.readFileSync(path.join(home, 'dev-department-usage.json'), 'utf8')))
check('четыре годные записи, повтор схлопнут', [normalized.entries.length, normalized.duplicates], [4, 1])
check('битая запись отброшена и посчитана', normalized.broken, 1)
check('префикс session- убран', normalized.entries[0].session, S1)
check('форма { entries: [...] } тоже принимается', mod.normalizeLedger({ entries: book }).entries.length, 4)

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
check('повтор шага после llm/retry-started не удвоил счёт', row(S1).usage.input, 2600)
check('выход по тому же правилу', row(S1).usage.output, 26)
check('кэш-чтение и кэш-запись раздельно', [row(S1).usage.cacheRead, row(S1).usage.cacheWrite], [200, 50])
check('ходов: три хода, а не шесть сообщений', row(S1).turns, 3)
check('роль код-ревьюера из книги', row(S2).role, 'code-review')
check('сессия без записи в книге взята по заголовку', [row(S3).role, row(S3).source], [null, 'title'])
check('у привязки по заголовку роль не выдумана', row(S3).role, null)
check('запись книги без стенограммы видна в тикете', [row(S7).missing, row(S7).usage.input], [true, 0])
check('чужая сессия в тикет не попала', row(S6), {})
check('итоги тикета сложены из строк', tickets[0].totals, { input: 5000, output: 50, cacheRead: 300, cacheWrite: 50 })

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

// ── сбои разбора стенограммы ────────────────────────────────────────────────

const broken = await mod.buildReport({ dshHome: homeBroken, project: 'workflow', issue: 14 })
const brokenText = mod.formatReport(broken)
const brokenRow = (id) => (broken.tickets.flatMap((ticket) => ticket.rows).find((row) => row.id === id)) || {}
console.log('\n=== повреждённая стенограмма ===')
check('битый кадр посчитан', brokenRow(S9).brokenFrames, 1)
check('неразобранная строка посчитана', brokenRow(S9).droppedLines, 1)
check('целые события битого кадра всё равно посчитаны', brokenRow(S9).usage.input, 100)
check('замечание про кадр есть', broken.problems.filter((p) => p.includes('кадр стенограммы не распаковался')).length, 1)
check('замечание про строку есть', broken.problems.filter((p) => p.includes('строка стенограммы не разобралась')).length, 1)
check('оборванный кадр без событий назван', broken.problems.filter((p) => p.includes(S10) || p.includes('не дала ни одного события')).length, 1)
checkText('замечания доходят до печати', brokenText, '=== замечания ===')
checkText('в печати назван битый кадр', brokenText, 'кадр стенограммы не распаковался')

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
checkText('итоги тикета', text, 'итого: вход 5 000 · выход 50 · кэш-чтение 300')
checkText('кэш-запись отдельной величиной', text, 'кэш-запись 50')
checkText('блок «не привязано»', text, '=== не привязано ===')
checkText('блок «восстановлено по заголовку»', text, '=== восстановлено по заголовку ===')
checkText('пометка привязки по заголовку', text, 'привязка по заголовку, не из книги')
checkText('сверка сошлась', text, '4+1=5 ✓')
checkText('запись без стенограммы названа', text, 'только в книге, без стенограммы: 1')
const emptyText = mod.formatReport(await mod.buildReport({ dshHome: home, project: 'workflow', issue: 99 }))
checkText('пустой тикет — не пустой вывод', emptyText, 'тикетов не найдено')

// ── запуск из командной строки ──────────────────────────────────────────────

// Вывод перенаправляем в файлы, а не в канал: так запуск работает и там, где
// каналы между процессами запрещены.
function runCli(args, budget = 20000) {
  const outFile = path.join(home, 'cli-out.txt')
  const errFile = path.join(home, 'cli-err.txt')
  fs.rmSync(outFile, { force: true })
  fs.rmSync(errFile, { force: true })
  const out = fs.openSync(outFile, 'w')
  const err = fs.openSync(errFile, 'w')
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: ['ignore', out, err], timeout: budget })
  fs.closeSync(out)
  fs.closeSync(err)
  return {
    status: result.status,
    out: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
    err: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
  }
}

console.log('\n=== запуск node tools/issue-tokens.mjs ===')
const live = runCli(['--dsh-home', home, 'workflow', '14'])
check('код возврата 0', live.status, 0)
checkText('числа дошли до печати', live.out, 'итого: вход 5 000 · выход 50 · кэш-чтение 300')
checkText('книга прочитана из --dsh-home', live.out, 'dev-department-usage.json')
const none = runCli(['--dsh-home', home, 'workflow', '99'])
check('тикет без сессий — тоже успех', none.status, 0)
checkText('и об этом сказано', none.out, 'тикетов не найдено')
const usage = runCli(['--help'])
checkText('справка печатается', usage.out, 'node tools/issue-tokens.mjs [проект] [номер]')
const noModule = runCli(['--dsh-home', homeNoModule, 'workflow'])
check('без модуля учёта — код 2', noModule.status, 2)
checkText('и объяснение, чего не хватает', noModule.err, 'модуль учёта не найден')
// Живой запуск на повреждённых стенограммах: сбой виден человеку, а не только тесту.
const liveBroken = runCli(['--dsh-home', homeBroken, 'workflow', '14'])
check('с повреждёнными стенограммами отчёт всё равно печатается', liveBroken.status, 0)
checkText('и говорит о недосчёте', liveBroken.out, 'строка стенограммы не разобралась')

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(homeNoModule, { recursive: true, force: true })
fs.rmSync(homeBroken, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
