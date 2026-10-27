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
//   ready-for-dev  → входная ступень: диспетчер сам ставит маршрут area:* по
//                    тексту постановки (пути, расширения файлов, слова роли) и
//                    следующим шагом раздаёт задачу уже нужной половине роли;
//                    без уверенности метку не ставит и отдаёт тикет dev-fullstack
//   needs-mockup   → ступень постановки: дизайнер рисует макет до клика человека,
//                    ставит mockups-ready и на этом заканчивает — реализации нет
//   dev-fullstack / dev-backend / dev-frontend → PR + комментарий, ставит
//                    for-code-review, снимает in-progress
//   code-review    → читает PR и код вокруг, пишет замечания в PR
//                    принял    → ready-for-test
//                    не принял → ready-for-dev  (тот же тикет возвращается в dev)
//   tester         → разворачивает ветку, проверяет
//                    прошло  → tested
//                    не прошло → test-failed  (тот же тикет возвращается исполнителю)
//   devops-delivery → сливает PR merge-коммитом в базовую ветку и удаляет ветку
//                    задачи; метка tested — это зелёный вердикт тестировщика, а не
//                    закрытая задача, поэтому финал делает DevOps-инженер
//                    слито  → merged          (цикл закрыт, можно брать следующий)
//                    конфликт → ready-for-dev (тикет возвращается разработчику)
//   Новый тикет проекта не берётся, пока его текущий не получил merged.
//
// Разработчик разделён на две роли метками маршрута area:backend, area:frontend
// и area:fullstack. Одиночная половина идёт тем же путём, что и раньше. Полный
// стек проходит две ступени В ОДНОЙ ветке:
//   area:fullstack → dev-backend → for-code-review → code-review (первая половина)
//   ревьюер принял → ready-for-test
//   диспетчер превращает его в ready-for-frontend: тестировщику тикет пока рано
//   ready-for-frontend → dev-frontend, та же ветка и тот же PR
//   → for-code-review → code-review (всё изменение) → ready-for-test → tester
//   Если бэкенд-части в постановке не было (for-code-review без PR), диспетчер
//   передаёт тикет фронтенду сразу, не гоняя ревьюера на пустой PR.
// Возврат в доработку уходит половине, названной в замечаниях ревьюера: маршрут
// решают пути из последнего круга замечаний, а метка area:* и фаза — запасной
// вариант. Круг без нового коммита доработкой не считается: на ту же ревизию
// ревьюер не зовётся, бюджет доработок не тратится, а два таких круга подряд
// снимают тикет с конвейера человеку.
//
// Возврат из ревью в доработку считается такой же доработкой, как возврат из
// теста: счётчик доработок у тикета один, иначе пара dev↔code-review может
// качаться бесконечно, потому что каждая сессия двигает метку и обнуляет
// счётчик попыток.
//
// Первая строка любого комментария в issue и PR — `**Роль:** <кто> · <о чём>`.
// По заголовку роли диспетчер отличает свои комментарии от ревьюерских и находит
// начало круга доработок, поэтому формат — часть контракта конвейера. Свои
// комментарии он публикует через postComment(), роли — инструментом MCP
// mcp__github__add_issue_comment. Проверять заголовок больше некому: штатный
// сервер GitHub принимает любое тело, так что формат держится заданием и
// скиллами ролей. Комментарии старого формата (без заголовка) читаются
// запасным правилом: тикеты, начатые до выкатки, не должны встать.
//
// Состояние конвейера живёт В МЕТКАХ GitHub, а не в памяти диспетчера. Поэтому
// перезапуск приложения посередине смены ничего не ломает: подхватывается ровно
// то, на чём остановились.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { spawn } from 'node:child_process'

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
  // Ступень последовательного маршрута «бэкенд → фронтенд». Ставит её диспетчер,
  // а не агент: на тикете полного стека код-ревью после бэкенд-части — это ещё не
  // весь тикет, и фронтенд должен получить ту же ветку и тот же PR.
  frontend: 'ready-for-frontend',
  // Маршрут реализации. Метка живёт на тикете всю жизнь, поэтому возврат в
  // доработку попадает той же роли, что делала изменение.
  areaBackend: 'area:backend',
  areaFrontend: 'area:frontend',
  areaFullstack: 'area:fullstack',
  // Фаза тикета полного стека: фронтенд-часть уже начата. Переживает in-progress,
  // поэтому «продолжи» после зависшего хода не возвращается бэкендеру.
  phaseFrontend: 'phase:frontend',
  // Ступень постановки: дизайнер делает макет раньше, чем задача уходит в
  // разработку. needs-mockup ставит автор постановки, mockups-ready — дизайнер.
  // Пока второй метки нет, тикет в очередь разработки не попадает.
  mockup: 'needs-mockup',
  mockupsReady: 'mockups-ready',
  progress: 'in-progress',
  review: 'for-code-review',
  test: 'ready-for-test',
  ok: 'tested',
  failed: 'test-failed',
  // Финальная ступень: тестировщик принял, DevOps-инженер слил PR.
  merged: 'merged',
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
    // Каталоги половин работы. Необязательны: по умолчанию работают AREA_PREFIXES.
    areas: raw.areas && typeof raw.areas === 'object' ? raw.areas : undefined,
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

// ── GitHub через MCP ────────────────────────────────────────────────────────
// Единственный путь диспетчера к GitHub — штатный сервер github/github-mcp-server
// (github-mcp-server.exe). Своего HTTP-клиента GitHub и своего токена в
// диспетчере больше нет: токен лежит рядом с сервером, сервер читает его из
// окружения, а диспетчер только зовёт инструменты mcp__github__* по протоколу
// MCP (JSON-RPC поверх stdio). Всё, что ниже в этом разделе, — транспорт;
// прикладные операции собраны в githubIssue/githubPostComment/… и говорят уже
// на языке инструментов, а не эндпоинтов REST.
const MCP_DIR = path.join(dshHome(), 'mcp', 'github-mcp-server')
const MCP_EXE = path.join(MCP_DIR, 'github-mcp-server.exe')
const MCP_TOKEN_FILE = path.join(MCP_DIR, 'token')
// Конвейер живёт в метках, поэтому тулсет labels обязателен: без него у сервера
// нет инструментов меток вовсе, и смена встанет на первом же шаге.
const MCP_ARGS = ['stdio', '--toolsets', 'default,labels']
const MCP_TIMEOUT_MS = 30000

let mcpChild = null
let mcpHandshake = null
let mcpSeq = 1
let mcpBuffer = ''
let mcpStderr = ''
const mcpPending = new Map()
// Запросы идут строго по одному: сервер отвечает на stdio, и второй запрос,
// влезший между отправкой и ответом, ничего не ускоряет, зато путает след.
let mcpQueue = Promise.resolve()

function mcpLog(text) {
  try {
    fs.appendFileSync(path.join(dshHome(), 'dev-department-mcp.log'), new Date().toISOString() + ' ' + text + '\n')
  } catch (error) {
    // журнал транспорта не должен ломать смену
  }
}

function mcpEnv() {
  const token = fs.readFileSync(MCP_TOKEN_FILE, 'utf8').trim()
  if (!token) throw new Error('пустой файл токена: ' + MCP_TOKEN_FILE)
  return { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token }
}

function mcpSettleAll(error) {
  for (const task of mcpPending.values()) {
    clearTimeout(task.timer)
    task.reject(error)
  }
  mcpPending.clear()
}

function mcpReset(error) {
  const child = mcpChild
  mcpChild = null
  mcpHandshake = null
  mcpBuffer = ''
  if (error) mcpSettleAll(error)
  if (child) {
    try { child.kill() } catch (error) { /* уже мёртв */ }
  }
}

// Один ответ сервера: id — разрешение ожидающего запроса, isError — отказ
// инструмента. Отказ приходит текстом («failed to get issue: …»), поэтому
// сообщение об ошибке берётся из content, а не из кода JSON-RPC.
function mcpTakeLine(line) {
  let message = null
  try { message = JSON.parse(line) } catch (error) { return }
  if (!message || message.id === undefined || message.id === null) return
  const task = mcpPending.get(message.id)
  if (!task) return
  mcpPending.delete(message.id)
  clearTimeout(task.timer)
  if (message.error) {
    task.reject(new Error(task.name + ': ' + (message.error.message || JSON.stringify(message.error))))
    return
  }
  const result = message.result || {}
  // Ответ на initialize и другие служебные запросы приходит без content —
  // отдаём его целиком, разбором содержимого занимаются только tools/call.
  if (!Array.isArray(result.content)) {
    task.resolve(message)
    return
  }
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  if (result.isError) {
    task.reject(new Error(task.name + ': ' + String(text || 'инструмент отказал').slice(0, 400)))
    return
  }
  if (!text) {
    task.resolve(result.structuredContent === undefined ? null : result.structuredContent)
    return
  }
  try {
    task.resolve(JSON.parse(text))
  } catch (error) {
    task.resolve(text)
  }
}

function mcpEnsure() {
  if (mcpHandshake) return mcpHandshake
  mcpHandshake = (async () => {
    const child = spawn(MCP_EXE, MCP_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env: mcpEnv(), windowsHide: true })
    mcpChild = child
    mcpBuffer = ''
    mcpStderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      mcpBuffer += chunk
      let at = mcpBuffer.indexOf('\n')
      while (at >= 0) {
        const line = mcpBuffer.slice(0, at).trim()
        mcpBuffer = mcpBuffer.slice(at + 1)
        if (line) mcpTakeLine(line)
        at = mcpBuffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { mcpStderr = (mcpStderr + chunk).slice(-4000) })
    child.on('error', (error) => {
      mcpReset(new Error('MCP-сервер GitHub: ' + error.message))
    })
    child.on('exit', (code) => {
      if (mcpChild !== child) return
      mcpLog('exit ' + code + (mcpStderr ? '\n' + mcpStderr : ''))
      mcpReset(new Error('MCP-сервер GitHub завершился (код ' + code + ')'))
    })

    const id = mcpSeq++
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mcpPending.delete(id)
        reject(new Error('таймаут рукопожатия ' + MCP_TIMEOUT_MS / 1000 + ' с'))
      }, MCP_TIMEOUT_MS)
      mcpPending.set(id, { resolve, reject, timer, name: 'initialize' })
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-dev-department', version: '1.0.0' } },
      }) + '\n')
    })
    if (!answer || !answer.result) throw new Error('initialize: пустой ответ сервера')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    mcpLog('connected ' + JSON.stringify(answer.result.serverInfo || {}))
  })()
  mcpHandshake.catch(() => { mcpReset() })
  return mcpHandshake
}

async function mcpInvoke(name, args) {
  await mcpEnsure()
  const child = mcpChild
  if (!child || !child.stdin || !child.stdin.writable) throw new Error('MCP-сервер GitHub не запущен')
  const id = mcpSeq++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mcpPending.delete(id)
      reject(new Error('таймаут ' + MCP_TIMEOUT_MS / 1000 + ' с: ' + name))
    }, MCP_TIMEOUT_MS)
    mcpPending.set(id, { resolve, reject, timer, name })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
}

function mcpCall(name, args) {
  const run = mcpQueue.then(() => mcpInvoke(name, args))
  mcpQueue = run.then(() => undefined, () => undefined)
  return run
}

// Чтения повторяем: канал до GitHub отваливался, и «состояние не прочитано»
// превращалось в ложный вывод, будто задача не движется. Повторяем только
// идемпотентные вызовы — повтор комментария мог бы создать дубль.
async function mcpRead(name, args) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await mcpCall(name, args)
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError
}

function repoOf(project) {
  const parts = String(project.repo || '').split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new Error('проект ' + project.id + ': repo должен быть «owner/name», а сейчас «' + project.repo + '»')
  }
  return { owner: parts[0], repo: parts[1] }
}

