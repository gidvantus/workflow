// Jev — плагин пресета: мост к System One API TypeSafe AI.
//
// Зачем плагин, а не pwsh + curl: ключ читается здесь и агенту НЕ показывается.
// Инструменты принимают осмысленные аргументы (состояние и типизированные
// вопросы), а не произвольный HTTP-запрос, поэтому даже при ошибочном вызове
// ключу некуда утечь.
//
// Контракт API (https://docs.typesafe.ai/api):
//   POST https://api.typesafe.ai/v1/systemone
//        Authorization: Bearer <API_KEY>
//        { "state": <string|object|array>, "model": "jev-latest",
//          "questions": { "<id>": { "type": "noul|choice|score",
//                                   "instructions": ..., "criteria": ... } } }
//     →  { "model": "jev-1.13.0",
//          "answers": { "<id>": { "type": "noul", "noul": 0.99 } },
//          "usage": { "input_tokens": 360, "output_tokens": 39 } }
//   GET  https://api.typesafe.ai/v1/models — список моделей; заодно проверка ключа.
//        →  { "models": [ { "name": "jev-latest", "description": …, "release_date": … } ] }
//
// Ответы по типам вопроса:
//   noul   → { type, noul }                       — вероятность «да», 0..1
//   choice → { type, choice, confidence, probabilities }
//   score  → { type, score, confidence, legend, probabilities }
//
// Ключ: сначала переменная окружения TYPESAFE_API_KEY, затем файл
// ~/.dsh/typesafe.token (учитывается DSH_HOME). Ключ берётся со страницы
// https://console.typesafe.ai/keys

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const API_HOST = 'api.typesafe.ai'
const EVAL_PATH = '/v1/systemone'
const MODELS_PATH = '/v1/models'
const DEFAULT_MODEL = 'jev-latest'
const QUESTION_TYPES = ['noul', 'choice', 'score']
// 64k токенов на запрос: 32k на state плюс самый длинный вопрос. Символьный
// предел — грубая защита от случайной отправки целого репозитория, а не
// точный счётчик токенов.
const MAX_STATE_CHARS = 180000
const MAX_QUESTIONS = 64
const TIMEOUT_MS = 60000
const MAX_RETRIES = 4

// ── Ключ ────────────────────────────────────────────────────────────────────

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function keyFile() {
  return path.join(dshHomeDir(), 'typesafe.token')
}

// Ключ не логируется и не возвращается ни в одном ответе инструмента.
function readKey() {
  const fromEnv = typeof process.env.TYPESAFE_API_KEY === 'string' ? process.env.TYPESAFE_API_KEY.trim() : ''
  if (fromEnv) return fromEnv
  const file = keyFile()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      'нет ключа TypeSafe: положи ключ из https://console.typesafe.ai/keys в файл ' + file +
      ' (одной строкой) или задай переменную окружения TYPESAFE_API_KEY',
    )
  }
  // BOM пишут редакторы Windows и PowerShell: невидимый символ сделал бы
  // заголовок Authorization невалидным.
  const key = String(raw).replace(/^\uFEFF/, '').trim()
  if (!key) throw new Error('файл ключа пуст: ' + file)
  return key
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function httpOnce(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    let key
    try {
      key = readKey()
    } catch (error) {
      reject(error)
      return
    }
    const payload = body === undefined ? null : JSON.stringify(body)
    let settled = false
    // Отдельный таймер, а не req.setTimeout: тот следит только за уже
    // подключённым сокетом и не спасает от зависшего DNS.
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('таймаут ' + (TIMEOUT_MS / 1000) + ' с: ' + method + ' ' + apiPath))
    }, TIMEOUT_MS)
    function finish(next, value) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      next(value)
    }
    const req = https.request({
      host: API_HOST,
      path: apiPath,
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'dsh-jev-plugin',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data.length > 0 ? JSON.parse(data) : null } catch (error) { parsed = null }
        finish(resolve, { status: res.statusCode, headers: res.headers, parsed, raw: data })
      })
    })
    req.on('error', (error) => finish(reject, new Error('сеть: ' + error.message)))
    req.end(payload === null ? undefined : payload)
  })
}

function errorText(response) {
  const detail = response.parsed
    ? JSON.stringify(response.parsed).slice(0, 500)
    : (response.raw ? response.raw.slice(0, 500) : 'пустой ответ')
  switch (response.status) {
    case 401:
      return 'TypeSafe 401: ключ отсутствует или неверен. Проверь ~/.dsh/typesafe.token и переменную TYPESAFE_API_KEY. ' + detail
    case 422:
      return 'TypeSafe 422: запрос не прошёл валидацию — обычно дело в форме вопроса. ' + detail
    case 429:
      return 'TypeSafe 429: исчерпан лимит запросов (примерно 80 запросов и 100K токенов в секунду). Повтори позже. ' + detail
    case 529:
      return 'TypeSafe 529: сервис временно перегружен. Повтори позже. ' + detail
    default:
      return 'TypeSafe ' + response.status + ': ' + detail
  }
}

