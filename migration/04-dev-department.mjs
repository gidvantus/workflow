// Отдел разработки — диспетчер ролей, многопроектный.
//
// ПРОЕКТЫ. Список проектов берётся из ~/.dsh/projects.json — того же реестра,
// из которого ролевые пресеты узнают репозиторий, базовую ветку и рабочую копию
// (см. инструмент project_info в пресетах). Отсюда, а не из dev-department.json,
// приходят repo, base, workspace, composeProject и метки конвейера: одна точка
// правды на всю систему.
//
// По умолчанию диспетчер обслуживает ВСЕ проекты реестра одновременно: у каждого
// свой клон, свой стенд (своё имя compose-проекта) и своя очередь. Поле projects
// в dev-department.json сужает и упорядочивает этот список:
//   "projects": ["vahta", "brain"]
//
// Время работы задаётся в ~/.dsh/dev-department.json. Диапазонов может быть
// несколько — полем windows: [{"start":"09:00","stop":"12:00"},
// {"start":"13:00","stop":"18:00"}]. Каждый диапазон может переходить полночь
// (23:00–03:30). Старое одиночное окно startHour–stopHour продолжает работать:
// из него собирается ровно один диапазон.
//
// Диапазоны — это независимые периоды работы. Пока открыт любой из них, задачи
// берутся; в промежутке смена завершается (со сводкой), а со следующим
// диапазоном начинается новая. Правило «один тикет за раз на проект» при этом не
// нарушается: если задача ещё в работе, промежуток её не прерывает.
//
// На каждый тикет у роли ровно ОДИН диалог. Доработка после test-failed и
// повторный тест продолжаются в том же диалоге: у агента уже есть ветка,
// коммиты и разбор прошлого вердикта. Карта диалогов лежит в
// ~/.dsh/dev-department-dialogs.json и переживает перезапуск приложения.
//
// Прогоны идут, пока запущен DSH Desktop. Приложение закрыто — прогонов нет,
// и это ожидаемое поведение, а не сбой.
//
// Конвейер строго по одному тикету НА ПРОЕКТ:
//   ready-for-dev  → диспетчер ставит in-progress и поднимает сессию dev
//   dev            → PR + комментарий, ставит ready-for-test, снимает in-progress
//   tester         → разворачивает ветку, проверяет
//                    прошло  → tested          (цикл закрыт, можно брать следующий)
//                    не прошло → test-failed  (тот же тикет возвращается в dev)
//   Новый тикет проекта не берётся, пока его текущий не получил tested.
//   Разные проекты друг друга не ждут: у каждого свой тикет и своя сессия.
//
// Состояние конвейера живёт В МЕТКАХ GitHub, а не в памяти диспетчера. Поэтому
// перезапуск приложения посередине смены ничего не ломает: подхватывается ровно
// то, на чём остановились.
//
// Когда закрывается последний диапазон, новые тикеты не берутся, но уже взятые
// доводятся до конца. Когда работа закончена — в Telegram уходит сводка за смену.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Настройки СМЕНЫ — в ~/.dsh/dev-department.json. Файл перечитывается на каждом
// шаге диспетчера, поэтому диапазоны и лимиты можно менять без перезапуска
// приложения; интервал опроса при этом фиксирован. Данных проекта здесь нет:
// они в ~/.dsh/projects.json.
const DEFAULTS = {
  startHour: 0,
  startMinute: 0,
  stopHour: 6,
  stopMinute: 0,
  maxRework: 3,
  projects: null,
}

// Диапазон по умолчанию: конфиг может быть пустым или битым, но диспетчер
// обязан остаться работоспособным.
const DEFAULT_WINDOWS = [{ start: 0, stop: 360 }]

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

// Разбор поля windows: массив объектов {"start":"13:00","stop":"18:00"}.
// Совпадающие начало и конец — пустой диапазон: «круглосуточно» задаётся не
// этим, а двумя диапазонами, поэтому такой элемент считается ошибкой.
function parseWindows(raw) {
  const problems = []
  if (!Array.isArray(raw) || raw.length === 0) {
    return { windows: null, problems: ['windows: нужен непустой массив диапазонов'] }
  }
  const windows = []
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    const at = 'windows[' + index + ']'
    if (!item || typeof item !== 'object') {
      problems.push(at + ': нужен объект с полями start и stop')
      continue
    }
    const start = parseClock(item.start)
    const stop = parseClock(item.stop)
    if (start === null || stop === null) {
      problems.push(at + ': start и stop должны быть временем вида "HH:MM"')
      continue
    }
    if (start === stop) {
      problems.push(at + ': начало и конец совпадают — диапазон получился бы пустым')
      continue
    }
    windows.push({ start, stop })
  }
  return { windows: windows.length > 0 ? windows : null, problems }
}

