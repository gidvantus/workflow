// Отправка закрытой смены в веб и очередь недоотправленного (issue #57).
//
// Первая половина журнала расхода уже жила в harness: книга привязок
// (`usage-ledger.mjs`) знает, какая сессия к какому тикету относится, а `usageCard`
// считает по каждой сессии ходы и токены. Цена тоже считается здесь —
// `costOf(totals, rates)`: веб её не пересчитывает, а только складывает и хранит
// вместе с тарифами. Поэтому смена уезжает в веб **снимком**: тарифы, сессии и итог
// в одном теле, и смена тарифа не переписывает прошлые смены.
//
// ПОЧЕМУ ОЧЕРЕДЬ. Смена закрывается по часам, в том числе когда веба нет: стенд не
// поднят, сеть лежит, токен ещё не прописан. Терять посчитанный расход из-за этого
// нельзя — он больше нигде не хранится, отправленная смена заново не приходит.
// Неудачная отправка ложится в `dev-department-usage-queue.json` и уезжает следующим
// тиком; файл живёт рядом с остальным состоянием отдела (`state-paths.mjs`).
//
// ПРАВИЛА ОЧЕРЕДИ (контракт #57):
//   • `2xx` — отправлено, запись из очереди уходит. Это же правило для `200` с
//     `changed: false`: повтор смены значит «смена уже в журнале», а не «не дошла»;
//   • `4xx`, кроме `401`, `408` и `429`, — отказ по существу (тело не прошло
//     проверку формы). Повторять его бессмысленно: запись выбрасывается и считается
//     в `dropped`;
//   • `401` (токен), `408`, `429` и сетевые сбои — временные: запись остаётся;
//   • три неудачных попытки — запись выбрасывается: очередь не превращается в
//     кладбище вечно повторяемых смен;
//   • не больше `QUEUE_LIMIT` записей, вытесняются самые старые.
//
// Сеть здесь своя, на `node:http`/`node:https`: `fetch` в плагине уже не используется,
// и один стиль запросов проще, чем два. Для тестов отправка подменяется параметром
// `request` — так очередь проверяется без сети.

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { STATE_FILES, readStateFile, stateFile } from './state-paths.mjs'

/** Потолок очереди: старое вытесняется, чтобы файл не рос бесконечно. */
export const QUEUE_LIMIT = 200

/** Сколько раз пробуем отправить одну смену, прежде чем выбросить её из очереди. */
export const MAX_ATTEMPTS = 3

/** Таймаут одного запроса: журнал не должен задерживать закрытие смены. */
export const REQUEST_TIMEOUT_MS = 15000

/** Префикс строки сводки о журнале — один на все исходы. */
export const REPORT_PREFIX = 'Журнал расхода: '

/** Сколько знаков после точки у денег в контракте веба. */
const MONEY_PLACES = 6

function messageOf(error) {
  if (error && error.message) return error.message
  return String(error)
}

/** Деньги в форме контракта: шесть знаков после точки, без отрицательных нулей. */
export function roundMoney(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 10 ** MONEY_PLACES) / 10 ** MONEY_PLACES
}

/**
 * Адрес приёма смен из адреса ручки реестра.
 *
 * `registry.apiUrl` — это полный адрес (`http://localhost:8096/api/registry`), поэтому
 * из него выбрасывается всё, что начинается с `/api`: ручка журнала живёт на том же
 * хосте, а подкаталог стенда и хвостовой слэш должны сохраниться. Простой склейкой
 * строк нельзя: прямой вызов с `registry.apiUrl` дал бы `/api/api/usage/shifts`.
 */
export function shiftReportUrl(apiUrl) {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : ''
  if (raw === '') return ''
  let parsed = null
  try {
    parsed = new URL(raw)
  } catch (error) {
    // Не разобран — значит и ручки журнала из него не вывести: пустая строка
    // отправляет смену в очередь, а не в никуда.
    return ''
  }
  const cut = parsed.pathname.indexOf('/api')
  const base = (cut >= 0 ? parsed.pathname.slice(0, cut) : parsed.pathname).replace(/\/+$/, '')
  return parsed.origin + base + '/api/usage/shifts'
}

