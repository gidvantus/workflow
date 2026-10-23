// Переработка tg-bridge под несколько ботов: у каждого проекта свой бот.
//
//   node 13-tg-bridge-multibot.mjs --dry-run
//   node 13-tg-bridge-multibot.mjs
//
// Что меняется:
//   1) конфиг бота читается из проекта (projects.json → telegram), а
//      ~/.dsh/telegram.json остаётся общим ботом; зашитый в код секрет убран;
//   2) модульные TOKEN/ALLOWED исчезают: функции Telegram получают токен
//      параметром, а тело моста оборачивается в фабрику buildBridge(ctx, bot),
//      которая вызвается один раз на бота;
//   3) три глобальных хука (session/event, approval/request,
//      user-questions/request) регистрируются ОДИН раз и роутятся по проекту
//      сессии — иначе при нескольких ботах каждый вопрос уходил бы во все чаты.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const MIGRATION = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration')
const FILE = path.join(PLUGINS, 'tg-bridge.mjs')
const OUT = path.join(MIGRATION, '13-tg-bridge-multibot.mjs.out')
const DRY = process.argv.includes('--dry-run')

const text = fs.readFileSync(FILE, 'utf8')
const lines = text.split('\n')

function expect(index, value, label) {
  const actual = lines[index]
  const ok = typeof value === 'function' ? value(actual) : actual === value
  if (!ok) {
    throw new Error('строка ' + (index + 1) + ': ожидалось ' + (typeof value === 'function' ? label : JSON.stringify(value)) +
      ', получено ' + JSON.stringify(actual))
  }
}

// ── Контроль структуры: режем по номерам строк, поэтому проверяем каждый шов ──
expect(19, '// Токен и получатель берутся из ~/.dsh/telegram.json — тем же файлом', 'начало блока конфига')
expect(63, (s) => s.startsWith("const AUDIO_EXT = ["), 'конец блока конфига (AUDIO_EXT)')
expect(65, '// ----- HTTP helper: один постоянный https.Agent с keep-alive -----', 'начало HTTP-хелперов')
expect(175, '}', 'конец answerCallback')
expect(192, "  inject: ['timer', 'agents', 'sessionQuery', 'workspaceRegistry', 'agentPresets', 'agentDefaultModel'],", 'строка inject')
expect(193, '  apply(ctx) {', 'начало apply')
expect(194, "    const agents = ctx.get('agents')", 'начало тела apply')
expect(202, '    }', 'конец guard')
expect(1105, '    // ----- события -----', 'начало хуков')
expect(1106, (s) => s.startsWith("    ctx.on('session/event'"), 'session/event')
expect(1107 + 13, '      unread.set(session.id, (unread.get(session.id) || 0) + 1)', 'конец тела session/event')
expect(1121, '    })', 'закрытие session/event')
expect(1123, (s) => s.startsWith("    ctx.on('approval/request'"), 'approval/request')
expect(1124, '      approvalSeq += 1', 'начало тела approval')
expect(1161, '      })', 'конец тела approval')
expect(1162, '    }, { prepend: true })', 'закрытие approval')
expect(1168, (s) => s.startsWith("    ctx.on('user-questions/request'"), 'user-questions/request')
expect(1169, '      const items = request && request.questions ? request.questions : []', 'начало тела вопроса')
expect(1207, '      })', 'конец тела вопроса')
expect(1208, '    }, { prepend: true })', 'закрытие вопроса')
expect(1255, '    cleanTmpDir()', 'начало хвоста')
expect(1268, '    }, 1000)', 'конец интервала')
expect(1269, '  },', 'закрытие apply')
expect(1270, '}', 'закрытие export default')

// ── 1. Новый блок конфигурации: боты вместо одной глобальной пары ────────────