// BOM в начале файла (его пишут редакторы Windows и PowerShell) ломает
// JSON.parse невидимым символом. Реестр — обычный файл, который человек
// правит руками, поэтому читаем его снисходительно.
function stripBom(text) {
  const value = String(text)
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

function loadConfig() {
  const file = path.join(dshHome(), 'dev-department.json')
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if (error && error.code === 'ENOENT') return { values: { ...DEFAULTS, windows: DEFAULT_WINDOWS }, problem: null }
    return { values: { ...DEFAULTS, windows: DEFAULT_WINDOWS }, problem: 'не читается ' + file + ': ' + (error && error.message ? error.message : String(error)) }
  }
  const values = { ...DEFAULTS }
  const problems = []
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
  if (raw.maxRework !== undefined) {
    if (Number.isInteger(raw.maxRework) && raw.maxRework >= 1 && raw.maxRework <= 20) values.maxRework = raw.maxRework
    else problems.push('maxRework: нужно целое от 1 до 20')
  }

  // Какие проекты обслуживать. Отсутствие поля — все проекты реестра.
  if (raw.projects !== undefined) {
    if (Array.isArray(raw.projects) && raw.projects.every((id) => typeof id === 'string' && id.trim() !== '')) {
      values.projects = raw.projects.map((id) => id.trim())
      if (values.projects.length === 0) problems.push('projects: список пуст — обслуживать нечего')
    } else {
      problems.push('projects: нужен массив непустых id проектов')
    }
  }

  // Поля repo и workspacePath переехали в projects.json. Если они ещё лежат в
  // этом файле, о них надо сказать прямо: молча игнорировать настройку хуже,
  // чем сообщить, что она больше ни на что не влияет.
  for (const legacy of ['repo', 'workspacePath']) {
    if (raw[legacy] !== undefined) {
      problems.push(legacy + ': переехало в ~/.dsh/projects.json — это поле здесь больше не читается')
    }
  }

  // Диапазоны работы. Новое поле windows главнее; старые startHour–stopHour
  // продолжают работать и превращаются в единственный диапазон.
  let windows = null
  if (raw.windows !== undefined) {
    const parsed = parseWindows(raw.windows)
    for (const problem of parsed.problems) problems.push(problem)
    windows = parsed.windows
  }
  if (!windows) {
    const start = values.startHour * 60 + values.startMinute
    const stop = values.stopHour * 60 + values.stopMinute
    // Диапазон может переходить полночь (23:00–03:30) — это норма, а не ошибка.
    // Невалидно только полное совпадение начала и конца: диапазон пустой.
    if (start === stop) problems.push('начало и конец окна не должны совпадать — окно получилось бы пустым')
    windows = [{ start, stop }]
  }
  values.windows = windows
  // Первый диапазон дублируем в старые поля: их читает процесс, запущенный до
  // появления windows, и без зеркала он взял бы значения по умолчанию.
  values.startHour = Math.floor(windows[0].start / 60)
  values.startMinute = windows[0].start % 60
  values.stopHour = Math.floor(windows[0].stop / 60)
  values.stopMinute = windows[0].stop % 60
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

// Сколько тишины в работающей сессии считаем зависанием. Вызов инструмента,
// который не вернётся (зависший DNS, команда без конца), держит сессию
// «работающей» сколько угодно — и тогда конвейер встаёт целиком: очередь не
// движется, ошибок нет, в статусе всё «в работе». Ровно это и случилось.
const STUCK_AFTER_MS = 30 * 60 * 1000

// Сколько раз одну задачу можно выдать заново, если роль завершилась, ничего не
// изменив. Иначе молча падающая сессия крутила бы новые попытки без остановки.
const MAX_ATTEMPTS = 4

// Метки конвейера по умолчанию. Реестр проектов может их переопределить полем
// labels у проекта — тогда работает оно.
const PIPELINE_LABELS = {
  dev: 'ready-for-dev',
  progress: 'in-progress',
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

function projectRow(registry, id) {
  const raw = registry.projects[id] || {}
  const workspace = String(raw.workspace || '')
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
    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),
  }
}

