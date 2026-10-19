// Отдел разработки — диспетчер ролей, многопроектный, со своим отделом в каждом
// проекте.
//
// ГДЕ ЧТО ЛЕЖИТ.
//   ~/.dsh/projects.json     — проекты: repo, base, workspace, composeProject,
//                              метки и секция department (включён ли отдел,
//                              расписание, лимиты).
//   ~/.dsh/dev-department.json — только ОБЩИЕ значения по умолчанию для тех
//                              проектов, которые своё не задали: windows,
//                              maxRework, maxAttempts, stuckAfterMinutes.
//
// У каждого проекта СВОЙ отдел: своё расписание, свой старт и завершение смены,
// свои счётчики попыток и доработок, своя сводка в Telegram. Проекты не делят
// между собой ни смену, ни очередь, ни стенд.
//
// Секция department в проекте:
//   "department": {
//     "enabled": true,                        // false — отдел в проекте выключен
//     "windows": [{"start":"13:00","stop":"04:00"}],  // нет — берётся общее
//     "maxRework": 3,                         // нет — берётся общее
//     "maxAttempts": 4,                       // нет — берётся общее
//     "stuckAfterMinutes": 30                 // нет — берётся общее
//   }
//
// Диапазонов работы может быть несколько, каждый может переходить полночь
// (23:00–03:30). Диапазоны — независимые периоды работы: пока открыт любой из
// них, задачи берутся; в промежутке смена проекта завершается (со сводкой), а со
// следующим диапазоном начинается новая. Правило «один тикет за раз» при этом не
// нарушается: если задача ещё в работе, промежуток её не прерывает.
//
// На каждый тикет у роли ровно ОДИН диалог. Доработка после test-failed, возврат
// с код-ревью и повторный тест продолжаются в том же диалоге: у агента уже есть
// ветка, коммиты и разбор прошлого вердикта. Карта диалогов лежит в
// ~/.dsh/dev-department-dialogs.json и переживает перезапуск приложения.
//
// Прогоны идут, пока запущен DSH Desktop. Приложение закрыто — прогонов нет,
// и это ожидаемое поведение, а не сбой.
//
// Конвейер строго по одному тикету НА ПРОЕКТ:
//   ready-for-dev  → диспетчер ставит in-progress и поднимает сессию dev
//   dev            → PR + комментарий, ставит for-code-review, снимает in-progress
//   code-review    → читает PR и код вокруг, пишет замечания в PR
//                    принял    → ready-for-test
//                    не принял → ready-for-dev  (тот же тикет возвращается в dev)
//   tester         → разворачивает ветку, проверяет
//                    прошло  → tested          (цикл закрыт, можно брать следующий)
//                    не прошло → test-failed  (тот же тикет возвращается в dev)
//   Новый тикет проекта не берётся, пока его текущий не получил tested.
//
// Возврат из ревью в доработку считается такой же доработкой, как возврат из
// теста: счётчик доработок у тикета один, иначе пара dev↔code-review может
// качаться бесконечно, потому что каждая сессия двигает метку и обнуляет
// счётчик попыток.
//
// Состояние конвейера живёт В МЕТКАХ GitHub, а не в памяти диспетчера. Поэтому
// перезапуск приложения посередине смены ничего не ломает: подхватывается ровно
// то, на чём остановились.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// ОБЩИЕ значения по умолчанию для проектов, которые своё не задали. Данных
// конкретного проекта здесь нет и быть не должно: они в ~/.dsh/projects.json.
const DEFAULTS = {
  startHour: 0,
  startMinute: 0,
  stopHour: 6,
  stopMinute: 0,
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}

// BOM в начале файла (его пишут редакторы Windows и PowerShell) ломает
// JSON.parse невидимым символом. Реестр — обычный файл, который человек
// правит руками, поэтому читаем его снисходительно.
function stripBom(text) {
  const value = String(text)
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

// "HH:MM" → минуты от полуночи; null, если это не время суток.
function parseClock(value) {
  if (typeof value !== 'string') return null
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function formatClock(minutes) {
  const pad = (n) => String(n).padStart(2, '0')
  return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60)
}

function windowLabel(w) {
  return formatClock(w.start) + '–' + formatClock(w.stop)
}

// Разбор массива диапазонов: [{"start":"13:00","stop":"18:00"}]. Совпадающие
// начало и конец — пустой диапазон: «круглосуточно» задаётся не этим, а двумя
// диапазонами, поэтому такой элемент считается ошибкой.
function parseWindows(raw, at) {
  const problems = []
  if (!Array.isArray(raw) || raw.length === 0) {
    return { windows: null, problems: [at + ': нужен непустой массив диапазонов'] }
  }
  const windows = []
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    const where = at + '[' + index + ']'
    if (!item || typeof item !== 'object') {
      problems.push(where + ': нужен объект с полями start и stop')
      continue
    }
    const start = parseClock(item.start)
    const stop = parseClock(item.stop)
    if (start === null || stop === null) {
      problems.push(where + ': start и stop должны быть временем вида "HH:MM"')
      continue
    }
    if (start === stop) {
      problems.push(where + ': начало и конец совпадают — диапазон получился бы пустым')
      continue
    }
    windows.push({ start, stop })
  }
  return { windows: windows.length > 0 ? windows : null, problems }
}

function intInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

// ── Общие настройки смены ───────────────────────────────────────────────────

function loadConfig() {
  const file = path.join(dshHome(), 'dev-department.json')
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if (error && error.code === 'ENOENT') return { values: { ...DEFAULTS, windows: null }, problem: null }
    return { values: { ...DEFAULTS, windows: null }, problem: 'не читается ' + file + ': ' + (error && error.message ? error.message : String(error)) }
  }
  const values = { ...DEFAULTS }
  const problems = []

  if (raw.maxRework !== undefined) {
    if (Number.isInteger(raw.maxRework) && raw.maxRework >= 1 && raw.maxRework <= 20) values.maxRework = raw.maxRework
    else problems.push('maxRework: нужно целое от 1 до 20')
  }
  if (raw.maxAttempts !== undefined) {
    if (Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1 && raw.maxAttempts <= 20) values.maxAttempts = raw.maxAttempts
    else problems.push('maxAttempts: нужно целое от 1 до 20')
  }
  if (raw.stuckAfterMinutes !== undefined) {
    if (Number.isInteger(raw.stuckAfterMinutes) && raw.stuckAfterMinutes >= 1 && raw.stuckAfterMinutes <= 1440) values.stuckAfterMinutes = raw.stuckAfterMinutes
    else problems.push('stuckAfterMinutes: нужно целое от 1 до 1440')
  }

  // Общее расписание — запасное для проектов, которые своё не задали.
  if (raw.windows !== undefined) {
    const parsed = parseWindows(raw.windows, 'windows')
    for (const problem of parsed.problems) problems.push(problem)
    values.windows = parsed.windows
  } else {
    // Старое одиночное окно startHour–stopHour продолжает работать.
    const takeHour = (key) => {
      if (raw[key] === undefined) return
      if (Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 23) { values[key] = raw[key]; return }
      problems.push(key + ': нужен целый час от 0 до 23')
    }
    const takeMinute = (key) => {
      if (raw[key] === undefined) return
      if (Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 59) { values[key] = raw[key]; return }
      problems.push(key + ': нужно целое число минут от 0 до 59')
    }
    takeHour('startHour')
    takeMinute('startMinute')
    takeHour('stopHour')
    takeMinute('stopMinute')
    const start = values.startHour * 60 + values.startMinute
    const stop = values.stopHour * 60 + values.stopMinute
    if (start === stop) problems.push('начало и конец окна не должны совпадать — окно получилось бы пустым')
    values.windows = [{ start, stop }]
  }

  // Поля, которые переехали в projects.json. Молча игнорировать настройку хуже,
  // чем сказать, что она больше ни на что не влияет.
  for (const legacy of ['repo', 'workspacePath', 'projects']) {
    if (raw[legacy] !== undefined) {
      const where = legacy === 'projects'
        ? 'теперь это поле department.enabled у каждого проекта в ~/.dsh/projects.json'
        : 'переехало в ~/.dsh/projects.json'
      problems.push(legacy + ': ' + where)
    }
  }

  return { values, problem: problems.length > 0 ? problems.join('; ') : null }
}