const CONFIG = [
  '// Боты берутся из конфигурации. У каждого проекта может быть СВОЙ бот —',
  '// поле telegram в ~/.dsh/projects.json; ~/.dsh/telegram.json остаётся общим и',
  '// обслуживает проекты, которые своего бота не завели. Тот же общий файл',
  '// читает диспетчер отдела разработки, чтобы слать сводки.',
  '//',
  '// Секрета в исходнике нет намеренно: токен, зашитый в код, уезжает вместе с',
  '// плагином. Нет настроенного бота — нет моста, и об этом пишется в лог.',
  '',
  'function stripBom(text) {',
  '  const value = String(text)',
  '  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value',
  '}',
  '',
  'function dshHomeDir() {',
  "  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')",
  '}',
  '',
  'function readJsonConfig(file) {',
  '  try {',
  '    return JSON.parse(stripBom(fs.readFileSync(file, \'utf8\')))',
  '  } catch (error) {',
  '    return undefined',
  '  }',
  '}',
  '',
  '// Общий бот: ~/.dsh/telegram.json.',
  'function readSharedTelegram() {',
  "  const raw = readJsonConfig(path.join(dshHomeDir(), 'telegram.json'))",
  '  if (!raw || !raw.token || !raw.chatId) return undefined',
  '  return {',
  '    token: String(raw.token),',
  '    chatId: raw.chatId,',
  '    voiceLang: raw.voiceLang ? String(raw.voiceLang) : undefined,',
  '  }',
  '}',
  '',
  'function normalizePath(value) {',
  "  return String(value || '').replace(/\\//g, '\\\\').replace(/\\\\+$/, '').toLowerCase()",
  '}',
  '',
  '// Проекты: id, название, рабочая область и, если задан, свой бот.',
  'function readProjectsRegistry() {',
  "  const raw = readJsonConfig(path.join(dshHomeDir(), 'projects.json'))",
  '  const projects = (raw && raw.projects) || {}',
  '  return Object.keys(projects).map((id) => {',
  '    const row = projects[id] || {}',
  '    const tg = row.telegram && typeof row.telegram === \'object\' ? row.telegram : undefined',
  '    const bot = tg && tg.token && tg.chatId',
  '      ? { token: String(tg.token), chatId: tg.chatId, voiceLang: tg.voiceLang ? String(tg.voiceLang) : undefined }',
  '      : undefined',
  '    return {',
  '      id,',
  "      title: typeof row.title === 'string' && row.title ? row.title : id,",
  "      workspace: String(row.workspace || ''),",
  '      bot,',
  '    }',
  '  })',
  '}',
  '',
  '// Список ботов для опроса: по одному на проект со своим ботом плюс общий —',
  '// для проектов без своего. Токен, указанный у двух проектов, опрашивается',
  '// один раз: владельцем становится первый по порядку реестра.',
  'function buildBots(projects, shared) {',
  '  const bots = []',
  '  const seen = new Set()',
  '  for (const project of projects) {',
  '    if (!project.bot) continue',
  '    if (seen.has(project.bot.token)) continue',
  '    seen.add(project.bot.token)',
  '    bots.push({ key: project.id, projectId: project.id, ...project.bot })',
  '  }',
  '  if (shared && !seen.has(shared.token)) {',
  '    seen.add(shared.token)',
  '    bots.push({ key: \'shared\', projectId: null, ...shared })',
  '  }',
  '  return bots',
  '}',
  '',
  '// Рабочая область по умолчанию, когда у бота нет своего проекта.',
  'function defaultProjectWorkspace() {',
  "  const raw = readJsonConfig(path.join(dshHomeDir(), 'projects.json'))",
  '  const projects = (raw && raw.projects) || {}',
  '  const ids = Object.keys(projects)',
  '  if (ids.length === 0) return \'\'',
  "  const id = typeof raw.default === 'string' && raw.default && projects[raw.default] ? raw.default : ids[0]",
  '  const workspace = projects[id] && projects[id].workspace',
  "  return typeof workspace === 'string' ? workspace : ''",
  '}',
  '',
  "const TOOLS = 'D:/Development/VideCoding/Brain/.voice-tools'",
  "const FFMPEG = TOOLS + '/ffmpeg/ffmpeg.exe'",
  "const WHISPER = TOOLS + '/whisper/Release/whisper-cli.exe'",
  "const WHISPER_MODEL = TOOLS + '/models/ggml-small.bin'",
  "const VOICE_TMP = TOOLS + '/tmp'",
  '// Расширения, которые считаем аудио/видео и отправляем на распознавание.',
  "const AUDIO_EXT = ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'webm', 'amr', '3gp', 'mp4', 'm4v', 'mov', 'mkv']",
]