/**
 * Тело `POST /api/usage/shifts` из карточек смены.
 *
 * `cards` — по одной на тикет смены: `{issue, title, sessions}`. Сессия уже содержит
 * всё, что нужно строке журнала; цена считается той же `costOf(totals, rates)`, что
 * печатает сводку, — второй формулы в отделе нет.
 *
 * Сумма сессий округляется так же, как каждая сессия: веб сверяет итог с
 * детализацией с допуском в последний знак, и расхождение из-за округления дало бы
 * отказ «Расход по сессиям не сходится с итогом».
 */
export function buildShiftReport(options) {
  const opts = options || {}
  const project = opts.project || {}
  const rates = opts.rates || null
  const costOf = typeof opts.costOf === 'function' ? opts.costOf : null
  const endedAt = opts.endedAt ? new Date(opts.endedAt) : new Date()
  // Начало смены — время её старта. Смена, закрытая без запуска (работа была, а
  // `run` не заведён), получает тот же момент: интервал нулевой длины правдивее
  // выдуманного.
  const startedAt = opts.startedAt ? new Date(opts.startedAt) : endedAt

  const sessions = []
  for (const card of opts.cards || []) {
    for (const row of (card && card.sessions) || []) {
      const tokens = {
        in: row.in || 0,
        out: row.out || 0,
        cacheRead: row.cacheRead || 0,
        cacheWrite: row.cacheWrite || 0,
      }
      const price = costOf === null ? null : costOf(tokens, rates)
      sessions.push({
        issue_number: Number.isInteger(card.issue) ? card.issue : null,
        issue_title: typeof card.title === 'string' && card.title !== '' ? card.title : null,
        role: row.role || 'роль',
        session: row.session,
        source: row.source || null,
        turns: row.turns || 0,
        tokens,
        cost_usd: roundMoney(price === null ? 0 : price),
      })
    }
  }
  const total = sessions.reduce((sum, row) => sum + row.cost_usd, 0)

  return {
    project_ref: project.id,
    project_title: project.title || project.id,
    shift_key: opts.shiftKey,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    reason: opts.reason,
    rates,
    sessions,
    totals: { cost_usd: roundMoney(total) },
  }
}

/** Путь очереди: тот же каталог состояния отдела, что у книги учёта и журнала смен. */
export function queueFile() {
  return stateFile(STATE_FILES.usageQueue)
}

/**
 * Прочитать очередь. Нечитаемый файл — пустая очередь, а не падение отдела: журнал
 * расхода не должен останавливать смену, даже если файл испорчен руками.
 */
export function readQueue() {
  let raw
  try {
    raw = fs.readFileSync(readStateFile(STATE_FILES.usageQueue), 'utf8')
  } catch (error) {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry) => entry && typeof entry === 'object' && entry.report && typeof entry.report === 'object')
    .map((entry) => ({
      report: entry.report,
      attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
      lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
      at: typeof entry.at === 'string' ? entry.at : null,
    }))
}

/**
 * Записать очередь. Ошибку записи возвращаем вызывающему: о ней сказать в сводке.
 *
 * Запись атомарна: соседний временный файл и переименование поверх, как у книги учёта
 * (`usage-ledger.mjs`). Обрезанный на середине файл `readQueue` принимает за пустую
 * очередь, и первый же новый enqueue затирает его вместе с ждавшими сменами — расход
 * исчез бы молча, а человеку было бы сказано «останется в очереди».
 */