let config = loadConfig()

// Как часто диспетчер просыпается. Менять только здесь: интервал задаётся при
// запуске плагина.
const TICK_MS = 60 * 1000

// Сессионный пресет разрешений для ролей. В таблице хост-композиции есть ещё
// read-only и workspace-write, но без запросов подтверждения работает только
// danger-full-access: у остальных approval: ask.
const ROLE_PERMISSION_PRESET = 'danger-full-access'

// Пауза после выдачи задачи. prompt() только кладёт сообщение в очередь, и до
// старта хода сессия ещё не «running» — без этой паузы диспетчер счёл бы её
// завершённой и выдал бы вторую задачу поверх первой.
const START_GRACE_MS = 2 * 60 * 1000

// Пауза после сбоя модели. Ход, который провайдер оборвал до первого токена,
// попыткой задачи не считается — иначе один сбой снимает с конвейера живые
// тикеты (так ушёл #136). Но и стучаться в провайдер каждую минуту нельзя:
// пауза растёт с числом подряд идущих сбоев.
const INFRA_BACKOFF_MS = 10 * 60 * 1000
const INFRA_BACKOFF_MAX_MS = 40 * 60 * 1000

// Метки конвейера по умолчанию. Реестр проектов может их переопределить полем
// labels у проекта — тогда работает оно.
const PIPELINE_LABELS = {
  dev: 'ready-for-dev',
  progress: 'in-progress',
  review: 'for-code-review',
  test: 'ready-for-test',
  ok: 'tested',
  failed: 'test-failed',
}

// Причина закрытия смены. Различать важно: окно закрывается само по часам,
// а вручную смену закрывает человек инструментом dev_department_summary.
const FINISH = {
  window: 'окно закрыто',
  manual: 'запрошено вручную',
}

// Отметка времени в местном времени. startedAt хранится в UTC, и в сводке его
// нельзя смешивать с местным окончанием — получался интервал на три часа
// длиннее правды.
function localStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// ── Реестр проектов ─────────────────────────────────────────────────────────

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function readRegistry() {
  const file = path.join(dshHome(), 'projects.json')
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error('не читается реестр проектов ' + file + ': ' + (error && error.message ? error.message : String(error)))
  }
  const projects = (raw && raw.projects) || {}
  const ids = Object.keys(projects)
  if (ids.length === 0) throw new Error('реестр ' + file + ' пуст: в "projects" нет ни одного проекта')
  const defaultId = typeof raw.default === 'string' && raw.default ? raw.default : ids[0]
  return { projects, ids, defaultId }
}

// Один проект вместе с его отделом. Значения, которых проект не задал, берутся
// из общих; problems собирает всё, что помешает отделу работать.
function projectRow(registry, id, shared) {
  const raw = registry.projects[id] || {}
  const dept = (raw && typeof raw.department === 'object' && raw.department) || {}
  const workspace = String(raw.workspace || '')
  const problems = []

  const ownWindows = dept.windows !== undefined ? parseWindows(dept.windows, 'department.windows') : { windows: null, problems: [] }
  for (const problem of ownWindows.problems) problems.push(id + ': ' + problem)
  const windows = ownWindows.windows || shared.windows
  const windowsSource = ownWindows.windows ? 'проект' : (shared.windows ? 'общее' : 'нет')

  const pick = (key, min, max) => {
    if (dept[key] === undefined) return shared[key]
    if (Number.isInteger(dept[key]) && dept[key] >= min && dept[key] <= max) return dept[key]
    problems.push(id + ': department.' + key + ' — нужно целое от ' + min + ' до ' + max)
    return shared[key]
  }

  const enabled = dept.enabled !== false
  if (enabled && !windows) {
    problems.push(id + ': отдел включён, но расписание не задано ни у проекта, ни в общих настройках')
  }

  return {
    id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : id,
    repo: String(raw.repo || ''),
    base: typeof raw.base === 'string' && raw.base ? raw.base : 'main',
    workspace,
    humanClone: typeof raw.humanClone === 'string' ? raw.humanClone : '',
    composeProject: typeof raw.composeProject === 'string' && raw.composeProject ? raw.composeProject : id,
    frontendPort: Number.isInteger(raw.frontendPort) ? raw.frontendPort : 8080,
    apiPort: Number.isInteger(raw.apiPort) ? raw.apiPort : 8001,
    artifacts: typeof raw.artifacts === 'string' && raw.artifacts
      ? raw.artifacts
      : (workspace ? workspace.replace(/[\\/]+$/, '') + '-artifacts' : ''),
    telegram: raw.telegram && typeof raw.telegram === 'object' && raw.telegram.token && raw.telegram.chatId
      ? { token: String(raw.telegram.token), chatId: raw.telegram.chatId }
      : undefined,
    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),
    problems,
    department: {
      enabled,
      windows,
      windowsSource,
      maxRework: pick('maxRework', 1, 20),
      maxAttempts: pick('maxAttempts', 1, 20),
      stuckAfterMinutes: pick('stuckAfterMinutes', 1, 1440),
    },
  }
}

// Проекты, в которых отдел работает, и те, где он выключен. Ошибка реестра или
// неполный проект возвращается как проблема, а не бросается: диспетчер обязан
// остаться живым и сказать, что именно не так.
function loadProjects(shared) {
  let registry
  try {
    registry = readRegistry()
  } catch (error) {
    return { projects: [], disabled: [], problem: error && error.message ? error.message : String(error), defaultId: null }
  }

  const rows = registry.ids.map((id) => projectRow(registry, id, shared))
  const problems = []

  // Две сессии в одном каталоге — верный способ испортить работу друг друга,
  // а резолв проекта по рабочей области становится неоднозначным.
  const byWorkspace = {}
  const clashes = []
  for (const row of rows) {
    if (!row.department.enabled) continue
    const key = normalizePath(row.workspace)
    if (!key) continue
    if (byWorkspace[key]) clashes.push(byWorkspace[key] + ' и ' + row.id)
    else byWorkspace[key] = row.id
  }
  if (clashes.length > 0) problems.push('проекты делят одну рабочую область: ' + clashes.join('; '))

  const usable = []
  for (const row of rows) {
    for (const problem of row.problems) problems.push(problem)
    if (!row.department.enabled) continue
    if (!row.repo) { problems.push(row.id + ': не задан repo — проект пропущен'); continue }
    if (!row.workspace) { problems.push(row.id + ': не задан workspace — проект пропущен'); continue }
    if (!row.department.windows) continue // о причине уже сказано выше
    // Роли работают в git-клоне. Каталога нет или это не клон — проект
    // пропускается с причиной: иначе диспетчер падал бы на этом каждый тик,
    // а агент всё равно не смог бы ни ветвиться, ни коммитить.
    if (!fs.existsSync(row.workspace)) {
      problems.push(row.id + ': рабочая область ' + row.workspace + ' не существует — проект пропущен, сначала склонируйте репозиторий')
      continue
    }
    if (!fs.existsSync(path.join(row.workspace, '.git'))) {
      problems.push(row.id + ': рабочая область ' + row.workspace + ' не является git-клоном — проект пропущен')
      continue
    }
    usable.push(row)
  }

  return {
    projects: usable,
    disabled: rows.filter((row) => !row.department.enabled).map((row) => row.id),
    problem: problems.length > 0 ? problems.join('; ') : null,
    defaultId: registry.defaultId,
  }
}