// ── 2. Токен как параметр: модульные хелперы получают префикс With ───────────

const HELP = lines.slice(65, 176)
let helpText = HELP.join('\n')
const RENAMES = [
  ['function httpJson(method, pathname, payload, timeoutMs = 30000) {', 'function httpJsonWith(token, method, pathname, payload, timeoutMs = 30000) {'],
  ["      path: '/bot' + TOKEN + pathname,", "      path: '/bot' + token + pathname,"],
  ['async function tg(method, pathname, payload, timeoutMs) {', 'async function tgWith(token, method, pathname, payload, timeoutMs) {'],
  ['async function sendText(chatId, text) {', 'async function sendTextWith(token, chatId, text) {'],
  ['async function sendKeyboardId(chatId, text, rows) {', 'async function sendKeyboardIdWith(token, chatId, text, rows) {'],
  ['async function sendKeyboard(chatId, text, rows) {', 'async function sendKeyboardWith(token, chatId, text, rows) {'],
  ['async function editMessage(chatId, messageId, text, rows) {', 'async function editMessageWith(token, chatId, messageId, text, rows) {'],
  ['async function sendTextId(chatId, text) {', 'async function sendTextIdWith(token, chatId, text) {'],
  ['async function sendReplyWithButtons(chatId, text) {', 'async function sendReplyWithButtonsWith(token, chatId, text) {'],
  ['async function answerCallback(callbackQueryId, text) {', 'async function answerCallbackWith(token, callbackQueryId, text) {'],
  ['await httpJson(', 'await httpJsonWith(token, '],
  ['await tg(', 'await tgWith(token, '],
  ['await sendKeyboardId(chatId, text, rows)', 'await sendKeyboardIdWith(token, chatId, text, rows)'],
]
for (const [from, to] of RENAMES) {
  if (!helpText.includes(from)) throw new Error('не найден фрагмент для переименования: ' + from)
  helpText = helpText.split(from).join(to)
}
if (/\bTOKEN\b/.test(helpText)) throw new Error('в хелперах остался TOKEN')
const HELP_NEW = helpText.split('\n')

// ── 3. Тело моста выделяется в фабрику, хуки становятся методами ─────────────

const bodyHead = lines.slice(194, 1105)     // от const agents до строки перед хуками
const sessionEventBody = lines.slice(1107, 1121)
const approvalBody = lines.slice(1124, 1162)
const questionBody = lines.slice(1169, 1208)
const bodyTail = lines.slice(1209, 1255)    // секция polling
if (!bodyTail.join('\n').includes('async function pollOnce()')) throw new Error('не найдена секция polling')
if (!bodyHead.join('\n').includes('async function handleCallback')) throw new Error('не найдена секция разбора колбэков')