export function writeQueue(entries) {
  const file = queueFile()
  const text = JSON.stringify(entries, null, 2)
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text)
  } catch (error) {
    return messageOf(error)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    // На Windows переименование поверх занятого файла иногда отказывает: тогда пишем
    // на месте. Очередь к этому моменту прочитана (иначе записи бы не было), поэтому
    // затереть чужие смены нечем — а ошибку записи всё равно возвращаем вызывающему.
    try {
      fs.writeFileSync(file, text)
    } catch (writeError) {
      try { fs.rmSync(tmp, { force: true }) } catch (cleanup) { /* временный файл уберётся сам */ }
      return messageOf(writeError)
    }
    try { fs.rmSync(tmp, { force: true }) } catch (cleanup) { /* временный файл уберётся сам */ }
  }
  return null
}

/**
 * Положить смену в очередь. Старые записи вытесняются: очередь — это ожидание
 * канала, а не архив.
 */
export function enqueue(report, options) {
  const opts = options || {}
  const entries = readQueue()
  entries.push({
    report,
    attempts: 0,
    lastError: opts.error || null,
    at: new Date().toISOString(),
  })
  let evicted = 0
  while (entries.length > QUEUE_LIMIT) {
    entries.shift()
    evicted += 1
  }
  const error = writeQueue(entries)
  return { queued: entries.length, evicted, error }
}

/** Длина очереди — для строки сводки и статуса. */
export function queueLength() {
  return readQueue().length
}

/**
 * Ответ `2xx` — отправлено; `4xx` по существу — повторять нечего.
 *
 * `409` — исключение: его бэкенд отдаёт в штатной гонке двух одновременных `POST`
 * («Смену не удалось записать: одновременная отправка»). Повтор того же тела пройдёт:
 * сессии из первого запроса уже в базе и просто уйдут в `skipped`. Поэтому `409`
 * временный — выбросить смену из-за него значило бы потерять расход навсегда.
 */
export function isRetryable(status) {
  if (typeof status !== 'number') return false
  if (status >= 200 && status < 300) return false
  if (status === 401 || status === 408 || status === 409 || status === 429) return true
  if (status >= 400 && status < 500) return false
  return true
}

/** Текст отказа из ответа: `detail` контракта, иначе код. */
function failureOf(response) {
  if (typeof response.body === 'string' && response.body !== '') {
    try {
      const parsed = JSON.parse(response.body)
      if (parsed && typeof parsed.detail === 'string' && parsed.detail !== '') return parsed.detail
    } catch (error) {
      // Не JSON — ниже назовём код: тело ответа в строку сводки не влезет.
    }
  }
  return 'ответил кодом ' + response.status
}

/**
 * Отправить одно тело на один адрес. Подменяемая часть — `request`: тесты передают
 * свою функцию и проверяют очередь без сети.
 */
export async function sendReport(report, options) {
  const opts = options || {}
  const url = opts.url
  const request = typeof opts.request === 'function' ? opts.request : postJson
  let response
  try {
    response = await request(url, opts.token || null, report)
  } catch (error) {
    return { ok: false, status: null, error: messageOf(error), retryable: true }
  }
  const status = response && typeof response.status === 'number' ? response.status : 0
  if (status >= 200 && status < 300) {
    let changed = null
    let accepted = null
    let skipped = null
    try {
      const parsed = JSON.parse(response.body || '{}')
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.changed === 'boolean') changed = parsed.changed
        if (Number.isInteger(parsed.accepted)) accepted = parsed.accepted
        if (Number.isInteger(parsed.skipped)) skipped = parsed.skipped
      }
    } catch (error) {
      // `201` с неразобранным телом — всё равно принято: код ответа главнее тела.
    }
    return { ok: true, status, error: null, retryable: false, changed, accepted, skipped }
  }
  return {
    ok: false,
    status,
    error: failureOf(response || {}),
    retryable: isRetryable(status),
  }
}

/**
 * Отправить смену и, если канал не взял, положить её в очередь.
 *
 * Возвращает строку сводки для человека: она попадает и в журнал смены, и в Telegram,
 * поэтому называет исход и, при отказе, что смена не потеряна.
 */