// Набор полей задаём явно: без него list_issues не отдаёт метки, а диспетчер
// читает конвейер именно по ним.
const ISSUE_FIELDS = ['number', 'title', 'body', 'state', 'labels', 'created_at', 'updated_at', 'user', 'assignees']

async function githubLoadIssues(project) {
  const { owner, repo } = repoOf(project)
  const page = await mcpRead('list_issues', {
    owner,
    repo,
    state: 'OPEN',
    perPage: 100,
    orderBy: 'CREATED_AT',
    direction: 'ASC',
    fields: ISSUE_FIELDS,
  })
  const rows = (page && page.issues) || []
  return rows.filter((issue) => !issue.pull_request)
}

async function githubIssue(project, number) {
  const { owner, repo } = repoOf(project)
  return mcpRead('issue_read', { method: 'get', owner, repo, issue_number: Number(number) })
}

async function githubIssueComments(project, number) {
  const { owner, repo } = repoOf(project)
  const all = []
  for (let page = 1; page <= 10; page += 1) {
    const rows = await mcpRead('issue_read', { method: 'get_comments', owner, repo, issue_number: Number(number), perPage: 100, page })
    const list = Array.isArray(rows) ? rows : []
    all.push(...list)
    if (list.length < 100) break
  }
  return all
}

async function githubPostComment(project, number, body) {
  const { owner, repo } = repoOf(project)
  return mcpCall('add_issue_comment', { owner, repo, issue_number: Number(number), body })
}

// PR ищется по головной ветке: соглашение feature/<номер>-* — часть контракта
// ролей, поэтому номер тикета однозначно указывает на его PR.
async function githubFindPr(project, number) {
  const { owner, repo } = repoOf(project)
  const pulls = await mcpRead('list_pull_requests', { owner, repo, state: 'all', perPage: 100, sort: 'updated', direction: 'desc' })
  const rows = Array.isArray(pulls) ? pulls : []
  return rows.filter((pull) => pull && pull.head && String(pull.head.ref).indexOf('feature/' + number + '-') === 0)[0] || null
}

async function githubIssueLabels(project, number) {
  const { owner, repo } = repoOf(project)
  const answer = await mcpRead('issue_read', { method: 'get_labels', owner, repo, issue_number: Number(number) })
  const rows = (answer && answer.labels) || []
  return rows.map((label) => (typeof label === 'string' ? label : label && label.name)).filter(Boolean)
}

// Метки ставятся и снимаются ОДНИМ инструментом issue_write: в MCP v2 нет
// отдельных add/remove для меток тикета, обновление принимает полный список.
// Отсюда чтение текущего набора перед каждой правкой — иначе правка сотрёт
// чужие метки. Пустой список отправить можно: сервер принимает `labels: []` и
// снимает все метки, поэтому уборка «до нуля» работает (проверено на живом
// сервере v2.0.3).
async function githubWriteLabels(project, number, labels) {
  const next = Array.from(new Set((labels || []).filter(Boolean)))
  const { owner, repo } = repoOf(project)
  return mcpCall('issue_write', { method: 'update', owner, repo, issue_number: Number(number), labels: next })
}

async function githubAddLabel(project, number, label) {
  if (!label) return false
  const current = await githubIssueLabels(project, number)
  if (current.indexOf(label) !== -1) return false
  await githubWriteLabels(project, number, current.concat([label]))
  return true
}

async function githubDropLabels(project, number, names) {
  const wanted = (names || []).filter(Boolean)
  if (wanted.length === 0) return []
  const current = await githubIssueLabels(project, number)
  const left = current.filter((label) => wanted.indexOf(label) === -1)
  if (left.length === current.length) return []
  await githubWriteLabels(project, number, left)
  return current.filter((label) => wanted.indexOf(label) !== -1)
}