function readGitHubToken() {
  const file = path.join(dshHome(), 'github.token')
  const token = fs.readFileSync(file, 'utf8').trim()
  if (!token) throw new Error('пустой файл токена: ' + file)
  return token
}

function readTelegramConfig() {
  const file = path.join(dshHome(), 'telegram.json')
  const raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  if (!raw || !raw.token || !raw.chatId) throw new Error('в ' + file + ' нужны поля token и chatId')
  return { token: raw.token, chatId: raw.chatId }
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    let settled = false
    // Как и в инструментах ролей: timeout сокета не спасает от зависшего
    // DNS или соединения, а зависший тик останавливает всю смену.
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('таймаут 30 с: ' + options.method + ' ' + String(options.path).split('?')[0]))
    }, 30000)
    function finish(next, value) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      next(value)
    }
    const req = https.request({
      ...options,
      headers: {
        'User-Agent': 'dsh-dev-department',
        ...(options.headers || {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data.length > 0 ? JSON.parse(data) : null } catch (error) { parsed = null }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          finish(resolve, parsed)
          return
        }
        finish(reject, new Error('HTTP ' + res.statusCode + ': ' + ((parsed && (parsed.message || parsed.description)) || data.slice(0, 200))))
      })
    })
    req.on('error', (error) => finish(reject, new Error('сеть: ' + error.message)))
    req.setTimeout(30000, () => { req.destroy(new Error('таймаут 30 с')) })
    req.end(payload === null ? undefined : payload)
  })
}

// Чтения повторяем: сеть до GitHub отваливалась, и «состояние не
// прочитано» превращалось в ложный вывод, будто задача не движется. Повторяем
// только идемпотентные запросы — повтор POST мог бы создать дубль.
async function github(method, apiPath, body) {
  const token = readGitHubToken()
  const attempts = (method === 'GET' || method === 'DELETE') ? 3 : 1
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request({
        host: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }, body)
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError
}

// Долговечный отчёт: Telegram может быть недоступен, а сводку за смену надо
// сохранить в любом случае.
function appendShiftLog(text) {
  try {
    fs.appendFileSync(path.join(dshHome(), 'dev-department.log'), '\n===== ' + new Date().toISOString() + ' =====\n' + text + '\n')
  } catch (error) {
    // журнал не должен ломать смену
  }
}

// Карта диалогов: 'проект:роль:номер тикета' → id сессии. Без неё каждая
// доработка и каждый повторный тест открывали новый диалог, и агент начинал с
// нуля. Номер тикета уникален только внутри проекта, поэтому проект входит в
// ключ: у vahta #52 и у brain #52 — разные задачи.
function dialogsFile() {
  return path.join(dshHome(), 'dev-department-dialogs.json')
}

function readDialogs() {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(dialogsFile(), 'utf8')))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const map = {}
    for (const key of Object.keys(raw)) {
      if (typeof raw[key] === 'string' && raw[key] !== '') map[key] = raw[key]
    }
    return map
  } catch (error) {
    return {}
  }
}

function writeDialogs(map) {
  try {
    fs.writeFileSync(dialogsFile(), JSON.stringify(map, null, 2))
  } catch (error) {
    // Карта не должна ломать смену: в худшем случае заведётся новый диалог.
  }
}

async function sendTelegram(bot, text) {
  const { token, chatId } = bot
  const chunks = []
  let rest = String(text)
  while (rest.length > 4000) {
    chunks.push(rest.slice(0, 4000))
    rest = rest.slice(4000)
  }
  if (rest.length > 0) chunks.push(rest)
  for (const chunk of chunks) {
    // Канал до api.telegram.org нестабилен, поэтому пробуем несколько раз: одна
    // сетевая заминка не должна стоить утренней сводки.
    let lastError
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await request({
          host: 'api.telegram.org',
          path: '/bot' + token + '/sendMessage',
          method: 'POST',
        }, { chat_id: chatId, text: chunk })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
      }
    }
    if (lastError) throw new Error('после 4 попыток: ' + lastError.message)
  }
}

function labelsOf(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
}

function has(issue, name) {
  return labelsOf(issue).indexOf(name) !== -1
}

function newSessionId() {
  const rnd = (n) => {
    let s = ''
    for (let i = 0; i < n; i += 1) s += Math.floor(Math.random() * 16).toString(16)
    return s
  }
  return 'session-' + rnd(8) + '-' + rnd(4) + '-4' + rnd(3) + '-a' + rnd(3) + '-' + rnd(12)
}

function dateKey(date) {
  return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate()
}

// Время считаем в минутах от начала суток: диапазон 23:00–03:30 часами не
// выразить.
function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function windowsLabel(windows) {
  return (windows || []).map(windowLabel).join(', ')
}

// Диапазон может переходить полночь: 23:00–03:30, поэтому проверяем и «после
// старта вечером», и «до конца ночью».
function windowContains(w, minute) {
  return w.start < w.stop ? (minute >= w.start && minute < w.stop) : (minute >= w.start || minute < w.stop)
}

// Открытый сейчас диапазон: он и говорит, какой смене принадлежит момент и
// можно ли вообще брать задачи. Если диапазоны пересекаются, берём первый по
// порядку в конфиге.
function openWindow(windows, date) {
  const minute = minutesOfDay(date)
  for (const w of windows || []) {
    if (windowContains(w, minute)) return w
  }
  return null
}

function inWindow(windows, date) {
  return openWindow(windows, date) !== null
}

// Ключ смены — дата её НАЧАЛА, а не окончания. Иначе смена, начавшаяся в 23:00
// и закончившаяся в 03:30 следующего дня, считалась бы сменой нового дня, и
// вечерняя смена этого дня не запустилась бы вовсе.
function shiftKey(windows, date) {
  const w = openWindow(windows, date) || (windows && windows[0])
  const d = new Date(date.getTime())
  if (w && w.start > w.stop && minutesOfDay(d) < w.stop) d.setDate(d.getDate() - 1)
  return dateKey(d)
}

// Ближайшее открытие диапазона: нужно, чтобы в статусе было видно, чего ждать,
// когда работы сейчас нет.
function nextWindowStart(windows, date) {
  const minute = minutesOfDay(date)
  let best = null
  for (const w of windows || []) {
    const dayOffset = w.start > minute ? 0 : 1
    const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset,
      Math.floor(w.start / 60), w.start % 60, 0, 0)
    if (best === null || candidate.getTime() < best.getTime()) best = candidate
  }
  return best
}