const PROLOGUE = [
  '',
  '    // ── этот мост обслуживает ровно одного бота ──────────────────────────',
  '    const TOKEN = bot.token',
  '    const ALLOWED = bot.chatId',
  "    const WHISPER_LANG = bot.voiceLang || 'auto'",
  '',
  '    // Тонкие обёртки: весь код ниже зовёт sendText/tg с прежними аргументами,',
  '    // а токен подставляется здесь. Так один и тот же код обслуживает всех ботов.',
  '    const httpJson = (method, pathname, payload, timeoutMs) => httpJsonWith(TOKEN, method, pathname, payload, timeoutMs)',
  '    const tg = (method, pathname, payload, timeoutMs) => tgWith(TOKEN, method, pathname, payload, timeoutMs)',
  '    const sendText = (chatId, text) => sendTextWith(TOKEN, chatId, text)',
  '    const sendKeyboardId = (chatId, text, rows) => sendKeyboardIdWith(TOKEN, chatId, text, rows)',
  '    const sendKeyboard = (chatId, text, rows) => sendKeyboardWith(TOKEN, chatId, text, rows)',
  '    const editMessage = (chatId, messageId, text, rows) => editMessageWith(TOKEN, chatId, messageId, text, rows)',
  '    const sendTextId = (chatId, text) => sendTextIdWith(TOKEN, chatId, text)',
  '    const sendReplyWithButtons = (chatId, text) => sendReplyWithButtonsWith(TOKEN, chatId, text)',
  '    const answerCallback = (callbackQueryId, text) => answerCallbackWith(TOKEN, callbackQueryId, text)',
]

const METHODS = [
  '    // ----- обработчики, которые вызывает общий роутер мостов -----',
  '    // Свои ctx.on здесь регистрировать нельзя: при нескольких ботах каждый',
  '    // запрос разрешения и каждый вопрос модели ушёл бы во все чаты сразу.',
  '    // Роутер один на процесс; он выбирает мост по проекту сессии.',
  '',
  '    async function onSessionEvent(session, event) {',
  ...sessionEventBody,
  '    }',
  '',
  '    function onApproval(req, next) {',
  ...approvalBody,
  '    }',
  '',
  '    function onQuestion(request, next) {',
  ...questionBody,
  '    }',
]

const RETURN = [
  '',
  '    return {',
  '      key: bot.key,',
  '      token: bot.token,',
  '      projectId: bot.projectId,',
  '      polling: false,',
  '      cleanTmp: cleanTmpDir,',
  '      tick: async () => {',
  '        if (!target) await initTarget()',
  '        await pollOnce()',
  '      },',
  '      onSessionEvent,',
  '      onApproval,',
  '      onQuestion,',
  '    }',
]

// ── 4. Новый apply: роутер и по одному мосту на бота ────────────────────────

