// Telegram Bridge — стационарный плагин DSH (профиль desktop).
// Прямой HTTPS к api.telegram.org через node:https (в стационарном плагине
// доступен require/import, в отличие от динамического sandbox).
//
// Возможности:
//  - long polling getUpdates (ретрансляция сообщений в активную сессию агента);
//  - кликабельные проекты/сессии, история по 10, метки непрочитанного 🔔;
//  - последнее сообщение приходит ПОЛНОСТЬЮ (разбиение на 4000 символов);
//  - голосовые/аудио/кружки: getFile → ffmpeg → whisper, распознавание идёт
//    в фоне и НЕ блокирует процесс DSH; текст уходит в активный диалог;
//  - запросы разрешений (approval/request) приходят в бот с кнопками;
//  - создание новой сессии в проекте (agents.create + attach).

import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Боты берутся из конфигурации. У каждого проекта может быть СВОЙ бот —
// поле telegram в ~/.dsh/projects.json; ~/.dsh/telegram.json остаётся общим и
// обслуживает проекты, которые своего бота не завели. Тот же общий файл
// читает диспетчер отдела разработки, чтобы слать сводки.
//
// Секрета в исходнике нет намеренно: токен, зашитый в код, уезжает вместе с
// плагином. Нет настроенного бота — нет моста, и об этом пишется в лог.

function stripBom(text) {
  const value = String(text)
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
}

function readJsonConfig(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    return undefined
  }
}

// Общий бот: ~/.dsh/telegram.json.
function readSharedTelegram() {
  const raw = readJsonConfig(path.join(dshHomeDir(), 'telegram.json'))
  if (!raw || !raw.token || !raw.chatId) return undefined
  return {
    token: String(raw.token),
    chatId: raw.chatId,
    voiceLang: raw.voiceLang ? String(raw.voiceLang) : undefined,
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

// Проекты: id, название, рабочая область и, если задан, свой бот.
function readProjectsRegistry() {
  const raw = readJsonConfig(path.join(dshHomeDir(), 'projects.json'))
  const projects = (raw && raw.projects) || {}
  return Object.keys(projects).map((id) => {
    const row = projects[id] || {}
    const tg = row.telegram && typeof row.telegram === 'object' ? row.telegram : undefined
    const bot = tg && tg.token && tg.chatId
      ? { token: String(tg.token), chatId: tg.chatId, voiceLang: tg.voiceLang ? String(tg.voiceLang) : undefined }
      : undefined
    return {
      id,
      title: typeof row.title === 'string' && row.title ? row.title : id,
      workspace: String(row.workspace || ''),
      humanClone: String(row.humanClone || ''),
      // Корни проекта: рабочая копия отдела и каталог человека. Сессия может
      // стоять в любом из них — оба принадлежат проекту.
      roots: [String(row.workspace || ''), String(row.humanClone || '')].filter(Boolean),
      bot,
    }
  })
}

// Список ботов для опроса: по одному на проект со своим ботом плюс общий —
// для проектов без своего. Токен, указанный у двух проектов, опрашивается
// один раз: владельцем становится первый по порядку реестра.
function buildBots(projects, shared) {
  const bots = []
  const seen = new Set()
  for (const project of projects) {
    if (!project.bot) continue
    if (seen.has(project.bot.token)) continue
    seen.add(project.bot.token)
    bots.push({ key: project.id, projectId: project.id, roots: project.roots, defaultCwd: project.workspace, ...project.bot })
  }
  if (shared && !seen.has(shared.token)) {
    seen.add(shared.token)
    bots.push({ key: 'shared', projectId: null, roots: [], defaultCwd: '', ...shared })
  }
  return bots
}

// Рабочая область по умолчанию, когда у бота нет своего проекта.
function defaultProjectWorkspace() {
  const raw = readJsonConfig(path.join(dshHomeDir(), 'projects.json'))
  const projects = (raw && raw.projects) || {}
  const ids = Object.keys(projects)
  if (ids.length === 0) return ''
  const id = typeof raw.default === 'string' && raw.default && projects[raw.default] ? raw.default : ids[0]
  const workspace = projects[id] && projects[id].workspace
  return typeof workspace === 'string' ? workspace : ''
}

// Инструменты распознавания голосовых живут в пакете процесса — в каталоге
// репозитория workflow, а не в рабочей области продукта. Путь переопределяется
// переменной DSH_VOICE_TOOLS.
const TOOLS = (process.env.DSH_VOICE_TOOLS || 'D:/Development/VideCoding/Workflow/.voice-tools')
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
const FFMPEG = TOOLS + '/ffmpeg/ffmpeg.exe'
const WHISPER = TOOLS + '/whisper/Release/whisper-cli.exe'
const WHISPER_MODEL = TOOLS + '/models/ggml-small.bin'
const VOICE_TMP = TOOLS + '/tmp'
// Расширения, которые считаем аудио/видео и отправляем на распознавание.
const AUDIO_EXT = ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'webm', 'amr', '3gp', 'mp4', 'm4v', 'mov', 'mkv']

// ----- HTTP helper: один постоянный https.Agent с keep-alive -----
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 })