async function callApi(method, apiPath, body) {
  let lastError = new Error('запрос не выполнен')
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response
    try {
      response = await httpOnce(method, apiPath, body)
    } catch (error) {
      lastError = error
      if (attempt < MAX_RETRIES) { await sleep(Math.min(8000, 500 * Math.pow(2, attempt))); continue }
      throw lastError
    }
    if (response.status >= 200 && response.status < 300) return response.parsed
    lastError = new Error(errorText(response))
    const retryable = response.status === 429 || response.status === 529
    if (retryable && attempt < MAX_RETRIES) {
      // Сервер может прислать retry-after; иначе экспоненциальная пауза.
      const after = Number(response.headers && response.headers['retry-after'])
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(8000, 500 * Math.pow(2, attempt))
      await sleep(waitMs)
      continue
    }
    throw lastError
  }
  throw lastError
}

// ── Разбор аргументов ───────────────────────────────────────────────────────

// Инструменты принимают JSON-текст там, где форма заранее не известна
// (структурное состояние, объект instructions, criteria). Здесь он
// разворачивается обратно в структуру; обычный текст остаётся текстом.
function undressJson(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    return value
  }
}

function normalizeState(args) {
  const fileArg = typeof args.stateFile === 'string' ? args.stateFile.trim() : ''
  if (fileArg) {
    let text
    try {
      text = fs.readFileSync(fileArg, 'utf8')
    } catch (error) {
      throw new Error('не читается stateFile ' + fileArg + ': ' + (error && error.message ? error.message : String(error)))
    }
    return guardState(undressJson(text), 'stateFile ' + fileArg)
  }
  if (args.state === undefined || args.state === null || args.state === '') {
    throw new Error('нужен state (текст или JSON-текст) либо stateFile (путь к файлу)')
  }
  return guardState(undressJson(args.state), 'state')
}

function guardState(state, source) {
  let chars
  if (typeof state === 'string') {
    chars = state.length
  } else {
    try {
      chars = JSON.stringify(state).length
    } catch (error) {
      chars = MAX_STATE_CHARS + 1
    }
  }
  if (chars > MAX_STATE_CHARS) {
    throw new Error(
      source + ' слишком велик: ' + chars + ' символов при пределе ' + MAX_STATE_CHARS +
      '. Jev видит 32k токенов состояния на запрос — оставь только то, что нужно для суждения, остальное убери или сожми.',
    )
  }
  return state
}

function normalizeModel(value) {
  const model = typeof value === 'string' ? value.trim() : ''
  return model || DEFAULT_MODEL
}

function normalizeQuestion(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('questions[' + index + ']: вопрос — объект {id, type, instructions, criteria?}')
  }
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) throw new Error('questions[' + index + ']: нужен непустой id — под ним вернётся ответ')
  const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : ''
  if (QUESTION_TYPES.indexOf(type) === -1) {
    throw new Error('вопрос ' + id + ': type должен быть noul, choice или score, а не ' + JSON.stringify(item.type))
  }
  if (item.instructions === undefined || item.instructions === null || item.instructions === '') {
    throw new Error('вопрос ' + id + ': нужен instructions — сам вопрос, а не его id')
  }
  const question = { type, instructions: undressJson(item.instructions) }

  if (type === 'noul') {
    // criteria для noul необязателен: {true, false} — что считать «да» и «нет».
    if (item.criteria !== undefined && item.criteria !== null && item.criteria !== '') {
      const criteria = undressJson(item.criteria)
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw new Error('вопрос ' + id + ': для noul criteria — объект вида {"true":"…","false":"…"}')
      }
      question.criteria = criteria
    }
    return { id, question }
  }

  if (type === 'choice') {
    const criteria = undressJson(item.criteria)
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new Error('вопрос ' + id + ': для choice criteria — объект {вариант: описание}; описание можно поставить null')
    }
    const options = Object.keys(criteria)
    if (options.length < 2) throw new Error('вопрос ' + id + ': у choice нужно минимум два варианта в criteria')
    if (options.length > 255) throw new Error('вопрос ' + id + ': у choice максимум 255 вариантов, а передано ' + options.length)
    question.criteria = criteria
    return { id, question }
  }

  const criteria = undressJson(item.criteria)
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw new Error('вопрос ' + id + ': для score criteria — упорядоченный массив уровней, минимум два')
  }
  if (criteria.length > 10) throw new Error('вопрос ' + id + ': у score максимум 10 уровней, а передано ' + criteria.length)
  question.criteria = criteria
  return { id, question }
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('questions: нужен непустой массив вопросов')
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error('questions: максимум ' + MAX_QUESTIONS + ' вопросов за вызов, а передано ' + raw.length)
  }
  const questions = {}
  raw.forEach((item, index) => {
    const { id, question } = normalizeQuestion(item, index)
    if (Object.prototype.hasOwnProperty.call(questions, id)) {
      throw new Error('questions: id повторяется — ' + id + '. Ответы приходят по id, повторы различить нельзя')
    }
    questions[id] = question
  })
  return questions
}

// ── Вызовы ──────────────────────────────────────────────────────────────────