async function githubDropLabel(project, number, name) {
  if (!name) return false
  try {
    const dropped = await githubDropLabels(project, number, [name])
    return dropped.length > 0
  } catch (error) {
    return false
  }
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
// только идемпотентные запросы — повтор POST мог бы создать дубль. Сам обмен с
// GitHub идёт через MCP-сервер (см. mcpRead/mcpCall выше), поэтому здесь
// остались только повтор и таймауты, а не HTTP.


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
        // reviewedHead — ревизия, которую ревьюер уже смотрел; noop — сколько
        // кругов подряд прошло без нового коммита; findings — пути из замечаний,
        // по которым выбран маршрут доработки.
        state.projects[id] = {
          run: null,
          lastShiftKey: null,
          session: null,
          rework: {},
          attempts: {},
          dropped: {},
          reviewedHead: {},
          noop: {},
          findings: {},
          infraFails: 0,
          backoffUntil: null,
        }
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

    // Роль dev стала dev-fullstack: ключ диалога содержит имя пресета, и без
    // переноса агент потерял бы ветку, коммиты и замечания ревьюера по тикетам,
    // начатым до переименования.
    try {
      let renamed = false
      for (const key of Object.keys(state.dialogs)) {
        if (!/^[^:]+:dev:[0-9]+$/.test(key)) continue
        const next = key.replace(/^(.*):dev:([0-9]+)$/, '-fullstack:')
        if (!state.dialogs[next]) state.dialogs[next] = state.dialogs[key]
        delete state.dialogs[key]
        renamed = true
      }
      if (renamed) writeDialogs(state.dialogs)
    } catch (error) {
      // Диалоги переедут при следующем запуске.
    }

    // ── чтение состояния из GitHub ─────────────────────────────────────────
    // Открытые issue проекта — инструментом list_issues. Метки приходят в
    // ответе только когда их просили полем fields, поэтому набор полей задан в
    // одной константе ISSUE_FIELDS рядом с самим инструментом.

    async function loadIssues(project) {
      return githubLoadIssues(project)
    }

    async function reload(project, number) {
      return githubIssue(project, number)
    }

    // ── заголовок роли в комментарии ───────────────────────────────────────
    // Первая строка комментария любой роли — `**Роль:** <имя> · <о чём>`. По ней
    // диспетчер отличает свои комментарии от ревьюерских и находит начало круга
    // доработок, поэтому формат — часть контракта конвейера, а не пожелание
    // скилла. Разбор при этом снисходительный: у тикетов, начатых до выкатки
    // правила, заголовка нет, и они обязаны маршрутизироваться как раньше.
    const ROLE_HEADER = /^\*\*Роль:\*\*\s+([^·\n]+?)\s+·/

    function roleOf(text) {
      const found = ROLE_HEADER.exec(String(text || ''))
      return found ? found[1].trim() : ''
    }

    function isReviewerComment(text) {
      return roleOf(text) === 'код-ревьюер'
    }

    // Вердикт тестировщика живёт комментарием в ISSUE, а не в PR: при
    // `test-failed` маршрут доработки строится по его чеклисту, иначе
    // фронтенд-дефект уезжает половине из метки `area:*` (дефект из разбора #10).
    function isTesterComment(text) {
      return roleOf(text) === 'тестировщик'
    }

    function isDispatcherComment(text) {
      return roleOf(text) === 'диспетчер' || /^\s*Отдел разработки:/.test(String(text || ''))
    }

    // Публикация комментария диспетчера. Восемь мест, где он пишет в тикет,
    // собираются здесь: формат заголовка задан один раз, и следующая правка
    // формата не оставит половину комментариев без роли.
    async function postComment(project, number, about, text) {
      const body = '**Роль:** диспетчер · ' + about + '\n\n' + text
      return githubPostComment(project, number, body)
    }

    // Кто реализует тикет: маршрут задаёт метка, и живёт она на тикете всю жизнь
    // задачи. Поэтому возврат в доработку уходит той же роли, а не первой
    // попавшейся. Полный стек проходит две половины: сначала бэкенд, затем
    // фронтенд — вторая половина помечена phaseFrontend.
    function implementer(issue, L) {
      if (has(issue, L.areaFullstack)) return has(issue, L.phaseFrontend) ? 'dev-frontend' : 'dev-backend'
      if (has(issue, L.areaFrontend)) return 'dev-frontend'
      if (has(issue, L.areaBackend)) return 'dev-backend'
      // Без метки маршрута остаётся разработчик полного стека: старые тикеты и
      // задачи вне разделения ролей должны доделываться, а не вставать.
      return 'dev-fullstack'
    }

    // Каталоги половин работы. Проект задаёт их полем areas в реестре, и это
    // единственный источник истины: у одного проекта приложение в backend/, у
    // другого в operator/backend/, у третьего в crates/. Список ниже — запасной
    // вариант для проекта, который areas не задал.
    const AREA_PREFIXES = {
      backend: ['backend/', 'api/', 'app/backend/', 'app/api/'],
      frontend: ['frontend/', 'web/', 'app/frontend/', 'app/web/'],
    }

    function areasOf(project) {
      const raw = project.areas
      if (!raw || typeof raw !== 'object') return AREA_PREFIXES
      const backend = Array.isArray(raw.backend) && raw.backend.length > 0 ? raw.backend : AREA_PREFIXES.backend
      const frontend = Array.isArray(raw.frontend) && raw.frontend.length > 0 ? raw.frontend : AREA_PREFIXES.frontend
      return { backend: backend, frontend: frontend }
    }

    // Файл принадлежит половине, если каталог из areas стоит в его пути на любой
    // глубине. Приложение бывает вложенным (operator/backend/app.py), а проверка
    // «каталог с начала строки» оставляла такие файлы без половины вовсе — из-за
    // неё тикет по operator/ не находил исполнителя.
    function inArea(path, prefixes) {
      const p = String(path || '').replace(/\\/g, '/').toLowerCase()
      if (!p) return false
      for (const prefix of prefixes) {
        const needle = String(prefix || '').replace(/\\/g, '/').toLowerCase()
        if (!needle) continue
        if (p.indexOf(needle) === 0 || p.indexOf('/' + needle) >= 0) return true
      }
      return false
    }

    // К какой ОДНОЙ половине относится путь. Одного inArea мало: каталог половин
    // встречается в пути дважды — frontend/src/api/auth.js подходит и под
    // frontend/, и под api/, и маршрут по замечаниям уезжал бы в dev-fullstack на
    // ровном месте. Решает самое левое совпадение: оно ближе к корню и называет
    // дерево, в котором файл лежит на самом деле.
    function areaOfPath(path, areas) {
      const p = String(path || '').replace(/\\/g, '/').toLowerCase()
      if (!p) return null
      const match = (prefixes, half) => {
        let best = null
        for (const prefix of prefixes || []) {
          const needle = String(prefix || '').replace(/\\/g, '/').toLowerCase()
          if (!needle) continue
          const at = p.indexOf(needle)
          if (at !== 0 && (at < 0 || p.charAt(at - 1) !== '/')) continue
          if (best === null || at < best.at) best = { at, half }
        }
        return best
      }
      const backend = match(areas.backend, 'backend')
      const frontend = match(areas.frontend, 'frontend')
      if (backend && frontend) return frontend.at < backend.at ? 'frontend' : 'backend'
      if (frontend) return 'frontend'
      if (backend) return 'backend'
      return null
    }

    // PR ищется по головной ветке: соглашение feature/<номер>-* — часть контракта
    // ролей, поэтому номер тикета однозначно указывает на его PR.
    async function findPr(project, number) {
      return githubFindPr(project, number)
    }

    // Пути файлов в тексте замечания. Порядок расширений — от длинных к коротким:
    // в alternation выигрывает первая подошедшая ветвь, и с `ts` раньше `tsx`
    // путь обрывался до несуществующего файла (`Vacancy.ts` вместо `Vacancy.tsx`),
    // а вместе с обрывом терялся и номер строки. Граница после расширения
    // закрывает тот же случай вторым способом — на случай нового расширения.
    const FINDING_PATH = /[A-Za-z0-9_@~$][A-Za-z0-9_@~$/.-]*\.(?:tsx|jsx|mjs|py|sql|js|ts|css|scss|vue|svelte|html)(?![A-Za-z0-9])(?::[0-9]+(?:-[0-9]+)?)?/g

    // Пункт чеклиста ревьюера или тестировщика: `- [ ] Б1 · <path:line> — …`.
    // Галочку в нём закрывает разработчик, поэтому отмеченный пункт — уже
    // отработанное замечание и в маршрут доработки не попадает. Диспетчер берёт
    // маркер из строки, а разработчик правит `[ ]` на `[x]` в теле комментария и
    // записывает тело целиком через mcp__github__update_issue_comment: этот
    // инструмент заменяет тело, поэтому галочка ставится только правкой тела.
    // Расхождение в шаблоне ломает либо галочку, либо маршрут (пункт `-[ ] Б1`
    // без пробела обязан быть пунктом у обоих).
    const CHECKLIST_LINE = /^(\s*[-*+]\s*\[)([ xX])(\]\s*)(\S+)(.*)$/

    // Что из комментария идёт в разбор путей. Комментарий с чеклистом отдаёт
    // только непомеченные пункты — проза вокруг и закрытые пункты маршрута не
    // касаются. Комментарий без чекбоксов (старый формат, тикет в полёте)
    // разбирается как раньше, целиком: иначе старые тикеты потеряли бы путь.
    function checklistPart(text) {
      const lines = String(text).split('\n')
      const items = lines.filter((line) => CHECKLIST_LINE.test(line))
      if (items.length === 0) return String(text)
      return items.filter((line) => (CHECKLIST_LINE.exec(line) || [])[2] === ' ').join('\n')
    }

    // Круг ревью начинается вердиктом: всё, что выше последнего вердикта, — уже
    // закрытая история и к текущему возврату отношения не имеет. Заголовок роли
    // в первой строке — основной признак; регулярка ниже остаётся запасным
    // путём для тикетов, начатых до выкатки заголовка.
    const ROUND_START = /^(FIX:|SHIP\b|BLOCKED\b)/

    // Строка вердикта в ШАПКЕ комментария. Отдельно от ROUND_START, потому что
    // по правилу «заголовок роли в первой строке» тело комментария начинается с
    // `**Роль:** …`, и ROUND_START такую строку не поймает: начало круга осталось
    // бы `-1`, обе половины пустыми, и каждый возврат из ревью поехал бы по
    // метке `area:*` вместо путей. Поэтому вердикт ищется в шапке самого
    // комментария — к этому же правилу пришёл возврат №3 по #9. Правило несущее,
    // хотя комментариев в круге теперь один: именно он и открывает круг.
    const ROUND_VERDICT = /^(FIX:|SHIP\b|BLOCKED\b)/m

    // Вердикт ищется только в шапке (первые три строки: заголовок роли, вердикт,
    // пустая строка), а не по всему телу. С флагом `m` поиск по всему тексту
    // находил цитату вердикта внутри обычного замечания — а в тикетах про форматы
    // комментариев такая цитата норма. Цитата объявляла замечание началом круга,
    // круг укорачивался до него, и пути всех более ранних замечаний пропадали.
    //
    // Вердикт принимается в двух видах: отдельной строкой (канон скилла: заголовок,
    // вердикт, пустая строка) и прямо в заголовке — «**Роль:** код-ревьюер · вердикт
    // FIX: 2». Второй вид — дословный приёмочный случай постановки, и именно так
    // пишет роль, которой задание говорит только про заголовок: принимать один вид и
    // отказывать второму значит терять круг (возврат №3 по #9). Цитату вердикта в
    // теле замечания разбор при этом не ловит: у замечания «о чём» начинается не со
    // слова «вердикт», а по шапке поиск до тела не достаёт.
    const VERDICT_TOKEN = /\b(FIX:|SHIP\b|BLOCKED\b)/
    const HEADER_ABOUT = /^\*\*Роль:\*\*\s+[^·\n]+?\s+·\s+([^\n]+)$/

    function isReviewerVerdict(text) {
      if (!isReviewerComment(text)) return false
      const lines = String(text).split('\n')
      if (ROUND_VERDICT.test(lines.slice(0, 3).join('\n'))) return true
      const about = (HEADER_ABOUT.exec(lines[0].replace(/\r$/, '')) || [])[1] || ''
      // \b после кириллицы в JS не работает: \w — только латиница, цифры и `_`,
      // поэтому граница после «вердикт» не срабатывала и второй вид вердикта
      // молча не находился. Явный разделитель — то, что действительно нужно.
      return /^вердикт(\s|:|$)/i.test(about.trim()) && VERDICT_TOKEN.test(about)
    }

    // Комментарии тикета. Тем же адресом отдаются комментарии PR: PR — это issue.
    // Диспетчеру нужны оба списка — вердикт ревьюера живёт в PR, вердикт
    // тестировщика в issue, и после `test-failed` маршрут доработки обязан читать
    // фронтенд-дефект из чеклиста тестировщика, а не угадывать половину по метке.
    // По 100 на страницу, поэтому дочитываем, пока страница полная: иначе
    // последний круг замечаний можно обрезать.
    async function issueComments(project, number) {
      return githubIssueComments(project, number)
    }

    // Тексты чужих комментариев: свои комментарии диспетчера — не замечания
    // ревьюера и не вердикт тестировщика. В них те же пути, и маршрут по ним
    // замыкался бы сам на себя. Роль в заголовке — основной признак.
    function commentTexts(rows) {
      return (rows || [])
        .map((row) => String((row && row.body) || ''))
        .filter((text) => !isDispatcherComment(text))
    }

    // Пути замечаний из текста круга, разложенные по половинам работы. Источник
    // идёт рядом с путями: задание исполнителю называет, чьи это замечания.
    function collectFindings(project, round, source) {
      const areas = areasOf(project)
      const backend = []
      const frontend = []
      const seen = new Set()
      FINDING_PATH.lastIndex = 0
      let match = FINDING_PATH.exec(round)
      while (match) {
        const raw = match[0]
        // Суффикс :строка срезается для маршрута и для следа в тикете, но сам
        // номер строки не теряется: исполнителю он нужен, чтобы сразу открыть
        // место, на которое показал ревьюер.
        const at = (raw.match(/:([0-9]+(?:-[0-9]+)?)$/) || [])[1] || null
        const cleaned = raw.replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '')
        if (cleaned && !seen.has(cleaned.toLowerCase())) {
          seen.add(cleaned.toLowerCase())
          const half = areaOfPath(cleaned, areas)
          if (half === 'backend') backend.push({ path: cleaned, at })
          if (half === 'frontend') frontend.push({ path: cleaned, at })
        }
        match = FINDING_PATH.exec(round)
      }
      return { backend, frontend, source }
    }

    // Замечания последнего круга ревью, разложенные по половинам работы. Вердикт
    // и замечания живут комментариями PR — инлайновых review-комментариев этот
    // процесс не пишет. Ошибка сети или отсутствие PR — null, а не исключение:
    // маршрут тогда честно решает метка area:*.
    async function reviewFindings(project, issue) {
      let pr = null
      try {
        pr = await findPr(project, issue.number)
      } catch (error) {
        state.lastError = 'PR #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      if (!pr) return null
      let rows = null
      try {
        rows = await issueComments(project, pr.number)
      } catch (error) {
        state.lastError = 'замечания PR #' + pr.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      const texts = commentTexts(rows)
      // Начало круга — последний комментарий ревьюера со строкой вердикта: у
      // каждого замечания теперь свой заголовок роли, и без этой приметы круг
      // съезжал на последнее замечание. Комментарий старого формата (без
      // заголовка) узнаётся запасным правилом: тикет, начатый до выкатки,
      // обязан маршрутизироваться как раньше.
      let from = -1
      for (let i = 0; i < texts.length; i += 1) {
        if (isReviewerVerdict(texts[i])) from = i
      }
      if (from < 0) {
        for (let i = 0; i < texts.length; i += 1) {
          if (ROUND_START.test(texts[i])) from = i
        }
      }
      if (from < 0) return { backend: [], frontend: [], source: 'ревьюера' }
      const round = texts.slice(from).map(checklistPart).join('\n')
      return collectFindings(project, round, 'ревьюера')
    }

    // Вердикт тестировщика пишется отдельной строкой, поэтому круг — ровно его
    // комментарий: старые круги остаются в issue выше и в маршрут не попадают.
    const TESTER_VERDICT = /^\s*VERDICT:\s*(?:GREEN|RED)\b/m

    // Замечания тестировщика из чеклиста в ISSUE. Возврат null — вердикта
    // тестировщика в issue нет вовсе (старый формат, тикет в полёте): тогда
    // маршрут решает круг ревьюера, как раньше. Пустые половины — вердикт есть,
    // путей в нём нет: половину честно решает метка area:*.
    async function testFindings(project, issue) {
      let rows = null
      try {
        rows = await issueComments(project, issue.number)
      } catch (error) {
        state.lastError = 'замечания тестировщика в #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      const texts = commentTexts(rows)
      let last = -1
      let verdict = -1
      for (let i = 0; i < texts.length; i += 1) {
        if (!isTesterComment(texts[i])) continue
        last = i
        if (TESTER_VERDICT.test(texts[i])) verdict = i
      }
      if (last < 0) return null
      return collectFindings(project, checklistPart(texts[verdict >= 0 ? verdict : last]), 'тестировщика')
    }

    // Кому отдать доработку. Решают пути из замечаний: подсчёт файлов всего PR
    // врал — на vahta #193 фронтенд-замечания четыре раза подряд уходили
    // бэкендеру, потому что бэкенд-файлов в PR было больше, и три доработки
    // закончились без единого коммита. Источник замечаний зависит от того, кто
    // вернул тикет: после `test-failed` — чеклист тестировщика в issue (иначе
    // фронтенд-дефект уезжал половине из метки `area:*`), после возврата из
    // ревью — круг ревьюера в PR. Нет путей или ничего не прочитано — решает
    // метка маршрута, как раньше.
    async function roleForRework(project, issue, L) {
      const findings = (has(issue, L.failed) ? await testFindings(project, issue) : null)
        || await reviewFindings(project, issue)
      if (findings) projectState(project.id).findings[issue.number] = findings
      if (findings) {
        const backend = findings.backend.length > 0
        const frontend = findings.frontend.length > 0
        if (backend && frontend) return 'dev-fullstack'
        if (frontend) return 'dev-frontend'
        if (backend) return 'dev-backend'
      }
      return implementer(issue, L)
    }

    // Пути замечаний, относящиеся к половине исполнителя, и источник, из которого
    // они прочитаны (`тестировщика` или `ревьюера`). Забрать их можно один раз:
    // след маршрута в комментарии и строка в задании берут один и тот же список, а
    // следующий возврат прочитает замечания заново.
    function takeFindings(st, number, role) {
      const findings = st.findings[number]
      delete st.findings[number]
      if (!findings) return { paths: [], source: '' }
      const paths = role === 'dev-backend'
        ? findings.backend
        : role === 'dev-frontend'
          ? findings.frontend
          : findings.backend.concat(findings.frontend)
      return { paths: paths, source: findings.source || '' }
    }

    // След маршрута в тикете: половина и до трёх путей, по которым она выбрана.
    // Номера строк здесь не печатаются: постановка требует в следе пути файлов,
    // а место в файле исполнитель получает в задании.
    function findingsTrace(role, paths) {
      if (!paths || paths.length === 0) return ''
      return ' → ' + role + ': ' + paths.map((item) => item.path).slice(0, 3).join(', ')
    }

    // Путь для задания исполнителю: с номером строки, если ревьюер его назвал.
    function findingLabel(item) {
      return item && item.at ? item.path + ':' + item.at : String((item && item.path) || item)
    }

    // Дизайнера здесь нет намеренно: его диалог — ступень макета, то есть
    // постановка, а не начатая работа. Считать её доработкой значило бы тратить
    // бюджет доработок ещё до первой строки кода.
    function anyImplementerDialog(project, issue) {
      for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend']) {
        if (existingDialog(project, presetId, issue.number)) return true
      }
      return false
    }

    // Единственный «активный» тикет проекта: сначала тот, что ждёт код-ревью,
    // затем ждущий тестировщика, затем отклонённый, затем взятый, но не доведённый.
    // Ревью стоит выше теста: оно раньше в конвейере, и тикет, помеченный обоими
    // (ревьюер принял, но метку не снял), должен доехать до ревью, а не проскочить.
    async function findActive(project, issues) {
      const L = project.labels
      // Ступень фронтенда стоит первой: бэкенд-часть полного стека уже сделана,
      // и тикет нельзя снова отдать ревьюеру или тестировщику — они увидят
      // половину изменения.
      const waitingFrontend = issues.filter((i) => has(i, L.frontend))
      if (waitingFrontend.length > 0) return { role: 'dev-frontend', issue: waitingFrontend[0], kind: 'stage' }
      const waitingReview = issues.filter((i) => has(i, L.review))
      if (waitingReview.length > 0) return { role: 'code-review', issue: waitingReview[0], kind: 'review' }
      const waitingTest = issues.filter((i) => has(i, L.test))
      if (waitingTest.length > 0) return { role: 'tester', issue: waitingTest[0] }
      // Принятый тестировщиком тикет — уже не финал: его сливает DevOps-инженер.
      // Метка тестировщика означает его зелёный вердикт, а не закрытую задачу.
      const waitingMerge = issues.filter((i) => has(i, L.ok))
      if (waitingMerge.length > 0) return { role: 'devops-delivery', issue: waitingMerge[0], kind: 'merge' }
      const failedTest = issues.filter((i) => has(i, L.failed))
      if (failedTest.length > 0) {
        return { role: await roleForRework(project, failedTest[0], L), issue: failedTest[0], kind: 'rework' }
      }
      const taken = issues.filter((i) => has(i, L.progress))
      if (taken.length > 0) {
        return { role: await roleForRework(project, taken[0], L), issue: taken[0], kind: 'continue' }
      }
      return null
    }

    function queuedOf(project, issues) {
      const L = project.labels
      return issues.filter((i) => has(i, L.dev)
        && !has(i, L.progress) && !has(i, L.review) && !has(i, L.test) && !has(i, L.ok) && !has(i, L.failed)
        // Макет — часть постановки: пока его нет, тикет в разработку не уходит.
        // ready-for-dev при этом может стоять заранее, и это нормально.
        && !(has(i, L.mockup) && !has(i, L.mockupsReady)))
    }

    function pickQueued(project, issues) {
      const queued = queuedOf(project, issues)
      return queued.length > 0 ? queued[0] : null
    }

    // ── входная ступень: маршрут по постановке ─────────────────────────────

    // Человек ставит только ready-for-dev. Маршрут area:* отдел определяет сам
    // по тексту постановки: явные пути и расширения файлов — сильный признак,
    // словари ролей — слабый. Сомнение не разыгрывается: без уверенности метка
    // не ставится, и тикет берёт общий разработчик, который умеет оба дерева.
    const AREA_EXTENSIONS = {
      backend: ['.py', '.sql'],
      frontend: ['.tsx', '.jsx', '.css', '.scss', '.vue', '.svelte', '.html', '.ts', '.js'],
    }

    const AREA_WORDS = {
      backend: ['fastapi', 'эндпоинт', 'миграц', 'схем', 'pytest', 'ruff', 'mypy', 'alembic', 'сервер', 'бэкенд', 'backend', 'контракт', 'sql'],
      frontend: ['вёрстк', 'верстк', 'кнопк', 'компонент', 'экран', 'страниц', 'шапк', 'модал', 'фронтенд', 'frontend', 'react', 'tsx', 'vitest', 'eslint', 'prettier', 'интерфейс', 'макет', 'скриншот', 'css'],
    }

    function areaText(issue) {
      return String((issue.title || '') + '\n' + (issue.body || '')).toLowerCase()
    }

    // Разбор постановки. Возвращает { area, evidence, score }.
    // Сильные признаки — упоминание путей проекта и файлов с расширением: именно
    // они показывают, какое дерево придётся менять. Слова роли — слабый признак,
    // они встречаются и в чужой постановке, поэтому решают только когда сильных
    // признаков нет вовсе. Если сильные есть у обеих сторон, маршрут — fullstack:
    // лишняя половина работы дешевле, чем тикет, у которого не сделана половина.
    function classifyArea(project, issue) {
      const text = areaText(issue)
      const words = text.split(/[^a-zа-яё0-9._-]+/).filter(Boolean)
      const areas = areasOf(project)
      const score = {
        backend: { path: 0, ext: 0, word: 0 },
        frontend: { path: 0, ext: 0, word: 0 },
      }
      const evidence = { backend: [], frontend: [] }

      for (const side of ['backend', 'frontend']) {
        for (const prefix of areas[side]) {
          const needle = String(prefix || '').toLowerCase()
          if (!needle) continue
          const hits = text.split(needle).length - 1
          if (hits > 0) {
            score[side].path += hits
            evidence[side].push('путь ' + prefix)
          }
        }
        for (const ext of AREA_EXTENSIONS[side]) {
          const found = words.filter((w) => w.endsWith(ext)).length
          if (found > 0) {
            score[side].ext += found
            evidence[side].push('файлы ' + ext)
          }
        }
        for (const stem of AREA_WORDS[side]) {
          if (words.some((w) => w.indexOf(stem) === 0)) {
            score[side].word += 1
            evidence[side].push('слово ' + stem)
          }
        }
      }

      const strong = (side) => score[side].path > 0 || score[side].ext > 0
      if (strong('backend') && !strong('frontend')) {
        return { area: 'backend', evidence: evidence.backend, score: score }
      }
      if (strong('frontend') && !strong('backend')) {
        return { area: 'frontend', evidence: evidence.frontend, score: score }
      }
      if (strong('backend') && strong('frontend')) {
        return { area: 'fullstack', evidence: evidence.backend.concat(evidence.frontend), score: score }
      }

      const backend = score.backend.word
      const frontend = score.frontend.word
      if (backend > 0 && frontend === 0) return { area: 'backend', evidence: evidence.backend, score: score }
      if (frontend > 0 && backend === 0) return { area: 'frontend', evidence: evidence.frontend, score: score }
      if (backend > 0 && frontend > 0) {
        return { area: 'fullstack', evidence: evidence.backend.concat(evidence.frontend), score: score }
      }
      return { area: null, evidence: [], score: score }
    }

    function areaLabelOf(area, L) {
      return area === 'backend' ? L.areaBackend : area === 'frontend' ? L.areaFrontend : L.areaFullstack
    }

    function hasAnyArea(issue, L) {
      return has(issue, L.areaBackend) || has(issue, L.areaFrontend) || has(issue, L.areaFullstack)
    }

    // Ставит маршрут тикету, которому его не поставили. Возвращает действие, чтобы
    // следующий тик уже раздал задачу по метке, а не гадал повторно.
    async function assignArea(project, issues) {
      const L = project.labels
      const open = queuedOf(project, issues).filter((i) => !hasAnyArea(i, L))
      if (open.length === 0) return null
      const issue = open[0]
      const verdict = classifyArea(project, issue)
      if (!verdict.area) return null
      const label = areaLabelOf(verdict.area, L)
      await addLabel(project, issue.number, label)
      // Разметка — прогресс процесса, а не попытка исполнителя.
      projectState(project.id).attempts[issue.number] = 0
      const b = verdict.score.backend
      const f = verdict.score.frontend
      await postComment(project, issue.number, 'маршрут по постановке',
        'Маршрут по постановке — ' + label +
          ' (пути/файлы: бэкенд ' + (b.path + b.ext) + ', фронтенд ' + (f.path + f.ext) +
          '; слова: бэкенд ' + b.word + ', фронтенд ' + f.word + ').' +
          '\nПризнаки: ' + verdict.evidence.slice(0, 8).join(', ') + '.' +
          '\nЕсли маршрут не тот, поставь другую метку: ' +
          [L.areaBackend, L.areaFrontend, L.areaFullstack].join(', ') + '.')
      const st = projectState(project.id)
      if (st.run) {
        st.run.entries.push({
          number: issue.number,
          title: issue.title,
          role: 'маршрут',
          outcome: label + ' по постановке (пути/файлы: бэкенд ' + (b.path + b.ext) +
            ', фронтенд ' + (f.path + f.ext) + ')',
        })
      }
      return { action: 'routed', project: project.id, issue: issue.number, area: verdict.area, label }
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
      const role = presetId === 'dev-fullstack' ? 'Разработчик (полный стек)'
        : presetId === 'dev-backend' ? 'Бэкенд-разработчик'
          : presetId === 'dev-frontend' ? 'Фронтенд-разработчик'
            : presetId === 'design' ? 'Дизайнер'
              : presetId === 'tester' ? 'Тестировщик'
                : presetId === 'code-review' ? 'Код-ревьюер'
              : presetId === 'devops-delivery' ? 'DevOps-инженер'
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

    // Снять метку, которой может и не быть. Ошибку глотаем: отсутствие метки —
    // норма, а сбой сети не должен срывать шаг диспетчера.
    async function dropLabel(project, issueNumber, name) {
      return githubDropLabel(project, issueNumber, name)
    }

    // Пакетное снятие: метки тикета правятся одним issue_write, поэтому один
    // шаг уборки — одно чтение меток и одна запись, а не по запросу на метку.
    async function dropLabels(project, issueNumber, names) {
      try {
        await githubDropLabels(project, issueNumber, names)
        return true
      } catch (error) {
        return false
      }
    }

    // Поставить метку тикета. Повтор на уже стоящей метке ничего не пишет.
    async function addLabel(project, issueNumber, name) {
      return githubAddLabel(project, issueNumber, name)
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

    // Аргументы owner/repo для инструментов MCP: каждый инструмент GitHub
    // требует их явно, и угадывать по git remote роли не нужно — диспетчер
    // подставляет репозиторий проекта в само задание.
    function repoArgs(project) {
      const { owner, repo } = repoOf(project)
      return '"owner": ' + JSON.stringify(owner) + ', "repo": ' + JSON.stringify(repo)
    }

    // Как роль двигает метки. В MCP у тикета нет отдельных «поставь метку» и
    // «сними метку»: issue_write принимает полный набор меток и заменяет его
    // целиком, поэтому без этой памятки роль ищет несуществующий инструмент или
    // стирает чужие метки — и конвейер встаёт.
    function labelMechanics(project, issue) {
      return 'Метки двигаются одним инструментом: mcp__github__issue_write({ "method": "update", ' + repoArgs(project) +
        ', "issue_number": ' + issue.number + ', "labels": ["…"] }). Он ЗАМЕНЯЕТ набор меток целиком, поэтому сначала прочитай текущие через ' +
        'mcp__github__issue_read({ "method": "get_labels", ' + repoArgs(project) + ', "issue_number": ' + issue.number +
        ' }) и отправь их же вместе с нужной правкой — иначе пропадут метки маршрута и фазы.'
    }

    // Задание исполнителю. Ролей реализации три — полного стека, бэкендер и
    // фронтендер, — но путь, метки и отчёт у них общие: различаются границы
    // работы. Финальный шаг одинаков у всех — PR и for-code-review: передачу
    // полного стека фронтенду делает диспетчер по меткам, а не агент.
    function implementerPrompt(project, issue, kind, repeat, role, findingPaths, findingSource) {
      const L = project.labels
      const isBackend = role === 'dev-backend'
      const isFrontend = role === 'dev-frontend'
      const fullstack = has(issue, L.areaFullstack)
      const skillLine = isBackend || isFrontend
        ? 'Действуй по скиллам dev-workflow и role-boundaries'
        : 'Действуй по скиллу dev-workflow'
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
            : kind === 'stage'
              ? 'Отдел разработки: продолжай issue #' + issue.number + ' «' + issue.title + '» — бэкенд-часть уже сдана, настала очередь фронтенда.'
              : 'Отдел разработки: возьми issue #' + issue.number + ' «' + issue.title + '».',
        '',
        projectHeader(project),
        skillLine + ': прочитай постановку инструментом mcp__github__issue_read({ "method": "get", ' + repoArgs(project) + ', "issue_number": ' + issue.number + ' }), работай в ветке feature/' + issue.number + '-<слаг> от ' + project.base + ', доведи до pull request инструментом mcp__github__create_pull_request и передай на код-ревью.',
        'Обязательный финал: первой строкой комментария — `**Роль:** <имя роли> · <о чём>` (по этому заголовку диспетчер отличает твой отчёт от замечаний ревьюера), затем комментарий в issue инструментом mcp__github__add_issue_comment({ ' + repoArgs(project) + ', "issue_number": ' + issue.number + ', "body": "<первая строка — заголовок роли, дальше: что сделано, ветка, номер PR, что не проверено>" }), затем метка ' + L.review + ' и снятие ' + L.progress + '.',
        'В ' + project.base + ' и main не коммить. PR не мержить. Работай только в своей рабочей копии отдела ' + project.workspace +
          (project.humanClone ? ': в клон человека ' + project.humanClone + ' не заходить вообще.' : '.'),
        'Стенд поднимай только со своим именем проекта: docker compose -p ' + project.composeProject +
          ' ... Без -p docker возьмёт имя из docker-compose.yml и ты задешь стенд человека на его портах и его базе.',
        'После PR обязательно верни рабочую копию на ' + project.base + ': git checkout ' + project.base +
          ', затем git pull --ff-only. Незакоммиченных изменений в клоне остаться не должно.',
        'Ветка задачи может уже существовать: макет постановки кладёт её до разработки, а полный стек — до фронтенда. Если она есть — продолжай в ней и не открывай второй PR.',
        'Поставь себе цель, чтобы довести работу до конца: один ход не должен обрывать задачу на середине.',
        'Если упёрся в то, что сам решить не можешь, — напиши это комментарием в issue и остановись.',
      ]
      if (isBackend) {
        const own = areasOf(project).backend.join(', ')
        const boundary = ['Границы бэкендера: меняешь бэкенд-дерево ' + own + '. Фронтенд, компоненты и стили не трогай. Контракт — OpenAPI-схема, DTO и общие типы — твой: фронтендер его читает, а не догадывается.']
        if (fullstack) {
          boundary.push('Тикет полного стека: доведи бэкенд-часть до обычного финала. Метку ' + L.frontend + ' поставит диспетчер — тебе её ставить не нужно, фронтенд-часть не делай и фронтенд не жди.')
          boundary.push('Если бэкенд-части в постановке нет вовсе — пустой PR не открывай: напиши это комментарием в issue, поставь ' + L.review + ' и заверши ход. Диспетчер сам передаст тикет фронтенду.')
        }
        lines.splice(4, 0, ...boundary)
      }
      if (isFrontend) {
        const own = areasOf(project).frontend.join(', ')
        const boundary = ['Границы фронтендера: меняешь фронтенд-дерево ' + own + '. Бэкенд, схему и контракт не трогай — контракт только читаешь. Если API не хватает, это комментарий в issue и остановка, а не мок и не «временная» правка бэкенда.']
        if (fullstack) {
          boundary.unshift('Ветка и PR могут быть уже открыты бэкенд-части: если они есть — продолжай в них, второй PR не открывай. Если ветки и PR ещё нет (бэкенд-части в постановке не оказалось) — создай их сам.')
          boundary.push('Если фронтенд-части в постановке нет — пустой PR не открывай: напиши это комментарием в issue, поставь ' + L.review + ' и заверши ход.')
        }
        lines.splice(4, 0, ...boundary)
      }
      if (kind === 'rework') lines.splice(2, 0, 'Начни с комментариев в issue и в PR этого тикета: там причина отказа, замечания и воспроизводящая команда.')
      // Возврат закрывается галочками в чужом по роли чеклисте, а не ответными
      // комментариями: ответный комментарий не меняет маршрут, а следующий круг
      // читает именно непомеченные пункты исходного чеклиста.
      if (kind === 'rework') lines.splice(2, 0, 'Свои пункты закрывай галочками в самом комментарии ревьюера или тестировщика. Порядок: прочитай тело комментария — для PR mcp__github__pull_request_read({ "method": "get_comments", ' + repoArgs(project) + ', "pullNumber": <номер PR> }), для issue mcp__github__issue_read({ "method": "get_comments", ' + repoArgs(project) + ', "issue_number": ' + issue.number + ' }) — замени в нужных строках «- [ ] Б1» на «- [x] Б1», и запиши тело целиком через mcp__github__update_issue_comment({ ' + repoArgs(project) + ', "comment_id": <id>, "body": "<прочитанное тело с галочками>" }): инструмент заменяет тело, поэтому правка отправляется только целиком. Пункт, с которым не согласен, НЕ отмечай — аргумент идёт в тело PR через mcp__github__update_pull_request. В issue — одна короткая строка: «замечания ревью отработаны, PR #N, коммит <sha>» (после test-failed — «по замечаниям тестировщика отработано, коммит <sha>»).')
      if (kind === 'rework') lines.splice(2, 0, 'Это доработка №' + (projectState(project.id).rework[issue.number] || 0) + ' из ' + project.department.maxRework + ': её номер записан комментарием диспетчера в issue.')
      // Пути из замечаний — не украшение задания: по ним исполнитель сразу видит,
      // какие файлы его половины ревьюер назвал, и не ищет их в чужом дереве.
      if (kind === 'rework' && findingPaths && findingPaths.length > 0) {
        // Чьи это замечания, задание называет прямо и по факту прочитанного
        // источника: после test-failed это обычно чеклист тестировщика в issue
        // (а если его нет — круг ревьюера в PR), после ревью — комментарий в PR.
        lines.splice(2, 0, 'Замечания ' + (findingSource || 'ревьюера') + ' — в твоей половине: ' + findingPaths.slice(0, 5).map(findingLabel).join(', '))
      }
      // Макет постановки — часть задания, а не украшение: раскладку, состояния и
      // тексты берут из него, чтобы фронтендер не придумывал их заново.
      if (has(issue, L.mockupsReady)) {
        lines.splice(4, 0, 'Макет постановки лежит в ветке в mockups/' + issue.number + '/ (index.html и notes.md): раскладку, состояния и тексты бери из него, расхождения — только осознанные и описанные в комментарии. Скриншоты и пути есть в комментарии дизайнера.')
      }
      if (kind === 'continue') lines.splice(2, 0, 'Сначала посмотри, что уже сделано: ветка могла остаться, коммиты могли быть запушены, в issue может быть комментарий.')
      if (kind === 'stage') lines.splice(2, 0, 'Это ступень фронтенда: прочитай комментарий бэкендера в issue и изменённые файлы PR, чтобы работать с существующими эндпоинтами, а не с выдуманными.')
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, в котором шла работа по тикету: ветка, коммиты и замечания ревьюера или тестировщика уже в его истории — продолжай с этого места, заново ничего не поднимай.')
      lines.push(labelMechanics(project, issue))
      return lines.join('\n')
    }

    // Ступень постановки: макет, а не реализация. Дизайнер получает её раньше,
    // чем человек поставит ready-for-dev, поэтому финал другой: комментарий со
    // скриншотами и метка mockups-ready вместо for-code-review и PR.
    function mockupPrompt(project, issue, repeat) {
      const L = project.labels
      const artifacts = project.artifacts || (project.workspace + '\\.dsh-artifacts')
      const shot = artifacts + '\\mockups-' + issue.number
      const lines = [
        'Отдел разработки: подготовь МАКЕТ по issue #' + issue.number + ' «' + issue.title + '» (метка ' + L.mockup + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу mockup-delivery. Это ступень постановки, а не разработка: продуктовый код, стили приложения, схему данных и API не менять.',
        'Прочитай постановку целиком: mcp__github__issue_read({ "method": "get", ' + repoArgs(project) + ', "issue_number": ' + issue.number + ' }) — тело и метки; обсуждение — тем же инструментом с "method": "get_comments".',
        'Ветка: feature/' + issue.number + '-<слаг> от ' + project.base + '. Если такая ветка уже есть — продолжай в ней, вторую не создавай. Работай только в рабочей копии отдела ' + project.workspace + '.',
        'Макет — только в каталоге mockups/' + issue.number + '/: index.html со статичной разметкой и стилями на токенах проекта (без сборки, без внешних зависимостей) и notes.md — экраны, состояния (пусто, загрузка, ошибка), брейкпоинты, тексты и то, что в макет не входит.',
        'Смотри, что уже есть в репозитории: палитра, шрифты, отступы, готовые компоненты. Макет должен выглядеть как продолжение продукта, а не как чужая страница.',
        'Скриншоты для человека: node C:\\Users\\DiKsu\\.dsh\\tools\\mockup-shot.mjs --html mockups/' + issue.number + '/index.html --out ' + shot + '-1440.png --width 1440 (и ещё один с --width 375). PNG в репозиторий не коммить.',
        'Обязательный финал: первой строкой комментария — `**Роль:** дизайнер · <о чём>`; затем комментарий в issue инструментом mcp__github__add_issue_comment({ ' + repoArgs(project) + ', "issue_number": ' + issue.number + ', "body": "<заголовок роли, что нарисовано, пути файлов макета, пути PNG-скриншотов>" }) — вложение картинок MCP не умеет, поэтому скриншоты называются путями на диске рядом с комментарием; затем метка ' + L.mockupsReady + ' и снятие ' + L.progress + '.',
        'Метку ' + L.review + ' НЕ ставить и PR НЕ открывать: реализация и PR будут следующим шагом, после того как человек поставит ' + L.dev + '.',
        'В ' + project.base + ' и main не коммить, ветку не мержить' + (project.humanClone ? ', в клон человека ' + project.humanClone + ' не заходить вообще.' : '.'),
        'Если визуального слоя в задаче нет вовсе — комментарий в issue с объяснением, снять ' + L.mockup + ' и завершить ход: макет тут не нужен.',
        'Поставь себе цель, чтобы довести макет до конца: один ход не должен обрывать работу на середине.',
      ]
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже делал макет по этому тикету: посмотри свои прошлые файлы и замечания человека в комментариях — правь макет, а не начинай заново.')
      lines.push(labelMechanics(project, issue))
      return lines.join('\n')
    }

    function testerPrompt(project, issue, repeat) {
      const L = project.labels
      const lines = [
        (repeat ? 'Отдел разработки: ПОВТОРНО проверь issue #' : 'Отдел разработки: проверь issue #') + issue.number + ' «' + issue.title + '» (метка ' + L.test + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу testing-contract: найди PR инструментом mcp__github__list_pull_requests({ ' + repoArgs(project) + ', "state": "all", "perPage": 100, "sort": "updated", "direction": "desc" }) — это PR, у которого head-ветка начинается с feature/' + issue.number + '-; изменённые файлы — mcp__github__pull_request_read({ "method": "get_files", ' + repoArgs(project) + ', "pullNumber": <номер PR> }), дифф — тем же инструментом с "method": "get_diff". Разверни ветку через git worktree в отдельный каталог.',
        'Проверяй сам, а не по описанию из PR. Артефакты клади в ' + (project.artifacts || 'reports/') + '.',
        'Если в ветке есть макет постановки (mockups/' + issue.number + '/), сверь с ним экраны: раскладка, состояния (пусто, загрузка, ошибка) и тексты — это часть приёмки, расхождение и есть дефект.',
        'Стенд поднимай только со своим именем проекта: docker compose -p ' + project.composeProject +
          ' ... Без -p docker возьмёт имя из docker-compose.yml и ты задешь стенд человека на его портах и его базе.',
        'Вердикт — комментарий в issue инструментом mcp__github__add_issue_comment({ ' + repoArgs(project) + ', "issue_number": ' + issue.number + ', "body": "…" }), первой строкой — `**Роль:** тестировщик · <о чём>`: прошло — метка ' + L.ok + '; не прошло — ' + L.failed + ' и наименьшая воспроизводящая команда. В обоих случаях сними ' + L.test + ': тикет не должен остаться в очереди тестировщика.',
        'Продуктовый код и PR не править, PR не мержить. Поставь себе цель, чтобы довести проверку до конца.',
      ]
      // Дефекты — чеклистом в том же вердикте, теми же номерами, что у
      // ревьюера: разработчик закрывает свои пункты галочками, а маршрут
      // доработки читает непомеченные. Второй комментарий на дефект вернул бы
      // россыпь, из-за которой затевался тикет.
      lines.push('При `VERDICT: RED` дефекты идут чеклистом в ТОМ ЖЕ вердикте, двумя секциями `### Бэкенд` и `### Фронтенд`, пункты `- [ ] Б1 · <path:line> — что сломано · Случай: … · Правка: … · Воспроизведение: <команда>`: номер — префикс половины (Б/Ф) и сквозной номер по секции. Закрывать пункты будет разработчик галочками в твоём комментарии, поэтому по одному комментарию на дефект не пиши. `GREEN` — без пунктов и без секций.')
      if (repeat) {
        lines.splice(2, 0, 'Это тот же диалог, где ты уже проверял этот тикет: тикет возвращался в доработку. Сверься со своим прошлым вердиктом в комментариях и проверь в первую очередь то, что тогда сломалось.')
        lines.push('Если прошлый дефект исправлен и новых нет — метка ' + L.ok + '.')
      }
      lines.push(reworkCounterLine(project, issue))
      lines.push(labelMechanics(project, issue))
      return lines.join('\n')
    }

    // Номер следующего возврата. Счётчик доработок растёт на шаге выдачи, поэтому
    // ревьюер и тестировщик видят его до возврата — и пишут номер в свой
    // комментарий. Иначе по истории тикета не понять, который это круг.
    function reworkCounterLine(project, issue) {
      const rounds = projectState(project.id).rework[issue.number] || 0
      const limit = project.department.maxRework
      const next = rounds + 1
      return 'Счётчик доработок по тикету: ' + rounds + ' из ' + limit + '. ' +
        (next > limit
          ? 'Если вернёшь — это будет возврат №' + next + ' при лимите ' + limit + ': диспетчер снимет тикет с конвейера и позовёт человека, поэтому в комментарии перечисли все правки сразу.'
          : 'Если вернёшь — это будет возврат №' + next + ': укажи номер в заголовке комментария-чеклиста и в короткой строке в issue.')
    }

    // Код-ревьюер: читает PR и код вокруг него, замечания пишет в PR, а решение
    // отдаёт меткой. Продуктовый код он не правит и стенд не поднимает.
    function reviewPrompt(project, issue, repeat) {
      const L = project.labels
      const lines = [
        (repeat ? 'Отдел разработки: ПОВТОРНО проверь код по issue #' : 'Отдел разработки: проверь код по issue #') + issue.number + ' «' + issue.title + '» (метка ' + L.review + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу code-review: найди PR инструментом mcp__github__list_pull_requests({ ' + repoArgs(project) + ', "state": "all", "perPage": 100, "sort": "updated", "direction": "desc" }) — это PR, у которого head-ветка начинается с feature/' + issue.number + '-; изменённые файлы — mcp__github__pull_request_read({ "method": "get_files", ' + repoArgs(project) + ', "pullNumber": <номер PR> }), дифф — тем же инструментом с "method": "get_diff"; затем сам дифф и код вокруг него в рабочей копии отдела ' + project.workspace + '.',
        'Замечания — ОДНИМ комментарием В PR через mcp__github__add_issue_comment({ ' + repoArgs(project) + ', "issue_number": <номер PR>, "body": "<заголовок, вердикт, сводка, чеклист>" }) — PR для этого инструмента такой же issue. Первой строкой — `**Роль:** код-ревьюер · <о чём>`, второй — строка вердикта. Внутри — чеклист двумя секциями `### Бэкенд` и `### Фронтенд`, пункты `- [ ] Б1 · <path:line> — что не так · Случай: … · Правка: … · Если не править: …`: номер — префикс половины (Б/Ф) и сквозной номер по секции. По одному комментарию на замечание НЕ пиши: по непомеченным пунктам этого одного комментария диспетчер строит маршрут доработки. Пункт, найденный позже, дописывай в ТОТ ЖЕ комментарий: прочитай его тело через mcp__github__pull_request_read({ "method": "get_comments", ' + repoArgs(project) + ', "pullNumber": <номер PR> }) и запиши целиком с новым пунктом через mcp__github__update_issue_comment({ ' + repoArgs(project) + ', "comment_id": <id>, "body": "<прочитанное тело с новым пунктом>" }).',
        'Обязательный финал: первой строкой комментария — `**Роль:** код-ревьюер · <о чём>`, второй строкой — вердикт `SHIP` / `FIX: <n>` / `BLOCKED` (разбор примет его и в самом заголовке: `**Роль:** код-ревьюер · вердикт FIX: 2`); решение — меткой: принял → ' + L.test + ' и снять ' + L.review + '; нужны правки → ' + L.dev + ' и снять ' + L.review + '. В issue — одна короткая строка, и ничего больше: «ревью пройдено, PR #<номер>» либо «вернул: <n> пунктов в комментарии PR #<номер>».',
        'Если в ветке PR есть макет постановки (mockups/<номер>/), сверь изменение с ним: раскладка, состояния и тексты из макета — часть задания, расхождение без объяснения в PR — замечание.',
        'Продуктовый код не править, PR не мержить, стенд не поднимать — прогон и приёмочные слои принадлежат тестировщику.',
        'В ' + project.base + ' и main не коммитить и не переключать ветки в рабочей копии: ревью читает, а не строит.' +
          (project.humanClone ? ' В клон человека ' + project.humanClone + ' не заходить.' : ''),
        'Поставь себе цель, чтобы довести ревью до конца: тикет не должен остаться без метки.',
      ]
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже ревьюил этот тикет: твои прошлые замечания и правки разработчика в его истории — проверь в первую очередь то, что тогда вернул.')
      lines.push(reworkCounterLine(project, issue))
      // Первая половина полного стека ревьюится отдельно и раньше фронтенда:
      // иначе контракт и серверная логика едут в тест непроверенными.
      if (has(issue, L.areaFullstack) && !has(issue, L.phaseFrontend)) {
        lines.splice(2, 0,
          'Это ПЕРВАЯ половина тикета полного стека: фронтенд-часть ещё не начата. Ревьюй бэкенд-часть по существу — контракт, обработчики, данные, миграции. Отсутствие экранов, кнопок и клиентской связки дефектом не считай: вторая половина идёт следом, в той же ветке.')
        lines.push('Принял — ' + L.test + ' означает «половина принята»: диспетчер сам передаст тикет фронтенду, тестировщику он уйдёт только после второй половины.')
      }
      lines.push(labelMechanics(project, issue))
      return lines.join('\n')
    }

    // Финальная ступень. Тикет с меткой tested уже получил зелёный вердикт от
    // тестировщика; DevOps-инженер сливает PR merge-коммитом, удаляет ветку
    // задачи и переводит тикет в merged. Слияние — единственная запись в базовую
    // ветку, которую делает агент.
    function mergePrompt(project, issue, repeat) {
      const L = project.labels
      const lines = [
        (repeat ? 'Отдел разработки: ПОВТОРНО слей PR по issue #' : 'Отдел разработки: слей PR по issue #') + issue.number + ' «' + issue.title + '» (метка ' + L.ok + ').',
        '',
        projectHeader(project),
        'Действуй по скиллу devops-delivery, раздел «Слияние pull request»: найди PR инструментом mcp__github__list_pull_requests({ ' + repoArgs(project) + ', "state": "all", "perPage": 100, "sort": "updated", "direction": "desc" }) — это PR, у которого head-ветка начинается с feature/' + issue.number + '-; вердикт тестировщика читай в issue через mcp__github__issue_read({ "method": "get_comments", ' + repoArgs(project) + ', "issue_number": ' + issue.number + ' }), изменение — через mcp__github__pull_request_read({ "method": "get_files", ' + repoArgs(project) + ', "pullNumber": <PR> }).',
        'Перед слиянием убери артефакты постановки: если в ветке PR есть каталог mockups/' + issue.number + ', удали его отдельным коммитом (git rm -r mockups/' + issue.number + ', сообщение «Убрать макеты постановки (#' + issue.number + ')»), запушь в ветку и только потом сливай. В ' + project.base + ' макеты попадать не должны; в истории git они остаются. Если каталога нет — пропусти этот шаг молча.',
        'Слияние — mcp__github__merge_pull_request({ ' + repoArgs(project) + ', "pullNumber": <PR>, "merge_method": "merge" }): merge-коммит в ' + project.base + ', ветка задачи удаляется. Force-push, ребейз и правки кода в чужой ветке запрещены.',
        'Обязательный финал: первой строкой комментария — `**Роль:** DevOps-инженер · <о чём>`; затем комментарий в issue инструментом mcp__github__add_issue_comment({ ' + repoArgs(project) + ', "issue_number": ' + issue.number + ', "body": "<sha merge-коммита и удалённая ветка>" }), затем снять ' + L.ok + ', снять ' + L.phaseFrontend + ' (если он есть) и поставить ' + L.merged + '.',
        'PR нет или вердикт тестировщика не зелёный — комментарий в issue и остановка: это сломанная передача, её разбирает человек.',
        'PR конфликтует с ' + project.base + ' — комментарий с конфликтующими файлами, метка ' + L.dev + ' вместо ' + L.ok + ': тикет возвращается разработчику, слияние не форсируется.',
        'PR уже слит (человеком раньше) — это не ошибка: комментарий с sha и метка ' + L.merged + ', снять ' + L.ok + '.',
        'После слияния верни рабочую копию отдела ' + project.workspace + ' на ' + project.base + ': git checkout ' + project.base + ', затем git pull --ff-only.',
        'Стенд не поднимай: слияние не требует прогона, а лишний стенд займёт порты проекта.',
        'Поставь себе цель, чтобы довести слияние до конца: тикет не должен остаться без метки.',
      ]
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже сливал этот тикет: проверь, не слит ли PR уже, и не дублируй слияние.')
      lines.push(labelMechanics(project, issue))
      return lines.join('\n')
    }

    // Ступень слияния для тикетов, у которых PR уже слит руками: старые тикеты с
    // меткой tested и ручной мерж. Гонять на такой тикет сессию DevOps-инженера
    // бессмысленно — состояние дописывается по факту.
    async function settleAlreadyMerged(project, issues) {
      const L = project.labels
      const waiting = issues.filter((i) => has(i, L.ok))
      if (waiting.length === 0) return null
      for (const issue of waiting) {
        let pr = null
        try {
          pr = await findPr(project, issue.number)
        } catch (error) {
          // GitHub не ответил — оставляем тикет ступени слияния как есть.
          continue
        }
        if (!pr || !pr.merged_at) continue
        await postComment(project, issue.number, 'PR уже слит руками',
          'PR #' + pr.number + ' уже слит (' + pr.merged_at +
            ') — снимаю ' + L.ok + ' и ставлю ' + L.merged + ' без сессии DevOps-инженера.')
        await addLabel(project, issue.number, L.merged)
        // Макет постановки ушёл в историю вместе со слиянием: метки ступени
        // больше ничего не значат и только путают следующий шаг. Снимаем их
        // одним запросом: набор меток тикета правится целиком.
        await dropLabels(project, issue.number, [L.ok, L.phaseFrontend, L.frontend, L.mockup, L.mockupsReady])
        const st = projectState(project.id)
        if (st.run) {
          st.run.entries.push({
            number: issue.number,
            title: issue.title,
            role: 'devops-delivery',
            outcome: 'PR #' + pr.number + ' уже был слит — тикет переведён в ' + L.merged,
          })
        }
        return { action: 'merged-already', project: project.id, issue: issue.number, pr: pr.number }
      }
      return null
    }

    // Передача тикета полного стека фронтенду. Три состояния, и каждое требует
    // своего решения:
    //   1. бэкендер поставил for-code-review и открыл PR — ревьюер смотрит первую
    //      половину; передача ждёт его вердикта;
    //   2. ревьюер принял (ready-for-test), фазы фронтенда ещё нет — передаём
    //      тикет фронтенду, тестировщику он уйдёт только после второй половины;
    //   3. for-code-review без PR — бэкенд-части в постановке не было, смотреть
    //      ревьюеру нечего: сразу передаём фронтенду.
    async function handOffToFrontend(project, issues) {
      const L = project.labels
      const candidates = issues.filter((i) => has(i, L.areaFullstack)
        && !has(i, L.phaseFrontend)
        && (has(i, L.review) || has(i, L.test)))
      if (candidates.length === 0) return null
      for (const issue of candidates) {
        let pr = null
        try {
          pr = await findPr(project, issue.number)
        } catch (error) {
          // GitHub не ответил: не решаем за ревьюера и не передаём вслепую.
          return null
        }
        if (has(issue, L.review) && pr) return null
        const fromLabel = has(issue, L.test) ? L.test : L.review
        const reason = pr ? 'бэкенд-часть прошла код-ревью' : 'бэкенд-части в постановке не было'
        await dropLabels(project, issue.number, [fromLabel, L.review])
        await addLabel(project, issue.number, L.frontend)
        // Передача — это прогресс диспетчера, а не неудачная попытка агента:
        // счётчик обнуляем, иначе вторая половина сгорала бы на первом же шаге.
        projectState(project.id).attempts[issue.number] = 0
        await postComment(project, issue.number, 'тикет передан фронтенд-разработчику',
          reason + ' — тикет передан фронтенд-разработчику (' + L.frontend +
            '). Он продолжит в той же ветке и том же PR. Код-ревью и тест будут после второй половины.')
        const st = projectState(project.id)
        if (st.run) {
          st.run.entries.push({
            number: issue.number,
            title: issue.title,
            role: 'dev-backend',
            outcome: reason + ' — передано фронтенду (' + L.frontend + ')',
          })
        }
        return { action: 'handoff', project: project.id, issue: issue.number, issueTitle: issue.title, reason }
      }
      return null
    }

    // ── ступень постановки: макет ──────────────────────────────────────────

    // Тикет, которому автор постановки поставил needs-mockup, проходит через
    // дизайнера раньше разработки. Ступень работает без ready-for-dev: макет —
    // часть постановки, и человек ставит свою метку уже по готовому визуальному
    // ответу. Как только дизайнер поставил mockups-ready, тикет становится
    // обычной очередью разработки (см. queuedOf).
    function mockupStage(project, issues) {
      const L = project.labels
      const st = projectState(project.id)
      const waiting = issues.filter((i) => has(i, L.mockup)
        && !has(i, L.mockupsReady)
        && !has(i, L.progress)
        && !has(i, L.review)
        && !has(i, L.test)
        && !has(i, L.ok)
        && !has(i, L.merged)
        && !st.dropped[i.number])
      if (waiting.length === 0) return null
      return { role: 'design', issue: waiting[0], kind: 'mockup' }
    }

    // ── один шаг диспетчера по проекту ─────────────────────────────────────

    // Ревизия, которую ревьюер уже смотрел. Живёт в памяти диспетчера, как
    // счётчики: после перезапуска DSH поведение откатывается к «позвать
    // ревьюера» — осознанный деграйд, зависнуть тикет не может.
    async function reviewHead(project, issue) {
      let pr = null
      try {
        pr = await findPr(project, issue.number)
      } catch (error) {
        // GitHub не ответил — не решаем за ревьюера, зовём как обычно.
        state.lastError = 'PR #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      if (!pr || !pr.head || !pr.head.sha) return null
      const sha = String(pr.head.sha)
      return { sha, same: projectState(project.id).reviewedHead[issue.number] === sha }
    }

    // Снятие тикета с конвейера: одна уборка на все поводы — лимит попыток, лимит
    // доработок, два круга ревью без нового коммита. Метки снимаются все до одной:
    // иначе снятый тикет остаётся в очереди, человек ставит ready-for-dev, и цикл
    // «снят → возвращён → снят» крутится каждый тик.
    async function dropFromPipeline(project, issue) {
      const L = project.labels
      // Одна правка на всю уборку: набор меток тикета пишется целиком.
      await dropLabels(project, issue.number, [L.progress, L.review, L.failed, L.test, L.frontend, L.phaseFrontend, L.ok, L.dev, L.mockup, L.mockupsReady])
      for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design', 'tester', 'code-review', 'devops-delivery']) {
        forgetDialog(project, presetId, issue.number)
      }
      const st = projectState(project.id)
      st.dropped[issue.number] = true
      // Снятый тикет начинается заново: ни истории ревизий, ни пустых кругов.
      delete st.reviewedHead[issue.number]
      delete st.noop[issue.number]
      delete st.findings[issue.number]
    }

    async function dispatch(project, decision) {
      const st = projectState(project.id)
      const L = project.labels
      const { role, issue } = decision
      // Ревизия, на которой сейчас выдаётся ревью. Записывается в reviewedHead
      // только после того, как сессия ревьюера создана: упавшее создание сессии
      // не должно превращаться в «ветка не менялась» на следующем тике.
      let reviewSha = null
      // Сторож пустого круга. Если разработчик закончил ход, не запушив коммит, а
      // метку for-code-review переставил, ревьюер увидел бы ту же ревизию, что и в
      // прошлый раз: круг без нового коммита не тратит ни ревью, ни бюджет
      // доработок, а доработка уходит владельцу замечаний.
      if (role === 'code-review') {
        const head = await reviewHead(project, issue)
        if (head && head.same) {          st.noop[issue.number] = (st.noop[issue.number] || 0) + 1
          if (st.noop[issue.number] >= 2) {
            // Второй круг подряд: выдавать нечего, поэтому и обещания выдачи нет —
            // только комментарий о снятии, иначе в тикете остались бы два
            // взаимоисключающих следа («уходит разработчику» и «снят»).
            try {
              await postComment(project, issue.number, 'два круга без коммита',
                'Ревизия ' + head.sha + ' так и не сменилась: два круга подряд без нового коммита. ' +
                  'Тикет снят с конвейера, нужен человек: поставь ' + L.dev +
                  ', и счётчики вместе с диалогами обнулятся.')
            } catch (error) {
              state.lastError = 'комментарий о снятии после пустых кругов: ' + (error && error.message ? error.message : String(error))
            }
            await dropFromPipeline(project, issue)
            if (st.run) st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера: два круга подряд без нового коммита' })
            return { action: 'dropped', project: project.id, issue: issue.number, reason: 'two review rounds without a new commit' }
          }
          const owner = await roleForRework(project, issue, L)
          try {
            await postComment(project, issue.number, 'ветка не менялась',
              'С прошлого ревью ревизия ' + head.sha + ' та же: ветка не менялась с прошлого ревью, ' +
                'ревьюера не зову. Доработка уходит ' + owner + '.')
          } catch (error) {
            state.lastError = 'комментарий о неизменённой ревизии: ' + (error && error.message ? error.message : String(error))
          }
          // Круг без коммита не считается доработкой: возвращаем счётчик назад,
          // чтобы пустые круги не съедали бюджет задачи.
          st.rework[issue.number] = Math.max(0, (st.rework[issue.number] || 0) - 1)
          return dispatch(project, { role: owner, issue: issue, kind: 'rework' })
        }
        if (head) reviewSha = head.sha
      }
      const attempts = (st.attempts[issue.number] || 0) + 1
      st.attempts[issue.number] = attempts
      if (attempts > project.department.maxAttempts) {
        // Задача выдавалась несколько раз и ни разу не сдвинулась: молча
        // падающая сессия не должна крутить попытки без остановки.
        // ready-for-dev снимаем вместе с остальными: иначе снятый тикет остаётся
        // в очереди, человек его снова ставит, и цикл «снят → возвращён → снят»
        // крутится каждый тик, засыпая issue комментариями.
        await postComment(project, issue.number, 'задача снята с конвейера, нужен человек',
          'Задача выдавалась ' + (attempts - 1) + ' раз(а) и не сдвинулась — снимаю с конвейера, нужен человек.')
        // Снятый тикет не возвращается сам: иначе агент, который всё ещё работает
        // по нему, поставит метку, диспетчер снова выдаст задачу и снова снимет —
        // и так по кругу с новым комментарием каждый раз.
        await dropFromPipeline(project, issue)
        st.run.entries.push({ number: issue.number, title: issue.title, role: role, outcome: 'снят с конвейера после ' + (attempts - 1) + ' попыток без результата' })
        return { action: 'dropped', project: project.id, issue: issue.number, reason: 'no progress after ' + (attempts - 1) + ' attempts' }
      }
      // Ступень макета: финал другой — комментарий со скриншотами и
      // mockups-ready. Бюджет доработок разработки эта ступень не тратит, а
      // ready-for-dev не снимается: человек мог поставить его заранее, и по
      // готовому макету задача уйдёт в разработку сама.
      if (role === 'design' && (decision.kind === 'mockup' || decision.kind === 'mockup-rework')) {
        const repeat = existingDialog(project, 'design', issue.number)
        await addLabel(project, issue.number, L.progress)
        const sessionId = await startSession(project, 'design', mockupPrompt(project, issue, repeat), issue)
        st.session = { role: 'design', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'design', stage: 'mockup', issue: issue.number, sessionId }
      }
      if (role === 'dev-fullstack' || role === 'dev-backend' || role === 'dev-frontend') {
        const kind = decision.kind || 'new'
        const rounds = st.rework[issue.number] || 0
        if (kind === 'rework' && rounds >= project.department.maxRework) {
          await postComment(project, issue.number, 'лимит доработок исчерпан',
            'Этот возврат был бы №' + (rounds + 1) + ' при лимите ' + project.department.maxRework +
              '. Тикет снят с конвейера, нужен человек: поставь ' + L.dev +
              ', и счётчики вместе с диалогами обнулятся.')
          await dropFromPipeline(project, issue)
          st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера после ' + rounds + ' доработок' })
          return { action: 'dropped', project: project.id, issue: issue.number, reason: 'too many rework rounds' }
        }
        if (kind === 'rework') st.rework[issue.number] = rounds + 1
        // Пути из замечаний, по которым выбран маршрут: половина и до пяти путей
        // уходят в задание, до трёх — в комментарий тикета. След маршрута в тикете
        // один, и он же объясняет, почему доработка ушла этой роли.
        const findings = kind === 'rework' ? takeFindings(st, issue.number, role) : { paths: [], source: '' }
        const findingPaths = findings.paths
        if (kind !== 'rework') delete st.findings[issue.number]
        // Счётчик доработок живёт в памяти диспетчера и в тикете нигде не
        // виден. Пишем номер круга в issue: по комментариям должно быть
        // понятно, который это возврат из ревью или теста.
        if (kind === 'rework') {
          try {
            await postComment(project, issue.number,
              'доработка №' + (rounds + 1) + ' из ' + project.department.maxRework,
              'Возврат ' + (has(issue, L.failed) ? 'из теста' : 'из код-ревью') +
                findingsTrace(role, findingPaths) + '.')
          } catch (error) {
            state.lastError = 'комментарий о номере доработки: ' + (error && error.message ? error.message : String(error))
          }
        }
        // Захват нормализуем здесь, а не в агенте: у конвейера должен оставаться
        // ровно один активный маркер, иначе следующий шаг неоднозначен.
        if (kind === 'new' || kind === 'rework' || kind === 'stage') {
          await addLabel(project, issue.number, L.progress)
          // Возврат из ревью приходит с ready-for-dev, из теста — с test-failed,
          // ступень фронтенда — с ready-for-frontend; снимаем всё, чтобы на тикете
          // не осталось чужого шага.
          const stale = [L.dev, L.failed, L.review]
          if (kind === 'stage') stale.push(L.frontend)
          await dropLabels(project, issue.number, stale)
        }
        // Фаза фронтенда полного стека помечается меткой, которая переживает
        // in-progress: по ней диспетчер понимает, кому продолжать и кому
        // возвращать доработку, если ход завис или ревьюер вернул тикет.
        if (role === 'dev-frontend' && has(issue, L.areaFullstack)) {
          try {
            await addLabel(project, issue.number, L.phaseFrontend)
          } catch (error) {
            state.lastError = 'метка фазы фронтенда: ' + (error && error.message ? error.message : String(error))
          }
        }
        const prompt = implementerPrompt(project, issue, kind, !!existingDialog(project, role, issue.number), role, findingPaths, findings.source)
        const sessionId = await startSession(project, role, prompt, issue)
        st.session = { role: role, issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: role, issue: issue.number, sessionId }
      }

      if (role === 'devops-delivery') {
        const sessionId = await startSession(project, 'devops-delivery', mergePrompt(project, issue, !!existingDialog(project, 'devops-delivery', issue.number)), issue)
        st.session = { role: 'devops-delivery', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'devops-delivery', issue: issue.number, sessionId }
      }

      if (role === 'code-review') {
        const sessionId = await startSession(project, 'code-review', reviewPrompt(project, issue, !!existingDialog(project, 'code-review', issue.number)), issue)
        // Сессия создана — только теперь ревизия считается показанной ревьюеру;
        // новый коммит обнуляет накопленные пустые круги.
        if (reviewSha) {
          st.reviewedHead[issue.number] = reviewSha
          delete st.noop[issue.number]
        }
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
      if (!st.run) {
        // Вне смены работа не идёт, но входная ступень — это книга, а не ход
        // агента: маршрут ставится сразу, чтобы человек увидел, кому уйдёт
        // задача, не дожидаясь окна. Раздачи задачи здесь нет и быть не может:
        // assignArea только размечает тикет.
        try {
          const routed = await assignArea(project, await loadIssues(project))
          if (routed) return routed
        } catch (error) {
          state.lastError = project.id + ': входная ступень: ' + (error && error.message ? error.message : String(error))
        }
        return null
      }

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
          // Ход снят до работы: ревизию ревьюер не видел, и сторож пустого круга
          // должен начаться заново, иначе снятая сессия выдаст себя за просмотр.
          if (stuck.role === 'code-review') delete st.reviewedHead[stuck.issue]
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
          // Ход не начался — ревьюер ревизию не смотрел. Забываем записанный head,
          // иначе следующий тик объявит пустой круг по ветке, которой никто не
          // видел, и спишет это на «разработчик не запушил».
          if (finished.role === 'code-review') delete st.reviewedHead[finished.issue]
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
          const outcome = marks.indexOf(L.merged) !== -1 ? 'слито в ' + project.base
            : marks.indexOf(L.ok) !== -1 ? 'принято тестировщиком'
              : marks.indexOf(L.failed) !== -1 ? 'возвращено в доработку'
                : marks.indexOf(L.review) !== -1 ? 'ждёт код-ревью'
                  : marks.indexOf(L.test) !== -1 ? 'ждёт тестировщика'
                    // Дизайнер сдал макет постановки: дальше ждём метку человека.
                    : marks.indexOf(L.mockupsReady) !== -1 ? 'макет постановки готов, ждёт человека'
                    // Ревьюер вернул тикет разработчику: метка снова ready-for-dev.
                    // Это движение по конвейеру, а не «без изменения меток».
                    : finished.role === 'code-review' && marks.indexOf(L.dev) !== -1 ? 'код-ревьюер вернул в доработку'
                      // DevOps вернул тикет из-за конфликта слияния: тоже движение.
                      : finished.role === 'devops-delivery' && marks.indexOf(L.dev) !== -1 ? 'слияние невозможно: возвращено разработчику'
                        : 'без изменения меток'
          // Тикет слит — диалоги по нему закрыты, служебная метка фазы снята.
          // Только диспетчер знает, что фаза закончилась; если оставить метку,
          // по ней будут думать, что на тикет надо как-то реагировать.
          if (outcome === 'слито в ' + project.base) {
            for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design', 'tester', 'code-review', 'devops-delivery']) {
              forgetDialog(project, presetId, finished.issue)
            }
            await dropLabel(project, finished.issue, L.phaseFrontend)
            await dropLabel(project, finished.issue, L.frontend)
            await dropLabel(project, finished.issue, L.mockup)
            await dropLabel(project, finished.issue, L.mockupsReady)
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

      // Тикет, снятый с конвейера, ждёт человека. Признак, что человек вернул его
      // в работу, один — метка ready-for-dev: её ставит только человек. Тогда
      // бюджет выдаётся заново целиком: и попытки, и доработки, и диалоги.
      // Иначе снятый по лимиту доработок тикет снова упирался бы в тот же лимит
      // на первом же шаге — человек возвращает задачу, а она мгновенно снимается.
      for (const issue of issues) {
        if (!st.dropped[issue.number]) continue
        if (!has(issue, L.dev)) continue
        delete st.dropped[issue.number]
        st.attempts[issue.number] = 0
        delete st.rework[issue.number]
        // Сторож пустого круга начинается заново: человек вернул задачу в работу,
        // и прошлая ревизия больше ничего не значит.
        delete st.reviewedHead[issue.number]
        delete st.noop[issue.number]
        delete st.findings[issue.number]
        for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design']) {
          forgetDialog(project, presetId, issue.number)
        }
        st.run.entries.push({ number: issue.number, title: issue.title, role: 'человек', outcome: 'тикет возвращён в работу, попытки и доработки сброшены' })
      }

      // Полный стек: код-ревью после бэкенд-части — ещё не весь тикет. Диспетчер
      // сам снимает for-code-review и ставит ступень фронтенда, чтобы фронтенд
      // лёг в ту же ветку и тот же PR, а не в отдельный.
      const handoff = await handOffToFrontend(project, issues)
      if (handoff) return handoff

      const settled = await settleAlreadyMerged(project, issues)
      if (settled) return settled

      // Входная ступень: маршрут ставится по постановке, до раздачи исполнителю.
      const routed = await assignArea(project, issues)
      if (routed) return routed

      const active = await findActive(project, issues)
      if (active) return dispatch(project, active)

      // Активного тикета нет — можно взять следующий, но только пока открыт
      // хотя бы один диапазон работы.
      if (inWin || opts.ignoreWindow) {
        // Ступень постановки идёт раньше раздачи новых задач, но позже активных
        // ступеней: ревью, тест и слияние доводят уже начатую работу, а макет
        // только открывает следующую.
        const mockupQueued = mockupStage(project, issues)
        if (mockupQueued) return dispatch(project, mockupQueued)
        const queued = pickQueued(project, issues)
        // Тикет вернулся с код-ревью: метка ready-for-dev, но диалог исполнителя
        // по нему уже был. Это доработка, а не новая задача — иначе пара
        // исполнитель↔code-review качалась бы без ограничения.
        if (queued) {
          const rework = anyImplementerDialog(project, queued)
          const role = rework
            ? await roleForRework(project, queued, project.labels)
            : implementer(queued, project.labels)
          return dispatch(project, { role: role, issue: queued, kind: rework ? 'rework' : 'new' })
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
                kind: active.kind || (active.role === 'tester' ? 'test' : active.role === 'code-review' ? 'review' : active.role === 'devops-delivery' ? 'merge' : 'new'),
                labels: labelsOf(active.issue),
              }
              : null
            row.queuedForDev = queued.map((i) => ({ number: i.number, title: i.title }))
            row.nextStep = active
              ? (active.role === 'code-review'
                ? 'поднять code-review по issue #' + active.issue.number
                : active.role === 'tester'
                  ? 'поднять tester по issue #' + active.issue.number
                  : 'поднять ' + active.role + ' по issue #' + active.issue.number + ' (' + (active.kind || 'new') + ')')
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

    // Рабочие области агентов. Диспетчер заводит область проекта сам, но
    // только в момент выдачи первой задачи (projectWorkspace): до неё области
    // нет ни в списке рабочих областей GUI, ни у ручных сессий ролей, открытых
    // по явному пути. Инструмент заводит их все сразу — по реестру проектов,
    // включая проекты с выключенным отделом, — и заодно говорит, чему на диске
    // ещё не место. Задачи не берёт, смену не открывает, сессий не создаёт:
    // workspaceRegistry.create идемпотентен и возвращает уже заведённую область.
    const workspacesTool = define(
      'dev_department_workspaces',
      'Завести рабочие области агентов в реестре рабочих областей DSH для всех проектов из ~/.dsh/projects.json (включая проекты с выключенным отделом) и сказать, у какого проекта нет каталога или git-клона. Повторный вызов ничего не дублирует: заведённая область возвращается как есть.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        config = loadConfig()
        let registry
        try {
          registry = readRegistry()
        } catch (error) {
          return { error: error && error.message ? error.message : String(error), projects: [] }
        }
        const rows = []
        for (const id of registry.ids) {
          const project = projectRow(registry, id, config.values)
          const row = {
            id,
            title: project.title,
            workspace: project.workspace,
            department: project.department.enabled,
            result: null,
            workspaceTitle: null,
          }
          if (!project.workspace) { row.result = 'пропущен: не задан workspace'; rows.push(row); continue }
          if (!fs.existsSync(project.workspace)) { row.result = 'пропущен: каталога нет — сначала склонируйте репозиторий'; rows.push(row); continue }
          if (!fs.existsSync(path.join(project.workspace, '.git'))) { row.result = 'пропущен: каталог не git-клон'; rows.push(row); continue }
          try {
            const existing = await workspaceRegistry.resolveByPath(project.workspace)
            if (existing) {
              row.result = 'уже заведена'
              row.workspaceTitle = existing.title
            } else {
              const created = await workspaceRegistry.create(project.workspace, project.title + ' — отдел')
              row.result = 'заведена'
              row.workspaceTitle = created && created.title ? created.title : project.title + ' — отдел'
            }
          } catch (error) {
            row.result = 'ошибка: ' + (error && error.message ? error.message : String(error))
          }
          rows.push(row)
        }
        return {
          served: rows.filter((r) => r.result === 'уже заведена' || r.result === 'заведена').length,
          projects: rows,
        }
      },
    )

    ctx.effect(() => tools.register(statusTool), 'dev-department:status')
    ctx.effect(() => tools.register(tickTool), 'dev-department:tick')
    ctx.effect(() => tools.register(summaryTool), 'dev-department:summary')
    ctx.effect(() => tools.register(workspacesTool), 'dev-department:workspaces')

    // Плагин выгружается (перезапуск профиля, HMR) — сервер GitHub гасим сами:
    // иначе осиротевший процесс держал бы соединение до закрытия приложения.
    ctx.effect(() => () => mcpReset(), 'dev-department:mcp')

    ctx.effect(() => ctx.interval(() => {
      step({}).catch((error) => { state.lastError = String(error && error.message ? error.message : error) })
    }, TICK_MS), 'dev-department:interval')
  },
}