function httpJsonWith(token, method, pathname, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload)
    const req = https.request({
      host: 'api.telegram.org',
      path: '/bot' + token + pathname,
      method,
      agent,
      timeout: timeoutMs,
      headers: body === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad JSON from Telegram: ' + data.slice(0, 120))) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

// Ретраи на каждый вызов Telegram (сеть нестабильна).
async function tgWith(token, method, pathname, payload, timeoutMs) {
  let lastErr
  for (let i = 0; i < 4; i++) {
    try {
      return await httpJsonWith(token, method, pathname, payload, timeoutMs)
    } catch (e) {
      lastErr = e
      if (i < 3) await sleep(600 * (i + 1))
    }
  }
  throw lastErr
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ----- отправка в Telegram -----
async function sendTextWith(token, chatId, text) {
  const chunks = []
  let rest = text
  while (rest.length > 4000) { chunks.push(rest.slice(0, 4000)); rest = rest.slice(4000) }
  if (rest) chunks.push(rest)
  for (const chunk of chunks) await tgWith(token, 'POST', '/sendMessage', { chat_id: chatId, text: chunk })
}

async function sendKeyboardIdWith(token, chatId, text, rows) {
  const res = await tgWith(token, 'POST', '/sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } })
  return res && res.result ? res.result.message_id : undefined
}

async function sendKeyboardWith(token, chatId, text, rows) {
  await sendKeyboardIdWith(token, chatId, text, rows)
}

// Без аргумента rows клавиатура не трогается: нужно для правки служебных
// сообщений («Распознаю…» → «Распознано»), чтобы не приклеивать кнопки.
async function editMessageWith(token, chatId, messageId, text, rows) {
  await tgWith(token, 'POST', '/editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(rows === undefined ? {} : { reply_markup: { inline_keyboard: rows } }),
  })
}

// Отправка с возвратом message_id — чтобы затем отредактировать это же сообщение.
async function sendTextIdWith(token, chatId, text) {
  const res = await tgWith(token, 'POST', '/sendMessage', { chat_id: chatId, text })
  return res && res.result ? res.result.message_id : undefined
}

// Кнопки, которые сопровождают каждый ответ агента: список проектов и
// открытые диалоги текущего проекта — чтобы не искать их вручную.
function replyButtons() {
  return [
    [
      { text: '📂 Проекты', callback_data: 'back:projects' },
      { text: '💬 Диалоги проекта', callback_data: 'curproj' },
    ],
  ]
}

// Отправляет ответ агента сразу в чат; кнопки крепятся к последней части.
async function sendReplyWithButtonsWith(token, chatId, text) {
  const chunks = []
  let rest = String(text)
  while (rest.length > 4000) { chunks.push(rest.slice(0, 4000)); rest = rest.slice(4000) }
  if (rest) chunks.push(rest)
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1
    await tgWith(token, 'POST', '/sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      ...(last ? { reply_markup: { inline_keyboard: replyButtons() } } : {}),
    })
  }
}

async function answerCallbackWith(token, callbackQueryId, text) {
  await tgWith(token, 'POST', '/answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text: String(text).slice(0, 200) } : {}) })
}

function clip(text, max) {
  const s = String(text)
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

export default {
  // Явные зависимости: записи из cordis.patch.yml применяются РАНЬШЕ, чем
  // бандлы поднимают свои сервисы. С одним лишь `timer` (он идёт первым)
  // apply срабатывал в пустом окружении, guard ниже молча выходил — и мост
  // переставал опрашивать Telegram, не оставив в логах ни одной ошибки.
  inject: ['timer', 'agents', 'sessions', 'sessionQuery', 'workspaceRegistry', 'agentPresets', 'agentDefaultModel'],

  apply(ctx) {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    if (!agents) {
      console.error('[tg-bridge] missing service agents')
      return
    }

    const projects = readProjectsRegistry()
    const shared = readSharedTelegram()
    const bots = buildBots(projects, shared)
    if (bots.length === 0) {
      console.error('[tg-bridge] нет ни одного бота: ни telegram у проектов в projects.json, ни ~/.dsh/telegram.json')
      return
    }

    const bridges = bots.map((bot) => buildBridge(ctx, bot))
    const byToken = new Map(bridges.map((bridge) => [bridge.token, bridge]))
    // Общий бот — ТОЛЬКО тот, у которого нет своего проекта. Если токен общего
    // бота принадлежит какому-то проекту, общего бота нет вовсе: иначе события
    // проекта без своего бота молча уходили бы в чужой чат.
    const sharedBridge = bridges.filter((bridge) => bridge.projectId === null)[0]

    const withoutBot = projects.filter((project) => !project.bot)
    if (withoutBot.length > 0) {
      console.warn('[tg-bridge] без своего бота: ' + withoutBot.map((p) => p.id).join(', ') +
        (sharedBridge ? ' — их события уходят общему боту' : ' — их события остаются в GUI, пока в проекте не задан telegram'))
    }

    // Проект сессии ищем по рабочей области: тот же признак, по которому
    // пресеты резолвят проект. Не нашли — событие уходит общему боту, а если
    // его нет, остаётся GUI.
    function projectOfSession(sessionId) {
      try {
        const session = sessions ? sessions.get(sessionId) : undefined
        const cwd = session && session.header ? session.header.cwd : undefined
        if (!cwd) return undefined
        const wanted = normalizePath(cwd)
        let best
        let bestLength = -1
        for (const project of projects) {
          for (const candidate of project.roots || []) {
            const root = normalizePath(candidate)
            if (!root) continue
            if (wanted === root || wanted.indexOf(root + '\\') === 0) {
              if (root.length > bestLength) { best = project; bestLength = root.length }
            }
          }        }
        return best
      } catch (error) {
        return undefined
      }
    }

    function bridgeForSession(sessionId) {
      const project = projectOfSession(sessionId)
      if (project && project.bot) {
        const own = byToken.get(project.bot.token)
        if (own) return own
      }
      return sharedBridge
    }

    // Хуки регистрируются ОДИН раз на процесс: их тела живут в мостах.
    ctx.on('session/event', (session, event) => {
      const bridge = session ? bridgeForSession(session.id) : undefined
      if (bridge) bridge.onSessionEvent(session, event)
    })

    ctx.on('approval/request', (req, next) => {
      const agentId = req && req.agent && req.agent.id ? String(req.agent.id) : ''
      const bridge = agentId ? bridgeForSession(agentId) : sharedBridge
      if (!bridge) return next()
      return bridge.onApproval(req, next)
    }, { prepend: true })

    ctx.on('user-questions/request', (request, next) => {
      const agentId = request && request.agent && request.agent.id ? String(request.agent.id) : ''
      const bridge = agentId ? bridgeForSession(agentId) : sharedBridge
      if (!bridge) return next()
      return bridge.onQuestion(request, next)
    }, { prepend: true })

    // У каждого бота свой опрос: свои offset, активный диалог и счётчики.
    for (const bridge of bridges) {
      bridge.cleanTmp()
      ctx.effect(() => ctx.interval(async () => {
        if (bridge.polling) return
        bridge.polling = true
        try {
          await bridge.tick()
        } catch (error) {
          console.error('[tg-bridge:' + bridge.key + '] tick error:', error && error.message)
        } finally {
          bridge.polling = false
        }
      }, 1000), 'tg-bridge:poll:' + bridge.key)
      console.log('[tg-bridge] бот "' + bridge.key + '" запущен')
    }
  },
}

// Один мост = один бот. Всё состояние (offset, активный диалог, очередь медиа,
// ожидающие разрешения и вопросы) принадлежит этому вызову и не делится с
// другими ботами.
function buildBridge(ctx, bot) {
    const agents = ctx.get('agents')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const sessionQuery = ctx.get('sessionQuery')
    const agentDefaultModel = ctx.get('agentDefaultModel')
    const agentPresets = ctx.get('agentPresets')
    if (!agents || !sessionQuery) {
      console.error('[tg-bridge] missing services agents/sessionQuery')
      return
    }

    // ── этот мост обслуживает ровно одного бота ──────────────────────────
    const TOKEN = bot.token
    const ALLOWED = bot.chatId
    const WHISPER_LANG = bot.voiceLang || 'auto'

    // Тонкие обёртки: весь код ниже зовёт sendText/tg с прежними аргументами,
    // а токен подставляется здесь. Так один и тот же код обслуживает всех ботов.
    const httpJson = (method, pathname, payload, timeoutMs) => httpJsonWith(TOKEN, method, pathname, payload, timeoutMs)
    const tg = (method, pathname, payload, timeoutMs) => tgWith(TOKEN, method, pathname, payload, timeoutMs)
    const sendText = (chatId, text) => sendTextWith(TOKEN, chatId, text)
    const sendKeyboardId = (chatId, text, rows) => sendKeyboardIdWith(TOKEN, chatId, text, rows)
    const sendKeyboard = (chatId, text, rows) => sendKeyboardWith(TOKEN, chatId, text, rows)
    const editMessage = (chatId, messageId, text, rows) => editMessageWith(TOKEN, chatId, messageId, text, rows)
    const sendTextId = (chatId, text) => sendTextIdWith(TOKEN, chatId, text)
    const sendReplyWithButtons = (chatId, text) => sendReplyWithButtonsWith(TOKEN, chatId, text)
    const answerCallback = (callbackQueryId, text) => answerCallbackWith(TOKEN, callbackQueryId, text)

    let offset = 0
    let seq = 0
    let approvalSeq = 0
    let questionSeq = 0
    let target
    let cwd = bot.defaultCwd || defaultProjectWorkspace()
    let lastSessions = []
    let polling = false
    let mediaChain = Promise.resolve()
    let toolsOk
    // Ожидание свободного текстового ответа на вопрос модели: следующее
    // сообщение пользователя уходит в ответ, а не агенту как задача.
    let awaitingText
    const unread = new Map()
    const pendingApprovals = new Map()
    const pendingQuestions = new Map()

    // ----- инструменты (ffmpeg/whisper) -----
    function toolsPresent() {
      return fs.existsSync(FFMPEG) && fs.existsSync(WHISPER) && fs.existsSync(WHISPER_MODEL)
    }

    // Внешние процессы запускаем АСИНХРОННО: spawnSync здесь замораживал бы
    // весь процесс DSH (вместе с GUI) на всё время распознавания.
    function runTool(exe, args, timeoutMs) {
      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) { reject(e); return }
        const out = []
        const err = []
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try { child.kill() } catch (e) { /* ignore */ }
          reject(new Error('превышено время (' + Math.round(timeoutMs / 1000) + ' с)'))
        }, timeoutMs)
        child.stdout.on('data', (c) => out.push(c))
        child.stderr.on('data', (c) => { if (err.length < 60) err.push(c) })
        child.on('error', (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const stderr = Buffer.concat(err).toString('utf8')
          if (code !== 0) {
            reject(new Error('код ' + code + (stderr.trim() ? ': ' + stderr.trim().slice(-200) : '')))
            return
          }
          resolve(Buffer.concat(out).toString('utf8'))
        })
      })
    }

    // -vn: из «кружков» и видео берём только звуковую дорожку.
    function convertToWav(src, wav) {
      return runTool(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 120000)
    }

    async function transcribeWav(wav) {
      const cpus = os.cpus ? os.cpus().length : 4
      const threads = Math.max(2, Math.min(8, cpus - 1))
      const out = await runTool(WHISPER, ['-m', WHISPER_MODEL, '-f', wav, '-l', WHISPER_LANG,
        '-t', String(threads), '-nt', '-np'], 300000)
      return cleanTranscript(out)
    }

    // На тишине и шуме whisper любит дописывать «субтитры» и [BLANK_AUDIO] —
    // такие строки выкидываем, иначе они уходят агенту как слова пользователя.
    const HALLUCINATIONS = [
      'продолжение следует', 'субтитры', 'редактор субтитров', 'подписывайтесь',
      'спасибо за просмотр', 'ставьте лайк', 'thank you for watching', 'thanks for watching',
      'subscribe', 'subtitles', 'amara.org', 'dimatorzok',
    ]

    function cleanTranscript(raw) {
      const keep = []
      for (const line of String(raw).split(/\r?\n/)) {
        const t = line.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim()
        if (!t) continue
        if (/^[\s.,!?…\-–—]+$/.test(t)) continue
        const low = t.toLowerCase()
        if (HALLUCINATIONS.some((h) => low.indexOf(h) >= 0)) continue
        keep.push(t)
      }
      return keep.join(' ').trim()
    }

    function deleteFile(p) {
      try { fs.unlinkSync(p) } catch (e) { /* ignore */ }
    }

    // ffmpeg → wav → whisper → текст. Промежуточный wav удаляем всегда.
    async function transcribeFile(src) {
      if (!toolsPresent()) return { ok: false, error: 'ffmpeg/whisper/модель не найдены по ожидаемым путям' }
      const dot = src.lastIndexOf('.')
      const wav = (dot > src.lastIndexOf('/') ? src.slice(0, dot) : src) + '.wav'
      try {
        await convertToWav(src, wav)
        const text = await transcribeWav(wav)
        if (!text) return { ok: false, error: 'речь не распознана (тишина или сильный шум)' }
        return { ok: true, text }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      } finally {
        deleteFile(wav)
      }
    }

    // Чистим временные файлы старше 6 часов и недоделанные wav.
    function cleanTmpDir() {
      try {
        if (!fs.existsSync(VOICE_TMP)) return
        const now = Date.now()
        for (const f of fs.readdirSync(VOICE_TMP)) {
          const p = VOICE_TMP + '/' + f
          try {
            const st = fs.statSync(p)
            if (!st.isFile()) continue
            if (now - st.mtimeMs > 6 * 3600 * 1000) { fs.unlinkSync(p); continue }
            if (/\.wav$/i.test(f)) fs.unlinkSync(p)
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }

    // ----- загрузка файла через getFile -----
    async function downloadTelegramFile(fileId, destPath) {
      const g = await tg('GET', '/getFile?file_id=' + encodeURIComponent(fileId))
      if (!g.ok || !g.result || !g.result.file_path) return { ok: false, error: 'getFile failed: ' + (g.description || '?') }
      const url = '/file/bot' + TOKEN + '/' + g.result.file_path
      const dest = destPath.replace(/\\/g, '/')
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const buf = await new Promise((resolve, reject) => {
          const req = https.get({ host: 'api.telegram.org', path: url, agent, timeout: 60000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return }
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve(Buffer.concat(chunks)))
          })
          req.on('timeout', () => req.destroy(new Error('timeout')))
          req.on('error', reject)
        })
        fs.writeFileSync(dest, buf)
        return { ok: true, path: destPath, size: buf.length }
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) }
      }
    }

    // ----- голосовые/аудио/файлы -----

    // Что именно прислали и надо ли это распознавать.
    function mediaKind(msg) {
      const doc = msg.document
      if (msg.voice) return { media: msg.voice, ext: 'ogg', label: '🎤 Голосовое', audio: true }
      if (msg.video_note) return { media: msg.video_note, ext: 'mp4', label: '⭕️ Кружок', audio: true }
      if (msg.audio) return { media: msg.audio, ext: 'mp3', label: '🎵 Аудио', audio: true }
      if (msg.video) return { media: msg.video, ext: 'mp4', label: '🎬 Видео', audio: true }
      if (doc && doc.file_id) {
        const name = String(doc.file_name || 'file')
        const ext = (name.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || 'bin'
        const isAudio = AUDIO_EXT.indexOf(ext.toLowerCase()) >= 0
        return { media: doc, ext, label: isAudio ? '🎧 Аудиофайл' : '📄 Файл', audio: isAudio }
      }
      return undefined
    }

    // Отправка сообщения пользователя в активный диалог.
    function followup(agent, text, updateId) {
      seq += 1
      agent.followup({
        id: 'tg-' + Date.now() + '-' + seq,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: 'tg-' + updateId },
      })
    }

    // Правка служебного сообщения (прогресс → результат).
    async function setStatus(messageId, text) {
      const body = text.length <= 3900 ? text : text.slice(0, 3890) + '…'
      if (messageId === undefined) { await sendText(ALLOWED, body); return }
      try { await editMessage(ALLOWED, messageId, body) } catch (e) { await sendText(ALLOWED, body) }
    }

    // Текстовый (в т.ч. распознанный из голоса) ответ на вопрос модели.
    async function deliverTextAnswer(text) {
      const at = awaitingText
      awaitingText = undefined
      const st = pendingQuestions.get(at.key)
      if (!st) return
      const item = st.items[at.qi]
      st.answers.push({ id: item.id, selected: [], custom: text })
      await sendText(ALLOWED, '✅ Ответ принят.')
      st.index = at.qi + 1
      st.multi = new Set()
      await askNext(at.key)
    }

    // Медиа обрабатываем по одному в фоне: распознавание длится секунды и
    // не должно задерживать опрос getUpdates и остальные сообщения.
    function enqueueMedia(task) {
      mediaChain = mediaChain
        .then(() => task())
        .catch((e) => console.error('[tg-bridge] media task failed:', (e && e.message) || e))
    }

    async function handleMedia(msg, u) {
      const info = mediaKind(msg)
      if (!info) return false
      const media = info.media
      if (media.file_size && media.file_size > 25 * 1024 * 1024) {
        await sendText(ALLOWED, '⚠️ ' + info.label + ' слишком большой (' + Math.round(media.file_size / 1048576) + ' МБ) — не качаю.')
        return true
      }
      const safeExt = String(info.ext).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin'
      const base = VOICE_TMP + '/tg-' + Date.now() + '-' + (++seq)
      const src = base + '.' + safeExt
      const dur = media.duration ? ' (' + Math.round(media.duration) + ' с)' : ''
      const dl = await downloadTelegramFile(String(media.file_id), src)
      if (!dl.ok) {
        await sendText(ALLOWED, '❌ Не удалось скачать ' + info.label + ': ' + clip(dl.error || 'ошибка', 200))
        return true
      }
      const size = dl.size ? ' (' + Math.round(dl.size / 1024) + ' КБ)' : ''
      // Не аудио — просто отдаём агенту путь к файлу.
      if (!info.audio) {
        await sendText(ALLOWED, '📄 Файл принят' + size + ': ' + src)
        const agent = await resolveTarget()
        if (agent) {
          followup(agent, info.label + ' из Telegram сохранён в файл:\n' + src + size +
            '\n\nПрочитай содержимое этого файла и ответь.', u.update_id)
        } else {
          await sendText(ALLOWED, '⚠️ Нет активной сессии. Создайте её кнопкой «📂 Проекты». Файл: ' + src)
        }
        return true
      }
      const statusId = await sendTextId(ALLOWED, '⏳ ' + info.label + dur + size + '\nРаспознаю речь…')
      const r = await transcribeFile(src)
      if (!r.ok) {
        // Не вышло распознать — отдаём агенту сам файл, он разберётся.
        await setStatus(statusId, '⚠️ ' + info.label + dur + size + '\nРаспознать не удалось: ' + clip(r.error, 200) +
          '\nФайл сохранён: ' + src)
        const agent = await resolveTarget()
        if (agent) {
          followup(agent, info.label + ' из Telegram сохранено в файл:\n' + src + dur + size +
            '\n\nАвтоматическое распознавание не удалось (' + clip(r.error, 200) +
            '). Разберись с файлом сам и ответь по содержимому.', u.update_id)
        }
        return true
      }
      deleteFile(src)
      const quote = '🎤 Распознано' + dur + ':\n\n«' + r.text + '»'
      if (quote.length <= 3500) {
        await setStatus(statusId, quote)
      } else {
        await setStatus(statusId, '🎤 Распознано' + dur + ' (' + r.text.length + ' симв., текст ниже)')
        await sendText(ALLOWED, r.text)
      }
      // Голосом можно и отвечать на вопрос модели.
      if (awaitingText) { await deliverTextAnswer(r.text); return true }
      const agent = await resolveTarget()
      if (!agent) {
        await sendText(ALLOWED, '⚠️ Нет активной сессии. Создайте её кнопкой «📂 Проекты».')
        return true
      }
      followup(agent, r.text, u.update_id)
      return true
    }

    // ----- сессии и история -----
    // Мост обслуживает СВОЙ проект, поэтому и активный диалог выбирается
    // среди своих сессий. Без этого сообщение, отправленное боту CloudPass,
    // ушло бы в первую попавшуюся сессию процесса — например в вахту.
    function belongsToBot(agent) {
      if (!bot.projectId) return true
      const session = agent && agent.session
      const cwd = session && session.header ? session.header.cwd : undefined
      if (!cwd) return false
      const wanted = normalizePath(cwd)
      return (bot.roots || []).some((candidate) => {
        const root = normalizePath(candidate)
        return root !== '' && (wanted === root || wanted.indexOf(root + '\\') === 0)
      })
    }

    async function resolveTarget() {
      if (target && belongsToBot(target)) return target
      target = undefined
      const initiator = agents.currentInitiator && agents.currentInitiator()
      if (initiator && belongsToBot(initiator)) { target = initiator; return target }
      const roots = (agents.roots && agents.roots()) || []
      const own = roots.filter(belongsToBot)
      if (own.length > 0) { target = own[0]; return target }
      const all = agents.list() || []
      const mine = all.filter(belongsToBot)
      if (mine.length > 0) { target = mine[0]; return target }
      return undefined
    }

    async function initTarget() {
      const agent = await resolveTarget()
      if (agent && agent.session && agent.session.header && agent.session.header.cwd) cwd = agent.session.header.cwd
      return agent
    }

    async function sessionTitleOf(sessionId) {
      try {
        const obs = await sessionQuery.readTitleSnapshots([sessionId])
        const first = obs && obs[0]
        if (first && first.status === 'fulfilled' && first.value && first.value.title) return first.value.title.title
      } catch (e) { /* ignore */ }
      return undefined
    }

    async function historyMessages(sessionId) {
      const liveAgent = agents.get(sessionId)
      if (liveAgent && liveAgent.session && typeof liveAgent.session.deriveMessages === 'function') {
        try {
          const messages = []
          for (const m of liveAgent.session.deriveMessages()) {
            const text = textOf(m && m.content)
            if (text.trim()) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: text.trim() })
          }
          if (messages.length > 0) return messages
        } catch (e) { /* fall through */ }
      }
      try {
        const surface = await sessionQuery.readSurface(sessionId)
        const messages = []
        for (const ev of (surface.events || [])) {
          if (ev.type === 'user/message') {
            const text = textOf(ev.data && ev.data.content)
            if (text.trim()) messages.push({ role: 'user', text: text.trim() })
          } else if (ev.type === 'assistant/message') {
            const msg = ev.data && ev.data.message
            const text = textOf(msg && msg.content)
            if (text.trim()) messages.push({ role: 'assistant', text: text.trim() })
          }
        }
        return messages
      } catch (e) { return [] }
    }

    async function historyText(sessionId, count) {
      const messages = await historyMessages(sessionId)
      const total = messages.length
      const shown = Math.max(1, Math.min(Math.floor(count) || 1, total))
      const slice = messages.slice(total - shown)
      const title = await sessionTitleOf(sessionId)
      const head = '📜 История' + (title ? ' — ' + clip(title, 60) : '') + '\nпоказано ' + shown + ' из ' + total + ':\n\n'
      const lines = []
      let used = head.length
      for (let i = slice.length - 1; i >= 0; i--) {
        const m = slice[i]
        const line = (m.role === 'user' ? '👤 ' : '🤖 ') + clip(m.text.replace(/\n+/g, ' '), 1200)
        if (used + line.length + 2 > 3900) break
        lines.unshift(line)
        used += line.length + 2
      }
      return { text: head + lines.join('\n\n'), total, shown }
    }

    async function buildActivation(sid) {
      const title = await sessionTitleOf(sid)
      let text = '✅ Текущая сессия: ' + sid + (title ? '\n📌 ' + title : '')
      let fullLast = ''
      try {
        const history = await historyMessages(sid)
        if (history.length > 0) {
          const last = history[history.length - 1]
          const clean = last.text.trim()
          const who = last.role === 'user' ? '👤 ' : '🤖 '
          fullLast = who + clean
          text += '\n\n📄 Последнее сообщение:\n' + who + clip(clean.replace(/\n+/g, ' '), 200)
          if (clean.length > 200) text += '\n(полный текст — отдельным сообщением)'
        } else {
          text += '\n\n📄 (в сессии пока нет сообщений)'
        }
      } catch (e) {
        text += '\n\n📄 (не удалось загрузить последнее сообщение)'
      }
      const rows = [
        [{ text: '🔄 Обновить', callback_data: 'refresh:' + sid }, { text: '📜 История', callback_data: 'hist:' + sid + ':10' }],
        [{ text: '📂 Проекты', callback_data: 'back:projects' }, { text: '💬 Диалоги проекта', callback_data: 'curproj' }],
      ]
      return { text, rows, fullLast }
    }

    async function presentActivation(chatId, messageId, view) {
      if (view.fullLast) await sendText(chatId, view.fullLast)
      if (messageId !== undefined) await editMessage(chatId, messageId, view.text, view.rows)
      else await sendKeyboard(chatId, view.text, view.rows)
    }

    // ----- проекты и сессии -----
    function sortSessions(ids) {
      const live = []
      const closed = []
      for (const id of ids) {
        if (agents.get(id) !== undefined) live.push(id)
        else closed.push(id)
      }
      return { sorted: [...live, ...closed], liveCount: live.length }
    }

    function unreadOf(id) { return unread.get(id) || 0 }
    function projectUnread(ids) { let t = 0; for (const id of ids) t += unreadOf(id); return t }

    async function projectsPayload() {
      const ws = workspaceRegistry ? workspaceRegistry.list() : []
      if (!ws || ws.length === 0) return { text: '📂 Проектов пока нет.', rows: [] }
      const rows = []
      let anyUnread = false
      for (const w of ws) {
        const ids = (w.sessionIds || []).slice(0, 30)
        let liveCount = 0
        for (const id of ids) if (agents.get(id) !== undefined) liveCount += 1
        const u = projectUnread(ids)
        if (u > 0) anyUnread = true
        const label = clip(w.title || w.path, 36)
        rows.push([{ text: '📁 ' + label + (ids.length > 0 ? ' (' + liveCount + '/' + ids.length + ')' : '') + (u > 0 ? ' 🔔' + u : ''), callback_data: 'proj:' + w.id }])
      }
      return { text: '📂 Проекты (' + ws.length + '):\nНажмите на проект, чтобы открыть его сессии.\n🟢 открытые / 🔒 закрытые' + (anyUnread ? '\n🔔 — есть новые ответы' : ''), rows }
    }

    async function sessionsPayload(workspaceId) {
      const w = workspaceRegistry ? workspaceRegistry.get(workspaceId) : undefined
      if (!w) return { text: '❌ Проект не найден.', rows: [] }
      const allIds = (w.sessionIds || []).slice(0, 30)
      // Показываем ТОЛЬКО открытые диалоги: закрытые скрыты, чтобы список
      // оставался рабочим списком, а не архивом.
      const ids = allIds.filter((id) => agents.get(id) !== undefined)
      const head = '📂 ' + clip(w.title || w.path, 60) + '\n' + clip(w.path, 60)
      if (ids.length === 0) {
        return {
          text: head + '\n\n(открытых диалогов нет)',
          rows: [
            [{ text: '➕ Новая сессия', callback_data: 'new:' + w.id }],
            [{ text: '⬅️ Проекты', callback_data: 'back:projects' }],
          ],
        }
      }
      const obs = await sessionQuery.readTitleSnapshots(ids)
      const byId = {}
      for (const o of obs || []) { if (o.status === 'fulfilled' && o.value && o.value.title) byId[o.sessionId] = o.value.title.title }
      lastSessions = []
      const rows = []
      let anyUnread = false
      for (let i = 0; i < ids.length; i++) {
        const sid = ids[i]
        lastSessions.push({ sessionId: sid })
        const u = unreadOf(sid)
        if (u > 0) anyUnread = true
        // ▶️ — диалог, в который сейчас уходят сообщения бота.
        const icon = target !== undefined && sid === target.id ? '▶️' : '🟢'
        rows.push([{ text: icon + ' ' + clip(byId[sid] || '(без названия)', 40) + (u > 0 ? ' 🔔' + u : ''), callback_data: 'use:' + sid }])
      }
      rows.push([{ text: '➕ Новая сессия', callback_data: 'new:' + w.id }])
      rows.push([{ text: '⬅️ Проекты', callback_data: 'back:projects' }])
      const summary = '\n\n🟢 открытых диалогов: ' + ids.length +
        (anyUnread ? '\n🔔 новые ответы в ' + ids.filter((s) => unreadOf(s) > 0).length + ' диалогах' : '') +
        '\n\n▶️ — активный диалог. Нажмите, чтобы переключиться:'
      return { text: head + summary, rows }
    }

    async function switchTarget(sessionId) {
      const live = agents.get(sessionId)
      if (live) { target = live; unread.delete(sessionId); return { ok: true, note: 'live' } }
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId })
        target = handle.agent
        unread.delete(sessionId)
        return { ok: true, note: 'resumed' }
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) }
      }
    }

    async function createSessionIn(workspace, presetId) {
      const newId = 'session-' + Date.now() + '-' + (++seq)
      let selection
      try { selection = agentDefaultModel ? agentDefaultModel.currentSelection() : undefined } catch (e) { selection = undefined }
      let resolvedPresetId, setup
      if (agentPresets) {
        try {
          // resolve(undefined) → пресет по умолчанию, как было до /new.
          const resolved = await agentPresets.resolve(presetId)
          resolvedPresetId = resolved && resolved.id
          setup = async (agentCtx) => { await agentPresets.mount(agentCtx, resolved.id) }
        } catch (e) { resolvedPresetId = undefined; setup = undefined }
      }
      const handle = await agents.create({
        sessionId: newId,
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
        meta: { cwd: workspace.path, ...(resolvedPresetId ? { agentPreset: resolvedPresetId } : {}) },
        ...(setup ? { setup } : {}),
      })
      try { await workspace.attachSession(newId) } catch (e) { /* ignore */ }
      target = handle.agent
      return handle.agent
    }

    // Проект сессии ищем по sessionIds: именно так рабочая область группирует
    // сессии, и та же привязка делает новую сессию видимой в списке GUI.
    function workspaceOfSession(sessionId) {
      if (!workspaceRegistry || !sessionId) return undefined
      for (const w of workspaceRegistry.list()) {
        if ((w.sessionIds || []).indexOf(sessionId) !== -1) return w
      }
      return undefined
    }

    function workspaceForNewSession() {
      if (!workspaceRegistry) return undefined
      const ws = workspaceRegistry.list()
      return (target ? workspaceOfSession(target.id) : undefined) ||
        ws.filter((w) => w.path === cwd)[0] ||
        ws[0]
    }

    function presetsListText(presets) {
      if (!presets || presets.length === 0) return '(пресеты недоступны)'
      return presets.map((p) => '• ' + p.id + ' — ' + (p.name || 'без имени')).join('\n')
    }

    // /new <пресет> [задача] — сессия на выбранном пресете;
    // /new <задача>          — сессия на пресете по умолчанию + задача сразу.
    async function newSessionPayload(arg) {
      const tokens = String(arg || '').trim().split(/\s+/).filter((t) => t.length > 0)
      const firstToken = tokens[0] || ''
      const presets = agentPresets ? await agentPresets.list().catch(() => []) : []
      if (!firstToken) {
        return {
          text: '🆕 Новая сессия\n\n/new <пресет> [задача] — сессия на выбранном пресете\n/new <задача> — сессия на пресете по умолчанию, задача уйдёт сразу\n\nПресеты:\n' + presetsListText(presets),
          rows: [],
        }
      }

      const known = presets.filter((p) => p.id === firstToken)[0]
      const presetId = known ? firstToken : undefined
      const text = (known ? tokens.slice(1) : tokens).join(' ').trim()

      const workspace = workspaceForNewSession()
      if (!workspace) return { text: '❌ Не нашёл проект для новой сессии.', rows: [] }

      try {
        const agent = await createSessionIn(workspace, presetId)
        if (text) {
          seq += 1
          agent.followup({
            id: 'tg-new-' + Date.now() + '-' + seq,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user', rpcId: 'tg-new-' + seq },
          })
        }
        const view = await buildActivation(agent.id)
        const head = '🆕 Новая сессия в «' + (workspace.title || workspace.path) + '»\n' +
          (presetId ? '🎭 Пресет: ' + presetId : '🎭 Пресет: по умолчанию') +
          (text ? '\n📨 Задача отправлена' : '') + '\n\n'
        return { text: head + view.text, rows: view.rows, fullLast: view.fullLast }
      } catch (e) {
        return { text: '❌ Не удалось создать сессию: ' + clip(String(e && e.message || e), 300), rows: [] }
      }
    }

    // ----- команды -----
    async function handleCommand(raw) {
      const parts = raw.slice(1).split(/\s+/)
      const name = parts[0].toLowerCase()
      const arg = parts.slice(1).join(' ').trim()
      if (name === 'projects') {
        const payload = await projectsPayload()
        await sendKeyboard(ALLOWED, payload.text, payload.rows)
        return true
      }
      if (name === 'new') {
        const payload = await newSessionPayload(arg)
        if (payload.fullLast) await sendText(ALLOWED, payload.fullLast)
        if (payload.rows && payload.rows.length) await sendKeyboard(ALLOWED, payload.text, payload.rows)
        else await sendText(ALLOWED, payload.text)
        return true
      }
      if (name === 'sessions') {
        await sendText(ALLOWED, await sessionsText(arg))
        return true
      }
      if (name === 'use') {
        await sendText(ALLOWED, await useText(arg))
        return true
      }
      if (name === 'current') {
        const agent = await resolveTarget()
        if (!agent) { await sendText(ALLOWED, 'Сессия не определена.'); return true }
        const title = await sessionTitleOf(agent.id)
        await sendText(ALLOWED, '🟢 Текущая сессия: ' + agent.id + (title ? ' — ' + title : ''))
        return true
      }
      if (name === 'voice') {
        await sendText(ALLOWED, '🎤 Голос → текст\n\nПросто запишите голосовое в Telegram и отправьте — бот скачает его через getFile, сконвертирует ffmpeg в WAV 16 кГц моно и распознает локально (whisper). Наружу ничего не уходит.\n\nПоддерживаются: голосовые, аудиофайлы, кружки и видео (берётся звуковая дорожка). Распознанный текст уходит в активный диалог как ваше сообщение, а ответ приходит сюда сразу.\n\nЯзык: ' + WHISPER_LANG + (WHISPER_LANG === 'auto' ? ' (определяется автоматически)' : '') + '\nМодель: ' + WHISPER_MODEL.split('/').pop() + '\n\nЕсли распознать не удалось, файл сохраняется и агенту уходит путь к нему.')
        return true
      }
      if (name === 'start' || name === 'help') {
        await sendText(ALLOWED, '🤖 Я — мост к агенту DSH.\n\nНапишите сообщение или отправьте голосовое — оно распознаётся и уходит в активный диалог; ответ приходит сюда сразу.\n\nКоманды:\n/new [пресет] [задача] — новая сессия (например /new tester или /new dev почини X)\n/projects — проекты (кнопки)\n/sessions [N] — открытые диалоги списком\n/use <id|N> — переключить диалог\n/current — текущий диалог\n/voice — как работает распознавание голоса\n/help — справка')
        return true
      }
      return false
    }

    async function sessionsText(arg) {
      if (!workspaceRegistry || !sessionQuery) return 'Сервис проектов/сессий недоступен.'
      const ws = workspaceRegistry.list()
      if (!ws || ws.length === 0) return '📂 Проектов пока нет.'
      lastSessions = []
      const n = parseInt(arg, 10)
      const projects = Number.isInteger(n) && n >= 1 && n <= ws.length ? [ws[n - 1]] : ws
      const parts = []
      for (const w of projects) {
        // Только открытые диалоги — закрытые в списке не показываем.
        const ids = (w.sessionIds || []).filter((id) => agents.get(id) !== undefined).slice(0, 30)
        for (let i = 0; i < ids.length; i++) lastSessions.push({ sessionId: ids[i], projectTitle: w.title })
        const obs = await sessionQuery.readTitleSnapshots(ids)
        const byId = {}
        for (const o of obs || []) { if (o.status === 'fulfilled' && o.value && o.value.title) byId[o.sessionId] = o.value.title.title }
        const head = '📂 ' + (w.title || '(без названия)') + '\n    ' + w.path
        if (ids.length === 0) { parts.push(head + '\n    (открытых диалогов нет)'); continue }
        const lines = []
        for (let i = 0; i < ids.length; i++) {
          const sid = ids[i]
          const icon = target !== undefined && sid === target.id ? '▶️' : '🟢'
          const u = unreadOf(sid)
          lines.push((i + 1) + '. ' + icon + ' ' + (byId[sid] || '(без названия)') + (u > 0 ? ' 🔔' + u : '') + '\n    ' + sid)
        }
        parts.push(head + '\n    🟢 открытых диалогов: ' + ids.length + '\n' + lines.join('\n'))
      }
      return '📋 Диалоги:\n\n' + parts.join('\n\n')
    }

    async function useText(arg) {
      let sessionId = arg
      const num = parseInt(arg, 10)
      if (Number.isInteger(num) && num >= 1 && num <= lastSessions.length) sessionId = lastSessions[num - 1].sessionId
      if (!sessionId || sessionId.indexOf('session-') !== 0) return '❓ Укажите sessionId или номер из /sessions.\nПример: /use session-123 или /use 2'
      const r = await switchTarget(sessionId)
      if (!r.ok) return '❌ Не удалось открыть сессию ' + sessionId + ': ' + r.error
      const view = await buildActivation(sessionId)
      let out = view.text
      if (view.fullLast) out += '\n\n📄 Полный текст последнего сообщения:\n' + view.fullLast
      return out
    }

    // ----- вопросы модели (user-questions/request) -----

    function questionText(item, idx, total) {
      let t = '❓ Вопрос модели' + (total > 1 ? ' ' + (idx + 1) + '/' + total : '')
      if (item.header) t += '\n\n' + clip(String(item.header), 200)
      t += '\n\n' + clip(String(item.question || ''), 1500)
      if (item.detail) t += '\n\n' + clip(String(item.detail), 1200)
      const opts = item.options || []
      if (opts.length === 0) t += '\n\n✏️ Ответьте текстом следующим сообщением.'
      else if (item.multiSelect) t += '\n\n(можно выбрать несколько, затем «Готово»)'
      return t
    }

    function questionButtons(key, qi, item, chosen) {
      const rows = []
      const opts = item.options || []
      for (let i = 0; i < opts.length; i++) {
        const mark = chosen && chosen.has && chosen.has(i) ? '✓ ' : ''
        rows.push([{ text: mark + clip(String(opts[i].label || ('Вариант ' + (i + 1))), 55), callback_data: 'q:' + key + ':' + qi + ':' + i }])
      }
      if (item.multiSelect) rows.push([{ text: '✅ Готово', callback_data: 'qd:' + key + ':' + qi }])
      if (opts.length > 0) rows.push([{ text: '✏️ Свой ответ', callback_data: 'qt:' + key + ':' + qi }])
      return rows
    }

    async function askNext(key) {
      const st = pendingQuestions.get(key)
      if (!st) return
      if (st.index >= st.items.length) {
        pendingQuestions.delete(key)
        awaitingText = undefined
        st.resolve({ answers: st.answers })
        return
      }
      const item = st.items[st.index]
      const text = questionText(item, st.index, st.items.length)
      const rows = questionButtons(key, st.index, item, st.multi)
      if (st.messageId !== undefined) await editMessage(st.chatId, st.messageId, text, rows)
      else st.messageId = await sendKeyboardId(st.chatId, text, rows)
    }

    async function handleQuestionCallback(cb, data) {
      const parts = data.split(':')
      const kind = parts[0]
      const key = parts[1]
      const qi = parseInt(parts[2], 10)
      const st = pendingQuestions.get(key)
      if (!st) { await answerCallback(cb.id, 'Вопрос уже закрыт'); return true }
      if (st.index !== qi) { await answerCallback(cb.id, 'Этот вопрос уже отвечен'); return true }
      const item = st.items[qi]
      if (kind === 'q') {
        const oi = parseInt(parts[3], 10)
        const opt = (item.options || [])[oi]
        if (!opt) { await answerCallback(cb.id, 'Вариант не найден'); return true }
        if (item.multiSelect) {
          if (st.multi.has(oi)) st.multi.delete(oi)
          else st.multi.add(oi)
          await answerCallback(cb.id, 'Отмечено')
          const text = questionText(item, qi, st.items.length)
          const rows = questionButtons(key, qi, item, st.multi)
          if (st.messageId !== undefined) await editMessage(st.chatId, st.messageId, text, rows)
          return true
        }
        st.answers.push({ id: item.id, selected: [String(opt.label)] })
        await answerCallback(cb.id, '✅ ' + clip(String(opt.label), 60))
        st.index = qi + 1
        st.multi = new Set()
        await askNext(key)
        return true
      }
      if (kind === 'qd') {
        const labels = []
        for (const oi of Array.from(st.multi).sort((a, b) => a - b)) {
          const opt = (item.options || [])[oi]
          if (opt) labels.push(String(opt.label))
        }
        st.answers.push({ id: item.id, selected: labels })
        await answerCallback(cb.id, '✅ Выбрано: ' + labels.length)
        st.index = qi + 1
        st.multi = new Set()
        await askNext(key)
        return true
      }
      if (kind === 'qt') {
        awaitingText = { key: key, qi: qi }
        await answerCallback(cb.id, 'Напишите ответ сообщением')
        await sendText(st.chatId, '✏️ Напишите ваш ответ следующим сообщением.')
        return true
      }
      await answerCallback(cb.id, '')
      return true
    }

    // ----- callbacks -----
    async function handleCallback(cb) {
      const data = String(cb.data || '')
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : ALLOWED
      const messageId = cb.message ? cb.message.message_id : undefined
      try {
        // Кнопки вопросов модели: q:<key>:<qi>:<oi> | qd:<key>:<qi> | qt:<key>:<qi>
        if (data.indexOf('q:') === 0 || data.indexOf('qd:') === 0 || data.indexOf('qt:') === 0) {
          return await handleQuestionCallback(cb, data)
        }
        if (data.indexOf('noop:') === 0) { await answerCallback(cb.id, ''); return true }
        if (data.indexOf('appr:') === 0 || data.indexOf('rej:') === 0) {
          const approve = data.indexOf('appr:') === 0
          const key = data.slice(5)
          const pending = pendingApprovals.get(key)
          if (!pending) { await answerCallback(cb.id, 'Запрос уже обработан'); return true }
          pendingApprovals.delete(key)
          pending.resolve(approve ? 'allowed-once' : 'rejected')
          const label = approve ? '✅ Разрешено' : '❌ Отклонено'
          await answerCallback(cb.id, label)
          if (messageId !== undefined) await editMessage(chatId, messageId, label + ' — ' + clip(pending.toolName || 'запрос', 100), [])
          return true
        }
        if (data.indexOf('new:') === 0) {
          const wid = data.slice(4)
          const w = workspaceRegistry ? workspaceRegistry.get(wid) : undefined
          if (!w) { await answerCallback(cb.id, 'Проект не найден'); return true }
          // Пресеты пользователя — первыми: именно они нужны для ролей.
          const presets = (agentPresets ? await agentPresets.list().catch(() => []) : []).slice().sort((a, b) => {
            const ua = a.trust === 'user' ? 0 : 1
            const ub = b.trust === 'user' ? 0 : 1
            return ua - ub
          })
          // Telegram допускает 64 байта в callback_data: слишком длинные id
          // пресетов пропускаем, иначе не отправится вся клавиатура.
          const rows = presets
            .filter((p) => ('newp:' + wid + ':' + p.id).length <= 64)
            .map((p) => [{
              text: '🎭 ' + clip(p.name ? p.id + ' — ' + p.name : p.id, 45),
              callback_data: 'newp:' + wid + ':' + p.id,
            }])
          rows.push([{ text: '🔧 Пресет по умолчанию', callback_data: 'newd:' + wid }])
          rows.push([{ text: '⬅️ Проекты', callback_data: 'back:projects' }])
          const pickerText = '🆕 Новая сессия\n📂 ' + clip(w.title || w.path, 60) + '\n' + clip(w.path, 60) + '\n\nВыберите пресет:'
          await answerCallback(cb.id, '')
          if (messageId !== undefined) await editMessage(chatId, messageId, pickerText, rows)
          else await sendKeyboard(chatId, pickerText, rows)
          return true
        }
        if (data.indexOf('newp:') === 0) {
          const rest = data.slice(5)
          const colon = rest.indexOf(':')
          if (colon <= 0) { await answerCallback(cb.id, 'Некорректные данные кнопки'); return true }
          const w = workspaceRegistry ? workspaceRegistry.get(rest.slice(0, colon)) : undefined
          const presetId = rest.slice(colon + 1)
          if (!w) { await answerCallback(cb.id, 'Проект не найден'); return true }
          // Пресет могли удалить между показом кнопок и нажатием — тогда честно
          // отказываем, а не создаём молча сессию на пресете по умолчанию.
          if (agentPresets) {
            const still = (await agentPresets.list().catch(() => [])).some((p) => p.id === presetId)
            if (!still) { await answerCallback(cb.id, 'Пресет больше недоступен'); return true }
          }
          await answerCallback(cb.id, 'Создаю на ' + presetId + '…')
          try {
            const agent = await createSessionIn(w, presetId)
            const view = await buildActivation(agent.id)
            await presentActivation(chatId, messageId, view)
          } catch (e) {
            await sendText(chatId, '❌ Не удалось создать сессию: ' + clip(String(e && e.message || e), 300))
          }
          return true
        }
        if (data.indexOf('newd:') === 0) {
          const w = workspaceRegistry ? workspaceRegistry.get(data.slice(5)) : undefined
          if (!w) { await answerCallback(cb.id, 'Проект не найден'); return true }
          await answerCallback(cb.id, 'Создаю…')
          try {
            const agent = await createSessionIn(w, undefined)
            const view = await buildActivation(agent.id)
            await presentActivation(chatId, messageId, view)
          } catch (e) {
            await sendText(chatId, '❌ Не удалось создать сессию: ' + clip(String(e && e.message || e), 300))
          }
          return true
        }
        if (data.indexOf('refresh:') === 0) {
          const sid = data.slice(8)
          unread.delete(sid)
          const view = await buildActivation(sid)
          await answerCallback(cb.id, '')
          await presentActivation(chatId, messageId, view)
          return true
        }
        if (data.indexOf('hist:') === 0) {
          const rest = data.slice(5)
          const colon = rest.lastIndexOf(':')
          const sid = rest.slice(0, colon)
          const count = parseInt(rest.slice(colon + 1), 10) || 10
          const h = await historyText(sid, count)
          const rows = []
          if (h.shown < h.total) rows.push([{ text: '📜 ещё 10', callback_data: 'hist:' + sid + ':' + (h.shown + 10) }])
          rows.push([{ text: '⬅️ Проекты', callback_data: 'back:projects' }])
          await answerCallback(cb.id, '')
          if (messageId !== undefined) await editMessage(chatId, messageId, h.text, rows)
          else await sendKeyboard(chatId, h.text, rows)
          return true
        }
        if (data.indexOf('proj:') === 0) {
          const payload = await sessionsPayload(data.slice(5))
          await answerCallback(cb.id, payload.rows.length ? 'Открываю…' : 'Нет сессий')
          if (messageId !== undefined) await editMessage(chatId, messageId, payload.text, payload.rows)
          else await sendKeyboard(chatId, payload.text, payload.rows)
          return true
        }
        if (data.indexOf('use:') === 0) {
          const sid = data.slice(4)
          const r = await switchTarget(sid)
          if (!r.ok) { await answerCallback(cb.id, 'Ошибка: ' + clip(r.error, 180)); return true }
          const view = await buildActivation(sid)
          await answerCallback(cb.id, '✅ Переключено')
          await presentActivation(chatId, messageId, view)
          return true
        }
        // Открытые диалоги проекта, которому принадлежит активная сессия.
        if (data === 'curproj') {
          const agent = await resolveTarget()
          let wid
          if (agent && agent.session && agent.session.header && agent.session.header.cwd) {
            const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            const cur = norm(agent.session.header.cwd)
            const ws = workspaceRegistry ? workspaceRegistry.list() : []
            const found = ws.find((x) => norm(x.path) === cur)
            if (found) wid = found.id
          }
          if (!wid) {
            // Проект не сопоставлен — показываем общий список, чтобы не гадать.
            await answerCallback(cb.id, 'Проект не определён')
            const fallback = await projectsPayload()
            if (messageId !== undefined) await editMessage(chatId, messageId, fallback.text, fallback.rows)
            else await sendKeyboard(chatId, fallback.text, fallback.rows)
            return true
          }
          const payload = await sessionsPayload(wid)
          await answerCallback(cb.id, 'Диалоги проекта')
          if (messageId !== undefined) await editMessage(chatId, messageId, payload.text, payload.rows)
          else await sendKeyboard(chatId, payload.text, payload.rows)
          return true
        }
        if (data === 'back:projects') {
          const payload = await projectsPayload()
          await answerCallback(cb.id, 'Проекты')
          if (messageId !== undefined) await editMessage(chatId, messageId, payload.text, payload.rows)
          else await sendKeyboard(chatId, payload.text, payload.rows)
          return true
        }
        await answerCallback(cb.id, 'Неизвестная команда')
        return true
      } catch (e) {
        console.error('[tg-bridge] callback error:', e.message)
        try { await answerCallback(cb.id, 'Ошибка обработки') } catch (e2) { /* ignore */ }
        return true
      }
    }

    // ----- обработчики, которые вызывает общий роутер мостов -----
    // Свои ctx.on здесь регистрировать нельзя: при нескольких ботах каждый
    // запрос разрешения и каждый вопрос модели ушёл бы во все чаты сразу.
    // Роутер один на процесс; он выбирает мост по проекту сессии.

    async function onSessionEvent(session, event) {
      if (event.type !== 'assistant/message') return
      const msg = event.data && event.data.message
      if (!msg || !msg.content) return
      const body = textOf(msg.content)
      if (!body.trim()) return
      // Ответ активного диалога уходит в чат СРАЗУ (с кнопками), чтобы не
      // приходилось заходить в диалог и жать «Обновить».
      if (target !== undefined && session.id === target.id) {
        unread.delete(session.id)
        sendReplyWithButtons(ALLOWED, body).catch((e) => console.error('[tg-bridge] reply send failed:', e.message))
        return
      }
      // Ответы других диалогов только помечаются непрочитанными.
      unread.set(session.id, (unread.get(session.id) || 0) + 1)
    }

    function onApproval(req, next) {
      approvalSeq += 1
      const key = 'ap' + Date.now() + '-' + approvalSeq
      const signal = req && req.signal
      return new Promise((resolve) => {
        const done = (outcome) => { pendingApprovals.delete(key); resolve(outcome) }
        const onAbort = () => done('cancelled')
        if (signal) {
          if (signal.aborted) { done('cancelled'); return }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        const build = async () => {
          const toolName = req && req.toolName ? String(req.toolName) : 'инструмент'
          const reason = req && req.reason ? String(req.reason) : ''
          const agentId = req && req.agent && req.agent.id ? String(req.agent.id) : ''
          const title = agentId ? await sessionTitleOf(agentId) : undefined
          let text = '🔐 Запрос разрешения:\n🛠 ' + clip(toolName, 120)
          if (title) text += '\n📌 Сессия: ' + clip(title, 60)
          if (agentId) text += '\n🆔 ' + agentId
          if (reason) text += '\n💬 ' + clip(reason, 400)
          text += '\n\nРазрешить выполнение?'
          const rows = [[{ text: '✅ Разрешить', callback_data: 'appr:' + key }], [{ text: '❌ Отклонить', callback_data: 'rej:' + key }]]
          pendingApprovals.set(key, { resolve: done, toolName })
          try {
            await sendKeyboard(ALLOWED, text, rows)
          } catch (e) {
            console.error('[tg-bridge] approval send failed, handing to GUI:', e.message)
            if (signal) signal.removeEventListener('abort', onAbort)
            pendingApprovals.delete(key)
            resolve(next())
          }
        }
        build().catch((e) => {
          console.error('[tg-bridge] approval build failed, handing to GUI:', e.message)
          if (signal) signal.removeEventListener('abort', onAbort)
          pendingApprovals.delete(key)
          resolve(next())
        })
      })
    }

    function onQuestion(request, next) {
      const items = request && request.questions ? request.questions : []
      if (!items.length) return next()
      questionSeq += 1
      const key = 'q' + Date.now() + '-' + questionSeq
      const signal = request && request.signal
      return new Promise((resolve) => {
        const done = (answer) => { pendingQuestions.delete(key); resolve(answer) }
        const onAbort = () => done({ answers: [] })
        if (signal) {
          if (signal.aborted) { done({ answers: [] }); return }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        const build = async () => {
          const agentId = request.agent && request.agent.id ? String(request.agent.id) : ''
          const title = agentId ? await sessionTitleOf(agentId) : undefined
          if (title) {
            try { await sendText(ALLOWED, '📌 Вопрос по сессии: ' + clip(title, 80)) } catch (e) { /* ignore */ }
          }
          const st = {
            items, answers: [], index: 0, multi: new Set(),
            chatId: ALLOWED, messageId: undefined, resolve: done,
          }
          pendingQuestions.set(key, st)
          try {
            await askNext(key)
          } catch (e) {
            console.error('[tg-bridge] question send failed, handing to GUI:', e.message)
            if (signal) signal.removeEventListener('abort', onAbort)
            pendingQuestions.delete(key)
            resolve(next())
          }
        }
        build().catch((e) => {
          console.error('[tg-bridge] question build failed, handing to GUI:', e.message)
          if (signal) signal.removeEventListener('abort', onAbort)
          pendingQuestions.delete(key)
          resolve(next())
        })
      })
    }

    // ----- polling -----
    async function pollOnce() {
      try {
        const res = await tg('GET', '/getUpdates?offset=' + String(offset) + '&timeout=5')
        if (!res.ok) { console.error('[tg-bridge] getUpdates not ok:', res.description); return }
        for (const u of (res.result || [])) {
          offset = u.update_id + 1
          const cb = u.callback_query
          if (cb) {
            const from = cb.from
            if (from && from.id === ALLOWED) await handleCallback(cb)
            continue
          }
          const msg = u.message
          if (!msg) continue
          const from = msg.from
          if (!from || from.id !== ALLOWED) continue
          if (msg.voice || msg.audio || msg.video_note || msg.video || (msg.document && msg.document.file_id)) {
            // Распознавание занимает секунды: уводим в фон, чтобы остальные
            // сообщения не ждали окончания транскрипции.
            enqueueMedia(() => handleMedia(msg, u))
            continue
          }
          const text = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '')
          if (!text.trim()) continue
          // Свободный ответ на вопрос модели: это сообщение — ответ, не задача агенту.
          if (awaitingText) {
            await deliverTextAnswer(text.trim())
            continue
          }
          const trimmed = text.trim()
          if (trimmed[0] === '/') {
            const handled = await handleCommand(trimmed)
            if (handled) continue
          }
          const agent = await resolveTarget()
          if (!agent) { console.error('[tg-bridge] no target agent'); continue }
          seq += 1
          agent.followup({ id: 'tg-' + Date.now() + '-' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'tg-' + u.update_id } })
        }
      } catch (e) {
        console.error('[tg-bridge] poll error:', e.message)
      }
    }


    return {
      key: bot.key,
      token: bot.token,
      projectId: bot.projectId,
      polling: false,
      cleanTmp: cleanTmpDir,
      tick: async () => {
        if (!target) await initTarget()
        await pollOnce()
      },
      onSessionEvent,
      onApproval,
      onQuestion,
    }
}