async function evaluate(state, questions, model) {
  const response = await callApi('POST', EVAL_PATH, { state, model, questions })
  return {
    model: (response && response.model) || model,
    answers: (response && response.answers) || {},
    usage: (response && response.usage) || null,
  }
}

// ── Плагин ──────────────────────────────────────────────────────────────────

export default {
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (!tools) throw new Error('jev: сервис tools недоступен, инструменты не зарегистрированы')

    function define(name, description, parameters, run) {
      return {
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args) {
          return JSON.stringify(await run(args || {}), null, 2)
        },
      }
    }

    const stateProps = {
      state: {
        type: 'string',
        description: 'Состояние для оценки. Обычный текст либо JSON-текст (начни с { или [ — тогда он уедет структурой).',
      },
      stateFile: {
        type: 'string',
        description: 'Путь к файлу, содержимое которого станет состоянием. Указывается вместо state — не дублируй его.',
      },
    }
    const modelProp = {
      type: 'string',
      description: 'Модель System One. По умолчанию jev-latest (сейчас указывает на jev-1.13.0).',
    }

    const decideTool = define(
      'jev_decide',
      'Задать Jev сразу несколько типизированных вопросов об одном состоянии. Все вопросы уходят одним запросом и считаются параллельно: добавлять вопросы почти не дороже, поэтому спрашивай всё нужное сразу. ' +
      'Вернёт ответы по id: noul — вероятность «да», choice — выбранный вариант, распределение и confidence, score — положение на шкале, распределение и confidence.',
      {
        type: 'object',
        properties: {
          ...stateProps,
          questions: {
            type: 'array',
            description: 'Вопросы о состоянии. Каждый: {id, type, instructions, criteria?}.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Идентификатор ответа, латиницей: is_urgent, department. В модель не уходит.' },
                type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul — да/нет; choice — один из вариантов; score — степень по шкале.' },
                instructions: { type: 'string', description: 'Сам вопрос, одним узким суждением. JSON-текст, если рядом с вопросом нужны данные.' },
                criteria: { type: 'string', description: 'noul: {"true":"…","false":"…"} (необязательно). choice: {"вариант":"описание", …} (обязательно, от 2 до 255). score: ["уровень 1","уровень 2", …] (обязательно, от 2 до 10). Передавай JSON-текстом.' },
              },
              required: ['id', 'type', 'instructions'],
              additionalProperties: false,
            },
          },
          model: modelProp,
        },
        required: ['questions'],
        additionalProperties: false,
      },
      async (args) => {
        const state = normalizeState(args)
        const questions = normalizeQuestions(args.questions)
        return evaluate(state, questions, normalizeModel(args.model))
      },
    )

    const askTool = define(
      'jev_ask',
      'Задать Jev один вопрос. Сокращение для jev_decide с одним вопросом: тот же контракт, ответ — одно суждение. Если вопросов больше одного, зови jev_decide: это один запрос вместо нескольких.',
      {
        type: 'object',
        properties: {
          ...stateProps,
          type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'Тип вопроса: noul, choice или score.' },
          instructions: { type: 'string', description: 'Сам вопрос одним узким суждением. JSON-текст, если рядом с вопросом нужны данные.' },
          criteria: { type: 'string', description: 'noul: {"true":"…","false":"…"}. choice: {"вариант":"описание", …}. score: ["уровень 1","уровень 2", …]. Передавай JSON-текстом.' },
          id: { type: 'string', description: 'Идентификатор ответа, по умолчанию answer.' },
          model: modelProp,
        },
        required: ['type', 'instructions'],
        additionalProperties: false,
      },
      async (args) => {
        const state = normalizeState(args)
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : 'answer'
        const questions = normalizeQuestions([{
          id,
          type: args.type,
          instructions: args.instructions,
          criteria: args.criteria,
        }])
        const result = await evaluate(state, questions, normalizeModel(args.model))
        return {
          model: result.model,
          id,
          answer: result.answers[id] === undefined ? null : result.answers[id],
          usage: result.usage,
        }
      },
    )

    const modelsTool = define(
      'jev_models',
      'Список моделей, доступных аккаунту, и заодно проверка ключа: 401 здесь значит, что ключ неверен или не положен. Ничего не оценивает и токенов не тратит.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const response = await callApi('GET', MODELS_PATH)
        // Живой ответ сервиса кладёт список в `models`; ветки на массив и на
        // `data` оставлены, чтобы не сломаться, если форма ответа изменится.
        const rows = Array.isArray(response)
          ? response
          : (response && Array.isArray(response.models)
            ? response.models
            : (response && Array.isArray(response.data) ? response.data : null))
        return {
          models: rows,
          raw: rows ? undefined : response,
          defaultModel: DEFAULT_MODEL,
        }
      },
    )

    ctx.effect(() => tools.register(decideTool), 'jev:jev_decide')
    ctx.effect(() => tools.register(askTool), 'jev:jev_ask')
    ctx.effect(() => tools.register(modelsTool), 'jev:jev_models')
  },
}