export default {
  // Явные зависимости: записи из cordis.patch.yml применяются раньше, чем
  // бандлы публикуют сервисы. Без inject плагин стартует в пустом окружении
  // и молча ничего не делает — на этом уже один раз обожглись.
  inject: ['timer', 'tools', 'agents', 'sessions', 'agentPresets', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'sessionTitle'],

  apply(ctx) {
    const timer = ctx.get('timer')
    const tools = ctx.get('tools')
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const agentPresets = ctx.get('agentPresets')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const sessionController = ctx.get('sessionController')
    const permissionPresets = ctx.get('permissionPresets')
    const sessionTitle = ctx.get('sessionTitle')

    const missing = []
    if (!timer) missing.push('timer')
    if (!tools) missing.push('tools')
    if (!agents) missing.push('agents')
    if (!sessions) missing.push('sessions')
    if (!agentPresets) missing.push('agentPresets')
    if (!workspaceRegistry) missing.push('workspaceRegistry')
    if (!sessionController) missing.push('sessionController')
    if (!permissionPresets) missing.push('permissionPresets')
    if (!sessionTitle) missing.push('sessionTitle')
    if (missing.length > 0) {
      throw new Error('отдел разработки: недоступны сервисы ' + missing.join(', '))
    }

    // Состояние. У КАЖДОГО проекта свой отдел: своя смена, свой её ключ, своя
    // активная сессия и свои счётчики. Общего state.run здесь больше нет.
    const state = {
      projects: {},       // id → { run, lastShiftKey, session, rework, attempts }
      dialogs: readDialogs(), // 'проект:роль:номер' → id диалога, который ведёт этот тикет
      projectProblem: null,
      servedIds: [],
      disabledIds: [],
      lastError: null,
      lastTickAt: null,
    }

    function projectState(id) {
      if (!state.projects[id]) {
        state.projects[id] = { run: null, lastShiftKey: null, session: null, rework: {}, attempts: {}, infraFails: 0, backoffUntil: null }
      }
      return state.projects[id]
    }

    // Диалоги прежней однопроектной версии лежали под ключом 'роль:номер'. После
    // перехода ключ включает проект, поэтому переносим старые записи на проект по
    // умолчанию: диалог, начатый до перехода, должен продолжиться вместе со своей
    // веткой и коммитами, а не пропасть.
    try {
      const registry = readRegistry()
      let migrated = false
      for (const key of Object.keys(state.dialogs)) {
        if (!/^(dev|tester|analyst):[0-9]+$/.test(key)) continue
        const next = registry.defaultId + ':' + key
        if (!state.dialogs[next]) state.dialogs[next] = state.dialogs[key]
        delete state.dialogs[key]
        migrated = true
      }
      if (migrated) writeDialogs(state.dialogs)
    } catch (error) {
      // Реестр недоступен — миграция повторится при следующем запуске.
    }

    // ── чтение состояния из GitHub ─────────────────────────────────────────

    async function loadIssues(project) {
      const query = '/repos/' + project.repo + '/issues?state=open&per_page=100&sort=created&direction=asc'
      const rows = await github('GET', query)
      return rows.filter((i) => !i.pull_request)
    }

    async function reload(project, number) {
      return github('GET', '/repos/' + project.repo + '/issues/' + number)
    }

    // Единственный «активный» тикет проекта: сначала тот, что ждёт код-ревью,
    // затем ждущий тестировщика, затем отклонённый, затем взятый, но не доведённый.
    // Ревью стоит выше теста: оно раньше в конвейере, и тикет, помеченный обоими
    // (ревьюер принял, но метку не снял), должен доехать до ревью, а не проскочить.
    async function findActive(project, issues) {
      const L = project.labels
      const waitingReview = issues.filter((i) => has(i, L.review))
      if (waitingReview.length > 0) return { role: 'code-review', issue: waitingReview[0], kind: 'review' }
      const waitingTest = issues.filter((i) => has(i, L.test))
      if (waitingTest.length > 0) return { role: 'tester', issue: waitingTest[0] }
      const failedTest = issues.filter((i) => has(i, L.failed))
      if (failedTest.length > 0) return { role: 'dev', issue: failedTest[0], kind: 'rework' }
      const taken = issues.filter((i) => has(i, L.progress))
      if (taken.length > 0) return { role: 'dev', issue: taken[0], kind: 'continue' }
      return null
    }

    function queuedOf(project, issues) {
      const L = project.labels
      return issues.filter((i) => has(i, L.dev)
        && !has(i, L.progress) && !has(i, L.review) && !has(i, L.test) && !has(i, L.ok) && !has(i, L.failed))
    }

    function pickQueued(project, issues) {
      const queued = queuedOf(project, issues)
      return queued.length > 0 ? queued[0] : null
    }

    // ── запуск сессий ролей ────────────────────────────────────────────────

    // Сессия считается работающей, только если у неё идёт ход. Агент остаётся в
    // реестре и после завершения хода, поэтому проверка живости агента врёт —
    // на этом диспетчер уже один раз встал намертво, не взяв следующий тикет.
    async function sessionActivity(sessionId) {
      try {
        const value = await sessionController.list({}, new AbortController().signal)
        const items = (value && value.items) || []
        const row = items.filter((i) => i.sessionId === sessionId)[0]
        if (!row) return { running: false, idleMs: null }
        const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : null
        return { running: !!row.running, idleMs: updatedAt === null ? null : Date.now() - updatedAt }
      } catch (error) {
        // Список недоступен — лучше подождать дольше, чем выдать вторую задачу
        // поверх незаконченной.
        return { running: agents.get(sessionId) !== undefined, idleMs: null }
      }
    }

    function infraBackoffMs(fails) {
      return Math.min(INFRA_BACKOFF_MS * Math.pow(2, Math.min(fails, 2)), INFRA_BACKOFF_MAX_MS)
    }

    // Ход, который провайдер оборвал, не сделав ни шага: ответа модели нет,
    // вызовов инструмента нет, работы не было. Читаем хвост стенограммы через
    // follow — это последние сообщения, а не вся история сессии.
    // Возвращает причину сбоя или null, если судить не о чем.
    async function failedTurnWithoutWork(sessionId) {
      try {
        const stream = sessionController.follow(
          { address: { kind: 'session', sessionId }, maxMessages: 30 },
          new AbortController().signal,
        )
        let snapshot = null
        for await (const frame of stream) { snapshot = frame; break }
        const records = (snapshot && snapshot.records) || []
        const events = records.map((r) => r && r.event).filter((e) => e && typeof e.type === 'string')
        let endIndex = -1
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].type === 'turn/end') { endIndex = i; break }
        }
        if (endIndex === -1) return null
        const reason = (events[endIndex].data && events[endIndex].data.reason) || {}
        if (reason.kind !== 'error') return null
        // Начало хода могло не попасть в окно — тогда не судим.
        let startIndex = -1
        for (let i = endIndex - 1; i >= 0; i -= 1) {
          if (events[i].type === 'turn/start') { startIndex = i + 1; break }
        }
        if (startIndex === -1) return null
        for (let i = startIndex; i < endIndex; i += 1) {
          if (events[i].type === 'tool/call' || events[i].type === 'assistant/message') return null
        }
        return { message: (reason.error && reason.error.message) || 'ход завершился ошибкой' }
      } catch (error) {
        // Хвост не прочитался — считаем попытку как обычно: строгий учёт лучше
        // бесконечных повторов одной и той же задачи.
        return null
      }
    }

    // Имя диалога: проект + роль + номер тикета + короткий заголовок. Без этого
    // в списке сессий непонятно, какая из них чем занята.
    function titleFor(project, presetId, issue) {
      const role = presetId === 'dev' ? 'Разработчик'
        : presetId === 'tester' ? 'Тестировщик'
          : presetId === 'code-review' ? 'Код-ревьюер'
            : presetId
      const flat = String((issue && issue.title) || '').replace(/\s+/g, ' ').trim()
      const clipped = flat.length > 60 ? flat.slice(0, 57) + '…' : flat
      const head = role + ' [' + project.id + '] #' + issue.number
      return clipped ? head + ' — ' + clipped : head
    }

    function dialogKey(project, presetId, issueNumber) {
      return project.id + ':' + presetId + ':' + issueNumber
    }

    function existingDialog(project, presetId, issueNumber) {
      return state.dialogs[dialogKey(project, presetId, issueNumber)] || null
    }

    function forgetDialog(project, presetId, issueNumber) {
      const key = dialogKey(project, presetId, issueNumber)
      if (state.dialogs[key]) {
        delete state.dialogs[key]
        writeDialogs(state.dialogs)
      }
    }

    // Диалог прошлых смен живёт в файле, а его сессия — в хранилище сессий.
    // Проверяем, что сессия ещё есть: удалённую вручную оживлять не нужно.
    async function dialogIsResumable(sessionId) {
      try {
        if (sessions.get(sessionId)) return true
      } catch (error) {
        // реестр мог не знать эту сессию — проверим через контроллер
      }
      try {
        await sessionController.inspect(sessionId)
        return true
      } catch (error) {
        return false
      }
    }

    // requestId должен быть новым на каждый запрос: у одного диалога теперь
    // много заданий, а повторный id может быть отброшен как дубль. Одного
    // счётчика мало: после перезапуска приложения он начинается заново, и
    // продолжение диалога получило бы id, который уже выдавался до перезапуска.
    async function promptSession(sessionId, prompt) {
      const token = Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 8)
      await sessionController.prompt({
        requestId: 'dev-department-' + sessionId + '-' + token,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, new AbortController().signal)
    }

    // Рабочая область проекта: это клон агента, а не клон человека. Если каталог
    // в реестре поменяли, а в реестре рабочих областей его ещё нет — заводим
    // сами: иначе смена упадёт на выдаче самой первой задачи.
    async function projectWorkspace(project) {
      const wanted = project.workspace
      const existing = await workspaceRegistry.resolveByPath(wanted)
      if (existing) return existing
      return workspaceRegistry.create(wanted, project.title + ' — отдел')
    }

    async function startSession(project, presetId, prompt, issue) {
      const key = dialogKey(project, presetId, issue.number)
      const known = state.dialogs[key]
      if (known && await dialogIsResumable(known)) {
        // Продолжаем тот же диалог, а не начинаем с нуля.
        try {
          await promptSession(known, prompt)
          return known
        } catch (error) {
          // Диалог не ожил — смену не срываем, заводим новый.
          state.lastError = 'продолжение диалога ' + known + ': ' + (error && error.message ? error.message : String(error))
          delete state.dialogs[key]
          writeDialogs(state.dialogs)
        }
      }
      const workspace = await projectWorkspace(project)
      const sessionId = newSessionId()
      await agents.create({
        sessionId,
        meta: { cwd: workspace.path, agentPreset: presetId },
        setup: async (agentCtx) => { await agentPresets.mount(agentCtx, presetId) },
      })
      await workspace.attachSession(sessionId)
      // Явный заголовок закрепляется: автоматический, сгенерированный по первому
      // сообщению, его уже не перезапишет.
      try {
        const named = sessions.get(sessionId)
        if (named) sessionTitle.rename(named, titleFor(project, presetId, issue))
      } catch (error) {
        state.lastError = 'заголовок сессии: ' + (error && error.message ? error.message : String(error))
      }
      // Разрешения роли: без этого прогон упрётся в запрос подтверждения,
      // который подтверждать некому.
      try {
        const roleSession = sessions.get(sessionId)
        if (roleSession) permissionPresets.set(roleSession, ROLE_PERMISSION_PRESET)
      } catch (error) {
        state.lastError = 'разрешения роли: ' + (error && error.message ? error.message : String(error))
      }
      state.dialogs[key] = sessionId
      writeDialogs(state.dialogs)
      await promptSession(sessionId, prompt)
      return sessionId
    }

    // Значения проекта подставляются в задание дословно: агент не должен
    // угадывать репозиторий и ветку, даже если сам не вызовет project_info.
    function projectHeader(project) {
      return 'Проект ' + project.id + ' (' + project.title + '): репозиторий ' + project.repo +
        ', базовая ветка ' + project.base + ', рабочая копия отдела ' + project.workspace +
        ', compose-проект ' + project.composeProject + '.'
    }

    function devPrompt(project, issue, kind, repeat) {
      const L = project.labels
      // Возврат в доработку бывает из теста и из код-ревью. Различаем по метке:
      // от теста остаётся test-failed, от ревьюера — ready-for-dev.
      const reworkWhy = kind !== 'rework'
        ? null
        : (has(issue, L.failed)
          ? 'тестировщик вернул его с меткой ' + L.failed
          : 'код-ревьюер вернул его с меткой ' + L.dev)
      const lines = [
        kind === 'rework'
          ? 'Отдел разработки: доработай issue #' + issue.number + ' «' + issue.title + '» — ' + reworkWhy + '.'
          : kind === 'continue'
            ? 'Отдел разработки: продолжи issue #' + issue.number + ' «' + issue.title + '» — он уже помечен ' + L.progress + ', то есть работа начата, но не доведена.'
            : 'Отдел разработки: возьми issue #' + issue.number + ' «' + issue.title + '».',
        '',
        projectHeader(project),
        'Действуй по скиллу dev-workflow: прочитай issue через gh_issue, работай в ветке feature/' + issue.number + '-<слаг> от ' + project.base + ', доведи до pull request и передай на код-ревью.',
        'Обязательный финал: комментарий в issue (что сделано, ветка, номер PR, что не проверено), затем метка ' + L.review + ' и снятие ' + L.progress + '.',
        'В ' + project.base + ' и main не коммить. PR не мержить. Работай только в своей рабочей копии отдела ' + project.workspace +
          (project.humanClone ? ': в клон человека ' + project.humanClone + ' не заходить вообще.' : '.'),
        'Стенд поднимай только со своим именем проекта: docker compose -p ' + project.composeProject +
          ' ... Без -p docker возьмёт имя из docker-compose.yml и ты задешь стенд человека на его портах и его базе.',
        'После PR обязательно верни рабочую копию на ' + project.base + ': git checkout ' + project.base +
          ', затем git pull --ff-only. Незакоммиченных изменений в клоне остаться не должно.',
        'Поставь себе цель, чтобы довести работу до конца: один ход не должен обрывать задачу на середине.',
        'Если упёрся в то, что сам решить не можешь, — напиши это комментарием в issue и остановись.',
      ]
      if (kind === 'rework') lines.splice(2, 0, 'Начни с комментариев в issue и в PR этого тикета: там причина отказа, замечания и воспроизводящая команда.')
      if (kind === 'continue') lines.splice(2, 0, 'Сначала посмотри, что уже сделано: ветка могла остаться, коммиты могли быть запушены, в issue может быть комментарий.')
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, в котором шла работа по тикету: ветка, коммиты и замечания ревьюера или тестировщика уже в его истории — продолжай с этого места, заново ничего не поднимай.')
      return lines.join('\n')
    }

    function testerPrompt(project, issue, repeat) {
      const L = project.labels
      const lines = [
        (repeat ? 'Отдел разработки: ПОВТОРНО проверь issue #' : 'Отдел разработки: проверь issue #') + issue.number + ' «' + issue.title + '» (метка ' + L.test + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу testing-contract: найди PR через gh_prs({ "issue": ' + issue.number + ' }), посмотри изменённые файлы через gh_pr({ "number": <номер PR>, "files": true }), разверни ветку через git worktree в отдельный каталог.',
        'Проверяй сам, а не по описанию из PR. Артефакты клади в ' + (project.artifacts || 'reports/') + '.',
        'Стенд поднимай только со своим именем проекта: docker compose -p ' + project.composeProject +
          ' ... Без -p docker возьмёт имя из docker-compose.yml и ты задешь стенд человека на его портах и его базе.',
        'Вердикт — комментарий в issue: прошло — метка ' + L.ok + '; не прошло — ' + L.failed + ' и наименьшая воспроизводящая команда.',
        'Продуктовый код и PR не править, PR не мержить. Поставь себе цель, чтобы довести проверку до конца.',
      ]
      if (repeat) {
        lines.splice(2, 0, 'Это тот же диалог, где ты уже проверял этот тикет: тикет возвращался в доработку. Сверься со своим прошлым вердиктом в комментариях и проверь в первую очередь то, что тогда сломалось.')
        lines.push('Если прошлый дефект исправлен и новых нет — метка ' + L.ok + '.')
      }
      return lines.join('\n')
    }

    // Код-ревьюер: читает PR и код вокруг него, замечания пишет в PR, а решение
    // отдаёт меткой. Продуктовый код он не правит и стенд не поднимает.
    function reviewPrompt(project, issue, repeat) {
      const L = project.labels
      const lines = [
        (repeat ? 'Отдел разработки: ПОВТОРНО проверь код по issue #' : 'Отдел разработки: проверь код по issue #') + issue.number + ' «' + issue.title + '» (метка ' + L.review + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу code-review: найди PR через gh_prs({ "issue": ' + issue.number + ' }), прочитай изменённые файлы через gh_pr({ "number": <номер PR>, "files": true }), затем сам дифф и код вокруг него в рабочей копии отдела ' + project.workspace + '.',
        'Замечания оставляй комментариями В PR: gh_pr_comment({ "number": <номер PR>, "body": "<вопрос>\\n\\npath:line — случай — минимальная правка" }). По одному комментарию на замечание, чтобы автор мог ответить точечно.',
        'Решение — меткой: принял → ' + L.test + ' и снять ' + L.review + '; нужны правки → ' + L.dev + ' и снять ' + L.review + ', плюс короткий комментарий в issue, что именно вернул.',
        'Продуктовый код не править, PR не мержить, стенд не поднимать — прогон и приёмочные слои принадлежат тестировщику.',
        'В ' + project.base + ' и main не коммитить и не переключать ветки в рабочей копии: ревью читает, а не строит.' +
          (project.humanClone ? ' В клон человека ' + project.humanClone + ' не заходить.' : ''),
        'Поставь себе цель, чтобы довести ревью до конца: тикет не должен остаться без метки.',
      ]
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже ревьюил этот тикет: твои прошлые замечания и правки разработчика в его истории — проверь в первую очередь то, что тогда вернул.')
      return lines.join('\n')
    }

    // ── один шаг диспетчера по проекту ─────────────────────────────────────

    async function dispatch(project, decision) {
      const st = projectState(project.id)
      const L = project.labels
      const { role, issue, rework } = decision
      const attempts = (st.attempts[issue.number] || 0) + 1
      st.attempts[issue.number] = attempts
      if (attempts > project.department.maxAttempts) {
        // Задача выдавалась несколько раз и ни разу не сдвинулась: молча
        // падающая сессия не должна крутить попытки без остановки.
        await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/comments', {
          body: 'Отдел разработки: задача выдавалась ' + (attempts - 1) + ' раз(а) и не сдвинулась — снимаю с конвейера, нужен человек.',
        })
        for (const name of [L.progress, L.review, L.failed, L.test]) {
          try {
            await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(name))
          } catch (error) { /* метки могло и не быть */ }
        }
        forgetDialog(project, 'dev', issue.number)
        forgetDialog(project, 'tester', issue.number)
        forgetDialog(project, 'code-review', issue.number)
        st.run.entries.push({ number: issue.number, title: issue.title, role: role, outcome: 'снят с конвейера после ' + (attempts - 1) + ' попыток без результата' })
        return { action: 'dropped', project: project.id, issue: issue.number, reason: 'no progress after ' + (attempts - 1) + ' attempts' }
      }
      if (role === 'dev') {
        const kind = decision.kind || 'new'
        const rounds = st.rework[issue.number] || 0
        if (kind === 'rework' && rounds >= project.department.maxRework) {
          await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/comments', {
            body: 'Отдел разработки: тикет возвращался из код-ревью или теста ' + rounds + ' раз(а) и снят с конвейера — нужен человек.',
          })
          for (const name of [L.progress, L.review, L.failed]) {
            try {
              await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(name))
            } catch (error) { /* метки могло и не быть */ }
          }
          forgetDialog(project, 'dev', issue.number)
          forgetDialog(project, 'tester', issue.number)
          forgetDialog(project, 'code-review', issue.number)
          st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера после ' + rounds + ' доработок' })
          return { action: 'dropped', project: project.id, issue: issue.number, reason: 'too many rework rounds' }
        }
        if (kind === 'rework') st.rework[issue.number] = rounds + 1
        // Захват нормализуем здесь, а не в агенте: у конвейера должен оставаться
        // ровно один активный маркер, иначе следующий шаг неоднозначен.
        if (kind === 'new' || kind === 'rework') {
          await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/labels', { labels: [L.progress] })
          // Возврат из ревью приходит с ready-for-dev, из теста — с test-failed;
          // снимаем обе, чтобы на тикете не осталось чужого шага.
          for (const name of [L.dev, L.failed, L.review]) {
            try {
              await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(name))
            } catch (error) { /* метки могло и не быть */ }
          }
        }
        const sessionId = await startSession(project, 'dev', devPrompt(project, issue, kind, !!existingDialog(project, 'dev', issue.number)), issue)
        st.session = { role: 'dev', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'dev', issue: issue.number, sessionId }
      }

      if (role === 'code-review') {
        const sessionId = await startSession(project, 'code-review', reviewPrompt(project, issue, !!existingDialog(project, 'code-review', issue.number)), issue)
        st.session = { role: 'code-review', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'code-review', issue: issue.number, sessionId }
      }

      const sessionId = await startSession(project, 'tester', testerPrompt(project, issue, !!existingDialog(project, 'tester', issue.number)), issue)
      st.session = { role: 'tester', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
      st.run.sessions = (st.run.sessions || 0) + 1
      return { action: 'dispatched', project: project.id, role: 'tester', issue: issue.number, sessionId }
    }

    // Смена проекта: своё расписание, свой ключ, своя сводка.
    async function stepProject(project, opts, now) {
      const st = projectState(project.id)
      const L = project.labels
      const windows = project.department.windows
      const inWin = inWindow(windows, now)

      // Смена начинается сама в окне и только один раз на смену.
      if (!st.run && inWin && st.lastShiftKey !== shiftKey(windows, now)) {
        st.lastShiftKey = shiftKey(windows, now)
        st.attempts = {} // попытки не переезжают из смены в смену
        st.run = { startedAt: now.toISOString(), entries: [], sessions: 0 }
      }
      // Ручной шаг вне окна: заводим одноразовую смену, иначе раздача задачи
      // упадёт на обращении к журналу смены.
      if (!st.run && opts.ignoreWindow) {
        st.run = { startedAt: now.toISOString(), entries: [], sessions: 0, manual: true }
      }
      if (!st.run) return null

      // Провайдер сорвал ход — не бьёмся в него каждую минуту.
      if (!st.session && st.backoffUntil && now.getTime() < st.backoffUntil) {
        return {
          action: 'backoff',
          project: project.id,
          until: new Date(st.backoffUntil).toISOString(),
          minutesLeft: Math.ceil((st.backoffUntil - now.getTime()) / 60000),
        }
      }

      // Роль ещё работает — ждём, ничего не раздаём.
      if (st.session) {
        const waitedMs = now.getTime() - Date.parse(st.session.startedAt)
        const activity = await sessionActivity(st.session.sessionId)
        const stuckAfterMs = project.department.stuckAfterMinutes * 60 * 1000
        const stuckMs = activity.running && activity.idleMs !== null && activity.idleMs > stuckAfterMs
          ? activity.idleMs
          : null
        // Сессия «работает», но давно ничего не записала: ход завис. Снимаем
        // его и идём дальше, иначе очередь не двинется никогда.
        if (stuckMs !== null) {
          const stuck = st.session
          st.session = null
          let cancelled = false
          try {
            await sessionController.cancel({ sessionId: stuck.sessionId })
            cancelled = true
          } catch (error) {
            state.lastError = 'снятие зависшего хода: ' + (error && error.message ? error.message : String(error))
          }
          st.run.entries.push({
            number: stuck.issue,
            title: stuck.title,
            role: stuck.role,
            outcome: 'ход завис (' + Math.round(stuckMs / 60000) + ' мин без записей) — снят' + (cancelled ? '' : ', снять не удалось'),
          })
          return { action: 'stuck', project: project.id, issue: stuck.issue, sessionId: stuck.sessionId, idleMinutes: Math.round(stuckMs / 60000), cancelled }
        }
        if (activity.running || waitedMs < START_GRACE_MS) {
          return {
            action: 'waiting',
            project: project.id,
            role: st.session.role,
            issue: st.session.issue,
            sessionId: st.session.sessionId,
            running: activity.running,
            waitedMs,
          }
        }
        const finished = st.session
        st.session = null

        // Ход не начался по вине провайдера — задаче эту попытку не отдаём.
        const infraFailure = await failedTurnWithoutWork(finished.sessionId)
        if (infraFailure !== null) {
          st.attempts[finished.issue] = Math.max(0, (st.attempts[finished.issue] || 1) - 1)
          const backoff = infraBackoffMs(st.infraFails || 0)
          st.infraFails = (st.infraFails || 0) + 1
          st.backoffUntil = now.getTime() + backoff
          state.lastError = project.id + ': сбой модели: ' + infraFailure.message
          st.run.entries.push({
            number: finished.issue,
            title: finished.title,
            role: finished.role,
            outcome: 'ход не начался (сбой модели: ' + infraFailure.message + ') — попытка не засчитана, пауза ' + Math.round(backoff / 60000) + ' мин',
          })
          return {
            action: 'provider-error',
            project: project.id,
            issue: finished.issue,
            message: infraFailure.message,
            backoffMinutes: Math.round(backoff / 60000),
          }
        }
        st.infraFails = 0
        try {
          const issue = await reload(project, finished.issue)
          const marks = labelsOf(issue)
          const outcome = marks.indexOf(L.ok) !== -1 ? 'принято тестировщиком'
            : marks.indexOf(L.failed) !== -1 ? 'возвращено в доработку'
              : marks.indexOf(L.review) !== -1 ? 'ждёт код-ревью'
                : marks.indexOf(L.test) !== -1 ? 'ждёт тестировщика'
                  // Ревьюер вернул тикет разработчику: метка снова ready-for-dev.
                  // Это движение по конвейеру, а не «без изменения меток».
                  : finished.role === 'code-review' && marks.indexOf(L.dev) !== -1 ? 'код-ревьюер вернул в доработку'
                    : 'без изменения меток'
          // Тикет принят — диалоги по нему закрыты.
          if (outcome === 'принято тестировщиком') {
            forgetDialog(project, 'dev', finished.issue)
            forgetDialog(project, 'tester', finished.issue)
            forgetDialog(project, 'code-review', finished.issue)
          }
          // Метки сдвинулись — задача движется, счётчик попыток обнуляем.
          if (outcome !== 'без изменения меток') st.attempts[finished.issue] = 0
          st.run.entries.push({ number: finished.issue, title: finished.title, role: finished.role, outcome, sessionId: finished.sessionId })
          return { action: 'finished-session', project: project.id, issue: finished.issue, outcome }
        } catch (error) {
          state.lastError = String(error.message)
          // Состояние не прочитано — это сбой на нашей стороне, а не провал
          // задачи. Снимаем попытку, иначе сеть «съедает» тикет как нерабочий.
          st.attempts[finished.issue] = Math.max(0, (st.attempts[finished.issue] || 1) - 1)
          st.run.entries.push({ number: finished.issue, title: finished.title, role: finished.role, outcome: 'состояние не прочитано: ' + error.message })
          return { action: 'error', project: project.id, issue: finished.issue, message: error.message }
        }
      }

      const issues = await loadIssues(project)
      const active = await findActive(project, issues)
      if (active) return dispatch(project, active)

      // Активного тикета нет — можно взять следующий, но только пока открыт
      // хотя бы один диапазон работы.
      if (inWin || opts.ignoreWindow) {
        const queued = pickQueued(project, issues)
        // Тикет вернулся с код-ревью: метка ready-for-dev, но диалог разработки
        // по нему уже был. Это доработка, а не новая задача — иначе пара
        // dev↔code-review качалась бы без ограничения.
        if (queued) {
          const kind = existingDialog(project, 'dev', queued.number) ? 'rework' : 'new'
          return dispatch(project, { role: 'dev', issue: queued, kind: kind })
        }
        return null
      }

      // Вне окна и делать нечего: смена проекта закрыта. Незаконченная работа к
      // этому моменту уже доведена — до этой точки доходит только пустой конвейер.
      await finishProjectShift(project, now, FINISH.window)
      return { action: 'finished-shift', project: project.id }
    }

    async function step(options) {
      const opts = options || {}
      config = loadConfig()
      const now = new Date()
      state.lastTickAt = now.toISOString()

      const loaded = loadProjects(config.values)
      state.projectProblem = loaded.problem
      state.servedIds = loaded.projects.map((p) => p.id)
      state.disabledIds = loaded.disabled
      if (loaded.problem) state.lastError = 'проекты: ' + loaded.problem

      if (loaded.projects.length === 0) {
        return { action: 'config-error', note: loaded.problem || 'нет ни одного проекта с включённым отделом', projects: [] }
      }

      // Каждый проект двигается своим шагом и своей сменой. Ошибка одного
      // проекта не должна останавливать остальные: у них разные репозитории и
      // разные сети.
      const actions = []
      for (const project of loaded.projects) {
        try {
          const result = await stepProject(project, opts, now)
          if (result) actions.push(result)
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          state.lastError = project.id + ': ' + message
          actions.push({ action: 'error', project: project.id, message })
        }
      }

      return {
        action: actions.length === 1 ? actions[0].action : 'tick',
        projects: actions,
        disabled: loaded.disabled,
        shifts: loaded.projects
          .map((p) => ({ id: p.id, run: projectState(p.id).run ? projectState(p.id).run.startedAt : null }))
          .filter((s) => s.run),
      }
    }

    // Сводка одного проекта. Своя смена — своя сводка: у проектов разные
    // расписания, и общий отчёт по всем запутывал бы больше, чем сообщал.
    async function finishProjectShift(project, now, reason) {
      const st = projectState(project.id)
      const run = st.run
      st.run = null
      // Ключ смены записан в момент её старта и по умолчанию остаётся: так
      // смена не запускается второй раз за сутки. Но если смена закончилась
      // сама вместе с окном, ключ снимаем. Окно могло закрыться и снова
      // открыться, пока приложение работало (оператор поправил часы), и тогда
      // диспетчер обязан снова брать задачи, а не стоять до утра с открытым
      // окном и готовым ready-for-dev тикетом. Ручное закрытие
      // (dev_department_summary) ключ сохраняет: это команда человека, а не
      // следствие часов.
      if (reason !== FINISH.manual) st.lastShiftKey = null

      const dept = project.department
      const lines = ['🛠 Отдел разработки [' + project.id + ']: ' +
        (run ? localStamp(new Date(run.startedAt)) : '—') + ' → ' + now.toTimeString().slice(0, 5) + ' (' + reason + ')']
      lines.push('Репозиторий: ' + project.repo + ', базовая ветка: ' + project.base + '.')
      lines.push('Расписание (' + dept.windowsSource + '): ' + windowsLabel(dept.windows) +
        ', лимит доработок: ' + dept.maxRework + ', попыток на задачу: ' + dept.maxAttempts + '.')
      const sessions = (run && run.sessions) || 0
      lines.push('Сессий запущено: ' + sessions + '.')
      if (run && run.entries.length > 0) {
        lines.push('')
        for (const entry of run.entries) {
          lines.push('• #' + entry.number + ' ' + entry.title + ' — ' + entry.role + ': ' + entry.outcome)
        }
      } else {
        lines.push('Работы не было: подходящих тикетов не нашлось.')
      }
      if (state.lastError) lines.push('\n⚠️ Последняя ошибка: ' + state.lastError)
      const summaryText = lines.join('\n')
      // Сводку сначала кладём на диск: канал до Telegram бывает недоступен, и
      // терять отчёт за смену из-за этого нельзя.
      appendShiftLog(summaryText)
      try {
        // Сводка проекта уходит боту ЭТОГО проекта; общий — запасной путь.
        const bot = project.telegram || readTelegramConfig()
        await sendTelegram(bot, summaryText)
      } catch (error) {
        state.lastError = 'Telegram: ' + error.message
      }
      return summaryText
    }

    // ── инструменты для ручной проверки ────────────────────────────────────

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

    const statusTool = define(
      'dev_department_status',
      'Состояние отдела разработки: какие проекты обслуживаются, в каких отдел выключен, у какого проекта идёт смена и по какому расписанию, что сейчас в конвейере каждого по меткам GitHub и что будет следующим шагом.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        config = loadConfig()
        const now = new Date()
        const loaded = loadProjects(config.values)
        state.projectProblem = loaded.problem
        state.servedIds = loaded.projects.map((p) => p.id)
        state.disabledIds = loaded.disabled
        const report = {
          now: now.toISOString(),
          sharedConfig: { values: config.values, problem: config.problem },
          registry: {
            problem: loaded.problem,
            defaultId: loaded.defaultId,
            serving: loaded.projects.map((p) => p.id),
            disabled: loaded.disabled,
          },
          lastTickAt: state.lastTickAt,
          lastError: state.lastError,
          dialogs: state.dialogs,
          projects: [],
        }
        // Настоящее состояние конвейера — в метках GitHub, поэтому оно переживает
        // перезапуск приложения и показывается здесь же, по каждому проекту.
        for (const project of loaded.projects) {
          const st = projectState(project.id)
          const dept = project.department
          const inWin = inWindow(dept.windows, now)
          const row = {
            id: project.id,
            title: project.title,
            repo: project.repo,
            base: project.base,
            workspace: project.workspace,
            composeProject: project.composeProject,
            labels: project.labels,
            department: {
              enabled: dept.enabled,
              windows: windowsLabel(dept.windows),
              windowsSource: dept.windowsSource,
              openNow: inWin,
              nextWindowStart: inWin ? null : localStamp(nextWindowStart(dept.windows, now)),
              maxRework: dept.maxRework,
              maxAttempts: dept.maxAttempts,
              stuckAfterMinutes: dept.stuckAfterMinutes,
            },
            shift: st.run ? { startedAt: st.run.startedAt, sessions: st.run.sessions || 0, manual: !!st.run.manual } : null,
            lastShiftKey: st.lastShiftKey,
            session: st.session,
            attempts: st.attempts,
            reworkCounters: st.rework,
          }
          try {
            const issues = await loadIssues(project)
            const active = await findActive(project, issues)
            const queued = queuedOf(project, issues)
            row.activeIssue = active
              ? {
                number: active.issue.number,
                title: active.issue.title,
                role: active.role,
                kind: active.kind || (active.role === 'tester' ? 'test' : active.role === 'code-review' ? 'review' : 'new'),
                labels: labelsOf(active.issue),
              }
              : null
            row.queuedForDev = queued.map((i) => ({ number: i.number, title: i.title }))
            row.nextStep = active
              ? (active.role === 'code-review'
                ? 'поднять code-review по issue #' + active.issue.number
                : active.role === 'tester'
                  ? 'поднять tester по issue #' + active.issue.number
                  : 'поднять dev по issue #' + active.issue.number + ' (' + (active.kind || 'new') + ')')
              : (queued.length > 0
                ? (inWin ? 'в окне — взять issue #' + queued[0].number : 'вне окна — ждать расписания, тогда issue #' + queued[0].number)
                : 'делать нечего: очередь пуста')
          } catch (error) {
            row.github = { error: String(error && error.message ? error.message : error) }
            row.nextStep = 'состояние GitHub не прочитано'
          }
          report.projects.push(row)
        }
        return report
      },
    )

    const tickTool = define(
      'dev_department_tick',
      'Немедленно выполнить один шаг отдела разработки по всем включённым проектам и вернуть, что он сделал. Для ручной проверки: расписание и лимит «раз в сутки» игнорируются.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const result = await step({ ignoreWindow: true })
        return { result, state: { projects: state.projects, disabled: state.disabledIds } }
      },
    )

    const summaryTool = define(
      'dev_department_summary',
      'Отправить сводку отдела разработки в Telegram немедленно и закрыть смены всех проектов, где они идут.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        config = loadConfig()
        const loaded = loadProjects(config.values)
        const closed = []
        const now = new Date()
        for (const project of loaded.projects) {
          const st = state.projects[project.id]
          if (!st || !st.run) continue
          await finishProjectShift(project, now, FINISH.manual)
          closed.push(project.id)
        }
        return {
          sent: closed.length > 0,
          closed,
          note: closed.length > 0 ? null : 'ни в одном проекте смена не идёт — отправлять нечего',
        }
      },
    )

    ctx.effect(() => tools.register(statusTool), 'dev-department:status')
    ctx.effect(() => tools.register(tickTool), 'dev-department:tick')
    ctx.effect(() => tools.register(summaryTool), 'dev-department:summary')

    ctx.effect(() => ctx.interval(() => {
      step({}).catch((error) => { state.lastError = String(error && error.message ? error.message : error) })
    }, TICK_MS), 'dev-department:interval')
  },
}