// Список проектов смены: все из реестра, либо — если в dev-department.json задано
// поле projects — только названные там, в названном порядке. Ошибка реестра или
// ссылка на несуществующий проект возвращается как проблема, а не бросается:
// диспетчер обязан остаться живым и сказать, что именно не так.
function loadProjects() {
  let registry
  try {
    registry = readRegistry()
  } catch (error) {
    return { projects: [], problem: error && error.message ? error.message : String(error) }
  }
  const wanted = Array.isArray(config.values.projects) && config.values.projects.length > 0
    ? config.values.projects
    : registry.ids
  const missing = wanted.filter((id) => registry.ids.indexOf(id) === -1)
  const projects = wanted
    .filter((id) => registry.ids.indexOf(id) !== -1)
    .map((id) => projectRow(registry, id))

  // Две сессии в одном каталоге — верный способ испортить работу друг друга,
  // а резолв проекта по рабочей области становится неоднозначным.
  const byWorkspace = {}
  const clashes = []
  for (const project of projects) {
    const key = normalizePath(project.workspace)
    if (!key) continue
    if (byWorkspace[key]) clashes.push(byWorkspace[key] + ' и ' + project.id)
    else byWorkspace[key] = project.id
  }

  const problems = []
  if (missing.length > 0) problems.push('в реестре нет проектов: ' + missing.join(', '))
  for (const project of projects) {
    if (!project.repo) problems.push(project.id + ': не задан repo')
    if (!project.workspace) problems.push(project.id + ': не задан workspace')
  }
  if (clashes.length > 0) problems.push('проекты делят одну рабочую область: ' + clashes.join('; '))

  return {
    projects,
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

async function sendTelegram(text) {
  const { token, chatId } = readTelegramConfig()
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

// Действующие диапазоны работы: если конфиг почему-то пуст, подставляем
// значение по умолчанию, чтобы диспетчер не падал на ровном месте.
function configWindows() {
  const list = config.values.windows
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_WINDOWS
}

function windowsLabel() {
  return configWindows().map(windowLabel).join(', ')
}

// Диапазон может переходить полночь: 23:00–03:30, поэтому проверяем и «после
// старта вечером», и «до конца ночью».
function windowContains(w, minute) {
  return w.start < w.stop ? (minute >= w.start && minute < w.stop) : (minute >= w.start || minute < w.stop)
}

// Открытый сейчас диапазон: он и говорит, какой смене принадлежит момент и
// можно ли вообще брать задачи. Если диапазоны пересекаются, берём первый по
// порядку в конфиге.
function openWindow(date) {
  const minute = minutesOfDay(date)
  const list = configWindows()
  for (const w of list) {
    if (windowContains(w, minute)) return w
  }
  return null
}

function inWindow(date) {
  return openWindow(date) !== null
}

// Ключ смены — дата её НАЧАЛА, а не окончания. Иначе смена, начавшаяся в 23:00
// и закончившаяся в 03:30 следующего дня, считалась бы сменой нового дня, и
// вечерняя смена этого дня не запустилась бы вовсе.
function shiftKey(date) {
  const w = openWindow(date) || configWindows()[0]
  const d = new Date(date.getTime())
  if (w.start > w.stop && minutesOfDay(d) < w.stop) d.setDate(d.getDate() - 1)
  return dateKey(d)
}

// Ближайшее открытие диапазона: нужно, чтобы в статусе было видно, чего ждать,
// когда работы сейчас нет.
function nextWindowStart(date) {
  const minute = minutesOfDay(date)
  let best = null
  for (const w of configWindows()) {
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

    // Состояние смены. Всё, что относится к конвейеру, лежит ПО ПРОЕКТАМ:
    // projects[id] = { session, rework, attempts }. Активная сессия у каждого
    // проекта своя, поэтому проекты не ждут друг друга.
    const state = {
      run: null,          // { startedAt, entries: [], sessions }
      lastShiftKey: null, // ключ последней начатой смены — чтобы не запускать её дважды
      projects: {},       // id → { session, rework, attempts }
      dialogs: readDialogs(), // 'проект:роль:номер' → id диалога, который ведёт этот тикет
      projectProblem: null,
      projectIds: [],
      lastError: null,
      lastTickAt: null,
    }

    function projectState(id) {
      if (!state.projects[id]) state.projects[id] = { session: null, rework: {}, attempts: {} }
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

    function anySession() {
      for (const id of Object.keys(state.projects)) {
        if (state.projects[id] && state.projects[id].session) return true
      }
      return false
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

    // Единственный «активный» тикет проекта: сначала тот, что ждёт тестировщика,
    // затем отклонённый тестом, затем взятый, но не доведённый.
    async function findActive(project, issues) {
      const L = project.labels
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
        && !has(i, L.progress) && !has(i, L.test) && !has(i, L.ok) && !has(i, L.failed))
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

    // Имя диалога: проект + роль + номер тикета + короткий заголовок. Без этого
    // в списке сессий непонятно, какая из них чем занята.
    function titleFor(project, presetId, issue) {
      const role = presetId === 'dev' ? 'Разработчик' : presetId === 'tester' ? 'Тестировщик' : presetId
      const flat = String((issue && issue.title) || '').replace(/\s+/g, ' ').trim()
      const clipped = flat.length > 60 ? flat.slice(0, 57) + '…' : flat
      const head = role + ' [' + project.id + '] #' + issue.number
      return clipped ? head + ' — ' + clipped : head
    }

    function dialogKey(project, presetId, issueNumber) {
      return project.id + ':' + presetId + ':' + issueNumber
    }

    // Диалог этой роли по этому тикету, если он уже заведён.
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
      const lines = [
        kind === 'rework'
          ? 'Отдел разработки: доработай issue #' + issue.number + ' «' + issue.title + '» — тестировщик вернул его с меткой ' + L.failed + '.'
          : kind === 'continue'
            ? 'Отдел разработки: продолжи issue #' + issue.number + ' «' + issue.title + '» — он уже помечен ' + L.progress + ', то есть работа начата, но не доведена.'
            : 'Отдел разработки: возьми issue #' + issue.number + ' «' + issue.title + '».',
        '',
        projectHeader(project),
        'Действуй по скиллу dev-workflow: прочитай issue через gh_issue, работай в ветке feature/' + issue.number + '-<слаг> от ' + project.base + ', доведи до pull request и передай на тест.',
        'Обязательный финал: комментарий в issue (что сделано, ветка, номер PR, что не проверено), затем метка ' + L.test + ' и снятие ' + L.progress + '.',
        'В ' + project.base + ' и main не коммить. PR не мержить. Работай только в своей рабочей копии отдела ' + project.workspace +
          (project.humanClone ? ': в клон человека ' + project.humanClone + ' не заходить вообще.' : '.'),
        'Стенд поднимай только со своим именем проекта: docker compose -p ' + project.composeProject +
          ' ... Без -p docker возьмёт имя из docker-compose.yml и ты задешь стенд человека на его портах и его базе.',
        'После PR обязательно верни рабочую копию на ' + project.base + ': git checkout ' + project.base +
          ', затем git pull --ff-only. Незакоммиченных изменений в клоне остаться не должно.',
        'Поставь себе цель, чтобы довести работу до конца: один ход не должен обрывать задачу на середине.',
        'Если упёрся в то, что сам решить не можешь, — напиши это комментарием в issue и остановись.',
      ]
      if (kind === 'rework') lines.splice(2, 0, 'Начни с комментариев в issue: там причина отказа и воспроизводящая команда.')
      if (kind === 'continue') lines.splice(2, 0, 'Сначала посмотри, что уже сделано: ветка могла остаться, коммиты могли быть запушены, в issue может быть комментарий.')
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, в котором шла работа по тикету: ветка, коммиты и замечания тестировщика уже в его истории — продолжай с этого места, заново ничего не поднимай.')
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

    // ── один шаг диспетчера по проекту ─────────────────────────────────────

    async function dispatch(project, decision) {
      const st = projectState(project.id)
      const L = project.labels
      const { role, issue, rework } = decision
      const attempts = (st.attempts[issue.number] || 0) + 1
      st.attempts[issue.number] = attempts
      if (attempts > MAX_ATTEMPTS) {
        // Задача выдавалась несколько раз и ни разу не сдвинулась: молча
        // падающая сессия не должна крутить попытки без остановки.
        await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/comments', {
          body: 'Отдел разработки: задача выдавалась ' + (attempts - 1) + ' раз(а) и не сдвинулась — снимаю с конвейера, нужен человек.',
        })
        for (const name of [L.progress, L.failed, L.test]) {
          try {
            await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(name))
          } catch (error) { /* метки могло и не быть */ }
        }
        forgetDialog(project, 'dev', issue.number)
        forgetDialog(project, 'tester', issue.number)
        state.run.entries.push({ project: project.id, number: issue.number, title: issue.title, role: role, outcome: 'снят с конвейера после ' + (attempts - 1) + ' попыток без результата' })
        return { action: 'dropped', project: project.id, issue: issue.number, reason: 'no progress after ' + (attempts - 1) + ' attempts' }
      }
      if (role === 'dev') {
        const kind = decision.kind || 'new'
        const rounds = st.rework[issue.number] || 0
        if (kind === 'rework' && rounds >= config.values.maxRework) {
          await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/comments', {
            body: 'Отдел разработки: тикет возвращался из теста ' + rounds + ' раз(а) и снят с конвейера — нужен человек.',
          })
          await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(L.progress))
          await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(L.failed))
          forgetDialog(project, 'dev', issue.number)
          forgetDialog(project, 'tester', issue.number)
          state.run.entries.push({ project: project.id, number: issue.number, title: issue.title, outcome: 'снят с конвейера после ' + rounds + ' доработок' })
          return { action: 'dropped', project: project.id, issue: issue.number, reason: 'too many rework rounds' }
        }
        if (kind === 'rework') st.rework[issue.number] = rounds + 1
        // Захват нормализуем здесь, а не в агенте: у конвейера должен оставаться
        // ровно один активный маркер, иначе следующий шаг неоднозначен.
        if (kind === 'new') {
          await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/labels', { labels: [L.progress] })
          await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(L.dev))
        } else if (kind === 'rework') {
          await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/labels', { labels: [L.progress] })
          await github('DELETE', '/repos/' + project.repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(L.failed))
        }
        const sessionId = await startSession(project, 'dev', devPrompt(project, issue, kind, !!existingDialog(project, 'dev', issue.number)), issue)
        st.session = { role: 'dev', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        state.run.sessions = (state.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'dev', issue: issue.number, sessionId }
      }

      const sessionId = await startSession(project, 'tester', testerPrompt(project, issue, !!existingDialog(project, 'tester', issue.number)), issue)
      st.session = { role: 'tester', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
      state.run.sessions = (state.run.sessions || 0) + 1
      return { action: 'dispatched', project: project.id, role: 'tester', issue: issue.number, sessionId }
    }

    // Один шаг по одному проекту. Возвращает описание того, что сделано (или
    // почему не сделано), либо null, если проект не потребовал действий.
    async function stepProject(project, opts, now) {
      const st = projectState(project.id)
      const L = project.labels
      const inWin = inWindow(now)

      // Роль ещё работает — ждём, ничего не раздаём.
      if (st.session) {
        const waitedMs = now.getTime() - Date.parse(st.session.startedAt)
        const activity = await sessionActivity(st.session.sessionId)
        const stuckMs = activity.running && activity.idleMs !== null && activity.idleMs > STUCK_AFTER_MS
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
          state.run.entries.push({
            project: project.id,
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
        try {
          const issue = await reload(project, finished.issue)
          const marks = labelsOf(issue)
          const outcome = marks.indexOf(L.ok) !== -1 ? 'принято тестировщиком'
            : marks.indexOf(L.failed) !== -1 ? 'возвращено в доработку'
              : marks.indexOf(L.test) !== -1 ? 'ждёт тестировщика'
                : 'без изменения меток'
          // Тикет принят — диалоги по нему закрыты.
          if (outcome === 'принято тестировщиком') {
            forgetDialog(project, 'dev', finished.issue)
            forgetDialog(project, 'tester', finished.issue)
          }
          // Метки сдвинулись — задача движется, счётчик попыток обнуляем.
          if (outcome !== 'без изменения меток') st.attempts[finished.issue] = 0
          state.run.entries.push({ project: project.id, number: finished.issue, title: finished.title, role: finished.role, outcome, sessionId: finished.sessionId })
          return { action: 'finished-session', project: project.id, issue: finished.issue, outcome }
        } catch (error) {
          state.lastError = String(error.message)
          // Состояние не прочитано — это сбой на нашей стороне, а не провал
          // задачи. Снимаем попытку, иначе сеть «съедает» тикет как нерабочий.
          st.attempts[finished.issue] = Math.max(0, (st.attempts[finished.issue] || 1) - 1)
          state.run.entries.push({ project: project.id, number: finished.issue, title: finished.title, role: finished.role, outcome: 'состояние не прочитано: ' + error.message })
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
        if (queued) return dispatch(project, { role: 'dev', issue: queued, kind: 'new' })
        return null
      }

      // Вне окна и делать нечего: проект просто ждёт. Завершение смены целиком —
      // решение уровня всей смены, см. step().
      return null
    }

    async function step(options) {
      const opts = options || {}
      config = loadConfig()
      const now = new Date()
      state.lastTickAt = now.toISOString()

      const loaded = loadProjects()
      state.projectProblem = loaded.problem
      state.projectIds = loaded.projects.map((p) => p.id)
      if (loaded.problem) state.lastError = 'проекты: ' + loaded.problem

      const inWin = inWindow(now)

      // Смена начинается сама в окне и только один раз на смену.
      if (!state.run && inWin && state.lastShiftKey !== shiftKey(now)) {
        state.lastShiftKey = shiftKey(now)
        for (const id of Object.keys(state.projects)) {
          state.projects[id].attempts = {} // попытки не переезжают из смены в смену
        }
        state.run = { startedAt: now.toISOString(), entries: [], sessions: 0 }
      }
      // Ручной шаг вне окна: заводим одноразовую смену, иначе раздача задачи
      // упадёт на обращении к журналу смены.
      if (!state.run && opts.ignoreWindow) {
        state.run = { startedAt: now.toISOString(), entries: [], sessions: 0, manual: true }
      }

      if (loaded.projects.length === 0) {
        return { action: 'config-error', note: loaded.problem || 'в реестре нет проектов', projects: [] }
      }

      // Смены нет (вне окна и без ручного запуска) — брать нечего, и главное,
      // некуда записывать результат: журнала смены ещё не существует. Раньше
      // эта проверка стояла сразу после разбора диапазонов и защищала dispatch
      // от обращения к state.run.
      if (!state.run && !opts.ignoreWindow) {
        return {
          action: 'idle',
          note: inWin ? 'смена закрыта вручную — задачи не берутся' : 'вне окон отдела разработки',
          projects: [],
        }
      }

      // Каждый проект двигается своим шагом. Ошибка одного проекта не должна
      // останавливать остальные: у них разные репозитории и разные сети.
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

      // Смена закрывается, когда окно закрыто и ни один проект больше не
      // работает: незаконченные задачи доводятся до конца.
      if (!inWin && !opts.ignoreWindow && state.run && !anySession()) {
        await finishRun(now, FINISH.window)
        actions.push({ action: 'finished' })
      }

      return {
        action: actions.length === 1 ? actions[0].action : 'tick',
        projects: actions,
        shift: state.run ? { startedAt: state.run.startedAt, sessions: state.run.sessions || 0 } : null,
      }
    }

    async function finishRun(now, reason) {
      const run = state.run
      state.run = null
      // Ключ смены записан в момент её старта и по умолчанию остаётся: так
      // смена не начинается второй раз за сутки. Но если смена закончилась
      // сама вместе с окном, ключ снимаем. Окно могло закрыться и снова
      // открыться, пока приложение работало (оператор поправил часы в
      // dev-department.json), и тогда диспетчер обязан снова брать задачи, а не
      // стоять до утра с открытым окном и готовым ready-for-dev тикетом.
      // Ручное закрытие (dev_department_summary) ключ сохраняет: это команда
      // человека, а не следствие часов.
      if (reason !== FINISH.manual) state.lastShiftKey = null
      const lines = ['🛠 Отдел разработки: ' + (run ? localStamp(new Date(run.startedAt)) : '—') + ' → ' + now.toTimeString().slice(0, 5) + ' (' + reason + ')']
      lines.push('Проекты: ' + (state.projectIds.length > 0 ? state.projectIds.join(', ') : '—'))
      if (configWindows().length > 1) lines.push('Диапазоны работы: ' + windowsLabel())
      const sessions = (run && run.sessions) || 0
      lines.push('Сессий запущено: ' + sessions + '.')
      if (state.projectProblem) lines.push('⚠️ Проекты: ' + state.projectProblem)
      if (run && run.entries.length > 0) {
        // Сводка группируется по проектам: за смену их может быть несколько, и
        // без группировки непонятно, что к чему относится.
        const byProject = {}
        for (const entry of run.entries) {
          const id = entry.project || '—'
          if (!byProject[id]) byProject[id] = []
          byProject[id].push(entry)
        }
        for (const id of Object.keys(byProject)) {
          lines.push('')
          lines.push('[' + id + ']')
          for (const entry of byProject[id]) {
            lines.push('• #' + entry.number + ' ' + entry.title + ' — ' + entry.role + ': ' + entry.outcome)
          }
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
        await sendTelegram(summaryText)
      } catch (error) {
        state.lastError = 'Telegram: ' + error.message
      }
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
      'Состояние отдела разработки: идёт ли смена, какие проекты обслуживаются, что сейчас в конвейере каждого по меткам GitHub, что будет следующим шагом и что уже сделано за смену.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        config = loadConfig()
        const now = new Date()
        const loaded = loadProjects()
        state.projectProblem = loaded.problem
        state.projectIds = loaded.projects.map((p) => p.id)
        const report = {
          now: now.toISOString(),
          shiftConfig: { values: config.values, problem: config.problem },
          projectsRegistry: {
            problem: loaded.problem,
            defaultId: loaded.defaultId,
            serving: loaded.projects.map((p) => ({
              id: p.id,
              title: p.title,
              repo: p.repo,
              base: p.base,
              workspace: p.workspace,
              composeProject: p.composeProject,
              labels: p.labels,
            })),
          },
          window: windowsLabel(),
          windows: configWindows().map((w) => ({
            label: windowLabel(w),
            start: formatClock(w.start),
            stop: formatClock(w.stop),
            openNow: windowContains(w, minutesOfDay(now)),
          })),
          inWindow: inWindow(now),
          nextWindowStart: inWindow(now) ? null : localStamp(nextWindowStart(now)),
          runActiveInThisProcess: state.run !== null,
          lastShiftKey: state.lastShiftKey,
          lastTickAt: state.lastTickAt,
          lastError: state.lastError,
          entriesThisShift: state.run ? state.run.entries : [],
          dialogs: state.dialogs,
          projects: [],
        }
        // Настоящее состояние конвейера — в метках GitHub, поэтому оно переживает
        // перезапуск приложения и показывается здесь же, по каждому проекту.
        for (const project of loaded.projects) {
          const st = projectState(project.id)
          const row = {
            id: project.id,
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
                kind: active.kind || (active.role === 'tester' ? 'test' : 'new'),
                labels: labelsOf(active.issue),
              }
              : null
            row.queuedForDev = queued.map((i) => ({ number: i.number, title: i.title }))
            row.nextStep = active
              ? (active.role === 'tester'
                ? 'поднять tester по issue #' + active.issue.number
                : 'поднять dev по issue #' + active.issue.number + ' (' + (active.kind || 'new') + ')')
              : (queued.length > 0
                ? 'в окне — взять issue #' + queued[0].number
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
      'Немедленно выполнить один шаг отдела разработки по всем проектам и вернуть, что он сделал. Для ручной проверки: окно и лимит «раз в сутки» игнорируются.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const result = await step({ ignoreWindow: true })
        return { result, state: { sessions: state.projects, entries: state.run ? state.run.entries : [] } }
      },
    )

    const summaryTool = define(
      'dev_department_summary',
      'Отправить сводку отдела разработки в Telegram немедленно и закрыть смену.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        if (!state.run) state.run = { startedAt: new Date().toISOString(), entries: [], sessions: 0 }
        await finishRun(new Date(), FINISH.manual)
        return { sent: true }
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