export async function deliverShift(report, options) {
  const result = await sendReport(report, options)
  const count = Array.isArray(report && report.sessions) ? report.sessions.length : 0
  // Ключ смены называем всегда: по нему человек в сводке видит, какая именно смена
  // уехала, а какая осталась, — без него две смены одного дня неразличимы.
  const key = report && report.shift_key ? 'смена ' + report.shift_key + ' ' : 'смена '
  if (result.ok) {
    const accepted = result.accepted === null ? count : result.accepted
    const skipped = result.skipped === null ? 0 : result.skipped
    const head = result.changed === false ? 'уже была в журнале' : 'сохранена в вебе'
    return {
      ok: true,
      queued: queueLength(),
      error: null,
      line: REPORT_PREFIX + key + head + ' (принято сессий: ' + accepted + ', пропущено: ' + skipped + ')',
      result,
    }
  }
  // Отказ по существу (`4xx`, кроме временных) в очередь не ложится: тело не
  // пройдёт проверку формы и на второй раз, и очередь стала бы кладбищем смен.
  if (!result.retryable) {
    return {
      ok: false,
      queued: queueLength(),
      error: result.error,
      line: REPORT_PREFIX + key + 'не принята — ' + result.error,
      result,
    }
  }
  const queued = enqueue(report, { error: result.error })
  if (queued.error) {
    // Смена не уехала и в очередь не легла: файл недоступен (нет прав, занят, кончилось
    // место). Обещать человеку «останется в очереди» в этом случае — соврать: смена
    // посчитана и больше нигде не хранится. Поэтому исход называем как есть, а строку
    // и `error` отдаём вызывающему — он покажет её и в сводке, и в `usageSync.error`.
    const lost = result.error + '; в очередь не записана — ' + queued.error
    return {
      ok: false,
      queued: queueLength(),
      error: lost,
      queueError: queued.error,
      line: REPORT_PREFIX + key + 'не отправлена — ' + lost,
      result,
    }
  }
  return {
    ok: false,
    queued: queued.queued,
    error: result.error,
    queueError: null,
    line: REPORT_PREFIX + key + 'не отправлена — ' + result.error + '; останется в очереди',
    result,
  }
}

/**
 * Дослать очередь. Идём по порядку и останавливаемся на первой временной неудаче:
 * если канал лежит, остальные попытки — те же таймауты, только дольше.
 */
export async function flushQueue(options) {
  const opts = options || {}
  const entries = readQueue()
  if (entries.length === 0) return { sent: 0, dropped: 0, left: 0, error: null }
  if (!opts.url) return { sent: 0, dropped: 0, left: entries.length, error: 'адрес журнала не задан' }

  const kept = []
  let sent = 0
  let dropped = 0
  let lastError = null
  let stopped = false
  for (const entry of entries) {
    if (stopped) {
      kept.push(entry)
      continue
    }
    const result = await sendReport(entry.report, opts)
    if (result.ok) {
      sent += 1
      continue
    }
    lastError = result.error
    if (!result.retryable) {
      // Отказ по существу: тело не пройдёт и на второй раз.
      dropped += 1
      continue
    }
    if (entry.attempts + 1 >= MAX_ATTEMPTS) {
      dropped += 1
      continue
    }
    kept.push({ ...entry, attempts: entry.attempts + 1, lastError: result.error })
    stopped = true
  }
  const error = writeQueue(kept)
  return { sent, dropped, left: kept.length, error: error || lastError }
}

/** `POST` JSON на `node:http`/`node:https` — тот же стиль, что у запроса реестра. */
export function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(new Error('адрес журнала не разобран: ' + url))
      return
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
    }
    if (token) headers['X-Registry-Token'] = token
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(target, { method: 'POST', headers }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: text }))
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('таймаут ответа')))
    request.on('error', reject)
    request.end(payload)
  })
}