const APPLY = [
  '  inject: [\'timer\', \'agents\', \'sessions\', \'sessionQuery\', \'workspaceRegistry\', \'agentPresets\', \'agentDefaultModel\'],',
  '',
  '  apply(ctx) {',
  "    const agents = ctx.get('agents')",
  "    const sessions = ctx.get('sessions')",
  '    if (!agents) {',
  "      console.error('[tg-bridge] missing service agents')",
  '      return',
  '    }',
  '',
  '    const projects = readProjectsRegistry()',
  '    const shared = readSharedTelegram()',
  '    const bots = buildBots(projects, shared)',
  '    if (bots.length === 0) {',
  "      console.error('[tg-bridge] нет ни одного бота: ни telegram у проектов в projects.json, ни ~/.dsh/telegram.json')",
  '      return',
  '    }',
  '',
  '    const bridges = bots.map((bot) => buildBridge(ctx, bot))',
  '    const byToken = new Map(bridges.map((bridge) => [bridge.token, bridge]))',
  '    // Общий бот: если его токен уже занят проектом, общим становится тот же',
  '    // мост — иначе у проектов без своего бота не осталось бы адресата.',
  '    const sharedBridge = bridges.filter((bridge) => bridge.projectId === null)[0] ||',
  '      (shared ? byToken.get(shared.token) : undefined)',
  '',
  '    // Проект сессии ищем по рабочей области: тот же признак, по которому',
  '    // пресеты резолвят проект. Не нашли — событие уходит общему боту, а если',
  '    // его нет, остаётся GUI.',
  '    function projectOfSession(sessionId) {',
  '      try {',
  '        const session = sessions ? sessions.get(sessionId) : undefined',
  '        const cwd = session && session.header ? session.header.cwd : undefined',
  "        if (!cwd) return undefined",
  '        const wanted = normalizePath(cwd)',
  '        let best',
  '        let bestLength = -1',
  '        for (const project of projects) {',
  '          const root = normalizePath(project.workspace)',
  '          if (!root) continue',
  "          if (wanted === root || wanted.indexOf(root + '\\\\') === 0) {",
  '            if (root.length > bestLength) { best = project; bestLength = root.length }',
  '          }',
  '        }',
  '        return best',
  '      } catch (error) {',
  '        return undefined',
  '      }',
  '    }',
  '',
  '    function bridgeForSession(sessionId) {',
  '      const project = projectOfSession(sessionId)',
  '      if (project && project.bot) {',
  '        const own = byToken.get(project.bot.token)',
  '        if (own) return own',
  '      }',
  '      return sharedBridge',
  '    }',
  '',
  '    // Хуки регистрируются ОДИН раз на процесс: их тела живут в мостах.',
  "    ctx.on('session/event', (session, event) => {",
  '      const bridge = session ? bridgeForSession(session.id) : undefined',
  '      if (bridge) bridge.onSessionEvent(session, event)',
  '    })',
  '',
  "    ctx.on('approval/request', (req, next) => {",
  '      const agentId = req && req.agent && req.agent.id ? String(req.agent.id) : \'\'',
  '      const bridge = agentId ? bridgeForSession(agentId) : sharedBridge',
  '      if (!bridge) return next()',
  '      return bridge.onApproval(req, next)',
  '    }, { prepend: true })',
  '',
  "    ctx.on('user-questions/request', (request, next) => {",
  '      const agentId = request && request.agent && request.agent.id ? String(request.agent.id) : \'\'',
  '      const bridge = agentId ? bridgeForSession(agentId) : sharedBridge',
  '      if (!bridge) return next()',
  '      return bridge.onQuestion(request, next)',
  '    }, { prepend: true })',
  '',
  '    // У каждого бота свой опрос: свои offset, активный диалог и счётчики.',
  '    for (const bridge of bridges) {',
  '      bridge.cleanTmp()',
  '      ctx.effect(() => ctx.interval(async () => {',
  '        if (bridge.polling) return',
  '        bridge.polling = true',
  '        try {',
  '          await bridge.tick()',
  '        } catch (error) {',
  "          console.error('[tg-bridge:' + bridge.key + '] tick error:', error && error.message)",
  '        } finally {',
  '          bridge.polling = false',
  '        }',
  '      }, 1000), \'tg-bridge:poll:\' + bridge.key)',
  '      console.log(\'[tg-bridge] бот "\' + bridge.key + \'" запущен\')',
  '    }',
  '  },',
  '}',
  '',
  '// Один мост = один бот. Всё состояние (offset, активный диалог, очередь медиа,',
  '// ожидающие разрешения и вопросы) принадлежит этому вызову и не делится с',
  '// другими ботами.',
  'function buildBridge(ctx, bot) {',
  ...bodyHead.slice(0, 9),
  ...PROLOGUE,
  ...bodyHead.slice(9),
  ...METHODS,
  ...bodyTail,
  ...RETURN,
  '}',
  '',
]

const out = [
  ...lines.slice(0, 19),
  ...CONFIG,
  '',
  ...HELP_NEW,
  ...lines.slice(176, 192),
  ...APPLY,
].join('\n')

if (DRY) {
  console.log('=== DRY RUN ===')
  console.log('строк на выходе: ' + out.split('\n').length)
} else {
  fs.writeFileSync(OUT, out, 'utf8')
  console.log('[ok]  ' + OUT + ' (' + out.split('\n').length + ' строк)')
  console.log('[ok]  секретов в файле: ' + (/TELEGRAM_FALLBACK|8890938415/.test(out) ? 'ЕСТЬ — ОШИБКА' : 'нет'))
}
