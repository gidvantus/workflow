// Отдел разработки — диспетчер ролей, многопроектный, со своим отделом в каждом
// проекте.
//
// ГДЕ ЧТО ЛЕЖИТ. Состояние отдела живёт в каталоге профиля, а не в корне каталога
// установки: `dsh plugin add` переустанавливает пакет, и файл рядом с модулем
// исчезал бы вместе с прежней версией. Каталог и перенос со старого места называет
// `./state-paths.mjs` — здесь только имена:
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/projects.json
//                            — проекты: repo, base, workspace, composeProject,
//                              метки и секция department (включён ли отдел,
//                              расписание, лимиты).
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department.json
//                            — только ОБЩИЕ значения по умолчанию для тех
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
// <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department-dialogs.json и
// переживает перезапуск приложения. Значение — `{ session, workspace }`; диалог
// продолжается только в той же рабочей копии, иначе ключ ротируется (см.
// `startSessionWork`).
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
// Нет ревизии — ревьюер не зовётся: пустой ход половины записывается в
// noWork проекта, и если работы не дала ни одна роль маршрута, тикет снимается со
// всеми метками (area:* в том числе) и ждёт человека. Снятый тикет не берут ни
// findActive(), ни queuedOf(), пока человек не вернёт его меткой ready-for-dev:
// живая сессия, дописавшая метку после снятия, иначе завезла бы тикет обратно.
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
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STATE_FILES, dshHome, legacyFile, readStateFile, stateDir, stateFile } from './state-paths.mjs'
// Роли и скиллы правятся в вебе, а раскладываются в `~/.dsh/.agent-presets`:
// сверку источника с раскладкой держит отдельный модуль, чтобы у диспетчера не
// было второй копии разбора `SKILL.md` и сборки композиции.
import { readRemovedRoles, syncPresets } from './presets.mjs'
// Форма реестра проектов известна одному модулю: диспетчер, мост Telegram,
// `sync.mjs` и инструменты `plugins/tools/` берут её отсюда, а не разбирают
// `projects` каждый по-своему.
import {
  developmentOf,
  normalizePath,
  overlay,
  parseRegistry,
  projectFields,
  projectsOf,
  readRegistryFile,
  stripBom,
  telegramOf,
  writeRegistryFile,
} from './registry.mjs'
// Процесс отдела как данные: таблица ступеней, проверка сохранённого в вебе
// документа, имена меток и матчер. Диспетчер её только исполняет — порядок
// ступеней и переходы меток задаёт документ, а не ветвления `dispatch()`.
import {
  DISPATCHER_AGENT_CODE,
  PROCESS_LABEL_KEYS,
  activeOfPlan,
  areaRoleOfLabels,
  delegatedStepsOf,
  isActiveStep,
  isEntryStep,
  nextOfPlan,
  planOfProcess,
  processOf,
  queueOfPlan,
  stepOwnerOf,
  tagsOfProcess,
} from './process.mjs'
// Журнал расхода: смена уезжает в веб снимком (сессии, тарифы, итог), а не
// пересчитывается там. Модуль держит и очередь недоотправленного: смена
// закрывается по часам, в том числе когда стенда нет.
import {
  REPORT_PREFIX,
  buildShiftReport,
  deliverShift,
  enqueue,
  flushQueue,
  queueLength,
  shiftReportUrl,
} from './usage-web.mjs'

// ОБЩИЕ значения по умолчанию для проектов, которые своё не задали. Данных
// конкретного проекта здесь нет и быть не должно: они в реестре проектов
// (`STATE_FILES.projects`).
const DEFAULTS = {
  startHour: 0,
  startMinute: 0,
  stopHour: 6,
  stopMinute: 0,
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
  // Откуда забирать документ реестра проектов. Живёт здесь, а не в реестре: токен
  // — секрет, ему в файл проектов нельзя. Нет блока — нет синхронизации вовсе.
  registry: null,
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
  const file = readStateFile(STATE_FILES.config)
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
  // `usageRates` из файла больше не читается: цены — четыре поля проекта в вебе
  // (`projects.price_*`), а тариф в настройках отдела был вторым прайсом (#72).
  // Старый ключ молча игнорируется: он остался в файлах у всех, кто обновился, и
  // отказ заставил бы человека править настройки, чтобы отдел просто запустился.

  // Откуда диспетчер забирает документ реестра проектов: `{"apiUrl": "…",
  // "token": "…"}`. Нет блока — значит синхронизации нет вовсе, и `projects.json`
  // остаётся единственным источником, как было до версии 2: установка без веба
  // обязана работать.
  if (raw.registry !== undefined) {
    if (!raw.registry || typeof raw.registry !== 'object' || Array.isArray(raw.registry)) {
      problems.push('registry: нужен объект с полями apiUrl и token')
    } else {
      const registry = {}
      if (raw.registry.apiUrl !== undefined) {
        if (typeof raw.registry.apiUrl === 'string' && raw.registry.apiUrl.trim() !== '') registry.apiUrl = raw.registry.apiUrl.trim()
        else problems.push('registry.apiUrl: нужна непустая строка с адресом')
      }
      if (raw.registry.token !== undefined) {
        if (typeof raw.registry.token === 'string' && raw.registry.token.trim() !== '') registry.token = raw.registry.token.trim()
        else problems.push('registry.token: нужна непустая строка')
      }
      if (registry.apiUrl) values.registry = registry
    }
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
        ? 'теперь это поле department.enabled у каждого проекта в реестре проектов отдела (projects.json)'
        : 'переехало в реестр проектов отдела (projects.json)'
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

// Метки конвейера по умолчанию — данные процесса отдела (`plugins/process.mjs`):
// конвейер исполняет документ из веба, и второй копии набора меток в диспетчере
// быть не должно. Проект переопределяет имена полем `labels` реестра или
// документом процесса — см. `tagsOfProcess`.

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

// ── Состояние отдела: переезд в каталог профиля ─────────────────────────────
//
// Сам перенос делает `./state-paths.mjs`; здесь — только повод его запустить.
// Повод нужен отдельный, потому что читать отдел умеет из обоих мест
// (`readStateFile`: новый → старый → новый), а переносит только запись
// (`stateFile`). Реестр проектов и файл настроек отдел не пишет ВООБЩЕ: без этого
// обхода `~/.dsh/projects.json` (там токены Telegram и рабочие области) и
// `~/.dsh/dev-department.json` остались бы в корне каталога установки навсегда, и
// никто бы этого не заметил — `readStateFile` продолжал бы читать их оттуда.
// Ровно ради этих двух файлов тикет и затевался.
//
// Обход идемпотентен: `stateFile` создаёт каталог, переносит легаси-файл и на
// втором вызове не делает ничего; восемь вызовов стоят микросекунды. Возвращаем,
// что именно произошло: строка об этом уходит в журнал смены, чтобы переезд был
// виден человеку, а не случился молча.
function migrateStateFiles() {
  const moved = []
  const copied = []
  for (const name of Object.values(STATE_FILES)) {
    const legacy = legacyFile(name)
    const hadLegacy = fs.existsSync(legacy)
    stateFile(name)
    if (!hadLegacy) continue
    // Файл остался на старом месте — значит `rename` не удался и модуль состояния
    // скопировал его (EXDEV/EPERM). Старое не удаляем: так записано в контракте.
    if (fs.existsSync(legacy)) copied.push(name)
    else moved.push(name)
  }
  return { moved, copied }
}

// ── Роли: раскладка пресетов в пользовательский корень ──────────────────────
//
// Роли едут внутри пакета (`plugins/agent-presets/`), но жить они обязаны в
// пользовательском корне пресетов `~/.dsh/.agent-presets`: Desktop собирает
// строку `agent-presets` последним патчем и оставляет в ней ровно два корня —
// штатный (внутри app.asar) и этот, — а поле `roots` из bundle-патча
// выбрасывает. Добавить корень в рантайме тоже нечем: `resolvedRoots` сервиса
// считается один раз в конструкторе. Поэтому плагин раскладывает свои пресеты
// туда сам при загрузке. Именно КОПИЯ, а не ссылка на `node_modules`:
// переустановка пакета не должна уносить роли с собой, а правка роли идёт
// через git и новую версию пакета.
//
// Каталог ищется в двух местах: в пакете роли лежат рядом с плагином
// (`plugins/agent-presets/`), а в прежней раскладке
// `profiles/desktop/plugins/` — на два уровня выше.
const PRESETS_SOURCE = ['./agent-presets/', '../../../agent-presets/']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((dir) => fs.existsSync(dir)) ||
  fileURLToPath(new URL('./agent-presets/', import.meta.url))

// Шаблон композиции для роли, у которой в пакете нет `agent.cordis.yml`: роль,
// заведённая в вебе, не лежит в пакете вовсе, и раскладка собирает её из шаблона —
// иначе новая роль не запустилась бы ни разу.
const PRESETS_TEMPLATE = fileURLToPath(
  new URL('./agent-presets-template/agent.cordis.yml', import.meta.url)
)

// Каталог ролей хоста: подкаталоги пресетов в пакете и в пользовательском корне
// (роль, заведённая в вебе, лежит только там). По нему проверяется `role` ступени
// процесса: роль, которой хост не знает, не поднимет сессию, и молча пропустить
// такую ступень нельзя — это `problem` проекта и умолчания вместо документа.
// Пустой список означает «каталог не прочитан»: тогда проверка роли не делается,
// иначе нечитаемый каталог отменял бы любой сохранённый процесс.
function hostRoleCodes() {
  const codes = new Set()
  for (const dir of [PRESETS_SOURCE, path.join(dshHome(), '.agent-presets')]) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) codes.add(entry.name)
    }
  }
  return codes.size > 0 ? Array.from(codes) : undefined
}

// База API из адреса ручки реестра: `registry.apiUrl` — это
// `http://localhost:8096/api/registry`, а пресетам нужен `http://localhost:8096`.
// Путь отрезаем разбором URL, а не склейкой строк: хвостовые слэши и подкаталог
// стенда не должны давать двойной `/api`.
function presetsApiBase(url) {
  let target
  try {
    target = new URL(url)
  } catch (error) {
    return ''
  }
  const pathname = target.pathname.replace(/\/+$/, '')
    .replace(/\/api\/registry$/, '')
    .replace(/\/api$/, '')
  return target.origin + pathname
}

// Файлы каталога рекурсивно, путями относительно него: источник и цель
// сравниваются одним словарём, и «чего в источнике больше нет» видно сразу.
function listPresetFiles(dir, prefix = '') {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return []
  }
  const out = []
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...listPresetFiles(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

// Убрать опустевшие каталоги (после удаления устаревших файлов роли). Корень не
// трогаем: он принадлежит пресетам целиком, а не одной роли.
function pruneEmptyDirs(dir, root) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return false
  }
  let empty = true
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false
      continue
    }
    if (!pruneEmptyDirs(path.join(dir, entry.name), root)) empty = false
  }
  if (empty && dir !== root) {
    try {
      fs.rmdirSync(dir)
    } catch (error) {
      return false
    }
  }
  return empty
}

// Разложить пресеты ролей в пользовательский корень.
//
// Правила, которые важнее «просто скопировать»:
//   • чужие пресеты не трогаем: каталог может принадлежать человеку, и его
//     собственные роли обязаны пережить установку отдела (в отчёте они —
//     foreign и остаются на месте);
//   • файлы, которых в пакете больше нет, удаляем ТОЛЬКО у своих ролей: иначе
//     скилл, убранный из роли, продолжал бы подгружаться из прошлой версии;
//   • содержимое сравниваем побайтно, а не по mtime: переустановка пакета
//     переписывает файлы с новыми метками, но тем же содержимым, и лишняя
//     запись на каждом старте никому не нужна;
//   • ссылку вместо каталога не разворачиваем: это чужое решение, и молчаливая
//     замена ссылки копией сломала бы ожидания того, кто её сделал.
export function deployPresets(options = {}) {
  const source = options.source || PRESETS_SOURCE
  const target = options.target || path.join(dshHome(), '.agent-presets')
  // Коды, которые раскладывать НЕЛЬЗЯ: их удалили в вебе, и пакет не должен их
  // воскрешать. Список ведёт `syncPresets` в `.department-roles.json` (`readRemovedRoles`).
  const skip = new Set(Array.isArray(options.skip) ? options.skip : [])
  const result = {
    source,
    target,
    presets: [],
    foreign: [],
    skipped: [],
    written: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    problem: null,
  }

  let ids
  try {
    ids = fs.readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    result.problem = 'нет каталога пресетов рядом с плагином (' + source + ')'
    return result
  }
  if (ids.length === 0) {
    result.problem = 'каталог пресетов пуст: ' + source
    return result
  }
  // Пропуск считается после проверки «каталог пакета не пуст»: пустой пакет — беда
  // установки, а не повод молчать.
  result.skipped = ids.filter((id) => skip.has(id))
  ids = ids.filter((id) => !skip.has(id))

  if (fs.existsSync(target)) {
    let stat = null
    try {
      stat = fs.lstatSync(target)
    } catch (error) {
      stat = null
    }
    if (stat && stat.isSymbolicLink()) {
      result.problem = 'корень пресетов ' + target +
        ' — ссылка; плагин раскладывает реальные файлы и ссылку не заменяет'
      return result
    }
    if (stat && !stat.isDirectory()) {
      result.problem = 'корень пресетов ' + target + ' существует и это не каталог'
      return result
    }
  }
  try {
    fs.mkdirSync(target, { recursive: true })
  } catch (error) {
    result.problem = 'не создаётся корень пресетов ' + target + ': ' + (error && error.message ? error.message : String(error))
    return result
  }

  // Каталоги удалённых в вебе ролей. Слаг наш — отдел его и раскладывал, — поэтому
  // остаток убираем здесь: иначе роль, которую человек удалил в вебе, продолжала бы
  // подгружаться у агентов до следующего тика.
  for (const id of result.skipped) {
    const dir = path.join(target, id)
    if (!fs.existsSync(dir)) continue
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) continue
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      result.problem = 'удалённая в вебе роль ' + id + ' не убирается из ' + target + ': ' +
        (error && error.message ? error.message : String(error))
      return result
    }
  }

  for (const id of ids) {
    const from = path.join(source, id)
    const to = path.join(target, id)
    const wanted = listPresetFiles(from)
    try {
      fs.mkdirSync(to, { recursive: true })
      for (const rel of wanted) {
        const absFrom = path.join(from, rel)
        const absTo = path.join(to, rel)
        fs.mkdirSync(path.dirname(absTo), { recursive: true })
        let same = false
        try {
          same = fs.readFileSync(absFrom).equals(fs.readFileSync(absTo))
        } catch (error) {
          same = false
        }
        if (same) {
          result.unchanged += 1
          continue
        }
        const existed = fs.existsSync(absTo)
        fs.copyFileSync(absFrom, absTo)
        if (existed) result.updated += 1
        else result.written += 1
      }
      for (const rel of listPresetFiles(to)) {
        if (wanted.includes(rel)) continue
        fs.rmSync(path.join(to, rel), { force: true })
        result.removed += 1
      }
      pruneEmptyDirs(to, to)
      result.presets.push(id)
    } catch (error) {
      result.problem = 'роль ' + id + ': ' + (error && error.message ? error.message : String(error))
      return result
    }
  }

  // Что лежит в корне помимо ролей отдела: это человеково, не наше дело.
  const known = new Set([...ids, ...skip])
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && !known.has(entry.name)) result.foreign.push(entry.name)
    }
  } catch (error) {
    result.problem = 'не читается корень пресетов ' + target
  }
  return result
}

// ── Реестр проектов ─────────────────────────────────────────────────────────

// Реестр — документ версии 2 (см. `registry.mjs`). Диспетчер держит его разобранным
// один раз на тик: `byId` — проект по id, `ids` — порядок документа, `problems` —
// то, что разбор отбросил по дороге. Пустой или нечитаемый реестр по-прежнему
// ошибка: без проектов смена невозможна.
function readRegistry() {
  const file = readStateFile(STATE_FILES.projects)
  const parsed = readRegistryFile(file)
  const document = parsed.document
  const projects = document.projects
  const byId = new Map(projects.map((project) => [project.id, project]))
  const ids = projects.map((project) => project.id)
  // `default` — локальный ключ файла: веб его не отдаёт. Указывает в пустоту —
  // берём первый проект и говорим об этом проблемой, а не молчим.
  const defaultId = document.default !== undefined && byId.has(document.default)
    ? document.default
    : ids[0]
  return { file, document, byId, ids, defaultId, problems: parsed.problems }
}

// Один проект вместе с его отделом разработки. Значения, которых проект не задал,
// берутся из общих; problems собирает всё, что помешает отделу работать.
//
// Поля версии 1 лежали в записи проекта; в версии 2 они принадлежат отделу, а у
// проекта остались `id`, `title` и `departments`. Проект без отдела разработки
// (например, только маркетинг) диспетчер не обслуживает — он попадает в
// `disabled`, но не в проблемы.
function projectRow(registry, id, shared) {
  const project = (registry.byId && registry.byId.get(id)) || { id }
  const found = developmentOf(project)
  const dept = found.department || {}
  // Поля проекта в прежней внутренней форме собирает `registry.mjs`: форма записи
  // отдела — его достояние. Здесь добавляется только то, что принадлежит
  // диспетчеру: расписание, лимиты и собранные проблемы.
  const fields = projectFields(project, registry.document ? registry.document.agents : undefined)
  const problems = []
  if (found.problem) problems.push(id + ': ' + found.problem)

  const ownWindows = dept.windows !== undefined ? parseWindows(dept.windows, 'department.windows') : { windows: null, problems: [] }
  for (const problem of ownWindows.problems) problems.push(id + ': ' + problem)
  const windows = ownWindows.windows || shared.windows
  const windowsSource = ownWindows.windows ? 'проект' : (shared.windows ? 'общее' : 'нет')

  // Отдел может быть выключен двумя способами: флагом `enabled` и отсутствием отдела
  // разработки вовсе. Второй — не «включён по умолчанию»: иначе проект чужого вида
  // давал бы проблему «не задан repo» на каждом тике. Первый приходит из документа
  // реестра от веба (`departments.enabled`): отсутствие ключа и `null` — «включён»,
  // поэтому выключенным считается только явный `false`.
  const enabled = found.department !== null && dept.enabled !== false
  const pick = (key, min, max) => {
    if (dept[key] === undefined) return shared[key]
    if (Number.isInteger(dept[key]) && dept[key] >= min && dept[key] <= max) return dept[key]
    problems.push(id + ': department.' + key + ' — нужно целое от ' + min + ' до ' + max)
    return shared[key]
  }

  if (enabled && !windows) {
    problems.push(id + ': отдел включён, но расписание не задано ни у проекта, ни в общих настройках')
  }

  // Процесс отдела: сохранённый в вебе документ, иначе умолчания. Негодный документ
  // процессом не становится — отдел работает на умолчаниях, а причина остаётся в
  // `problems` и в статусе. Останавливать смену из-за опечатки в вебе нельзя.
  const process = processOf(dept.process, { roles: hostRoleCodes() })
  for (const problem of process.problems) problems.push(id + ': процесс: ' + problem)
  const tags = tagsOfProcess(process, fields.labels)

  return Object.assign({}, fields, {
    id,
    title: typeof project.title === 'string' && project.title ? project.title : id,
    // Имена тегов: сохранённый процесс → локальные `labels` файла → умолчания.
    labels: tags.labels,
    // Код агента на ключ тега: `null` — ступень берёт диспетчер.
    tagAgents: tags.agents,
    process,
    problems,
    department: {
      enabled,
      windows,
      windowsSource,
      maxRework: pick('maxRework', 1, 20),
      maxAttempts: pick('maxAttempts', 1, 20),
      stuckAfterMinutes: pick('stuckAfterMinutes', 1, 1440),
    },
  })
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
  // Всё, что разбор документа отбросил (дубль id, отдел без вида, неизвестный
  // `default`), — тоже проблема: иначе проект молча перестал бы обслуживаться.
  for (const problem of registry.problems || []) problems.push(problem)

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
    // Справочник агентов верхнего уровня: карточка статуса называет его поимённо, а
    // ступени берут владельца из `tagAgents` проекта.
    agents: registry.document.agents || [],
  }
}

// ── Тревога «отдел не обслуживает ни одного проекта» ────────────────────────
//
// 20.11.2026 файл реестра перевели в форму, которой установленный пакет не
// понимал, и отдел просто перестал обслуживать все проекты: `step()` возвращал
// `config-error` без строки в журнале и без сообщения в Telegram, а `dev_department_status`
// показывал `registry.serving: []`. Заметить это можно было только ручным вызовом
// инструмента — отдел простоял около трёх часов.
//
// Причина остановки живёт в `loaded.problem`; отсюда её получают журнал смены и
// Telegram. Одна и та же причина повторяется не чаще раза в 30 минут: три часа
// одинаковых блоков в журнале ничего не добавляют. Возврат в норму — одно `✅`.
const ALARM_REPEAT_MS = 30 * 60 * 1000

// Подсказка приклеена не к любой причине: «форма файла» и `.bak` — совет только
// тогда, когда причина в самом файле. Первый запуск на новой машине («сначала
// склонируйте репозиторий») или пустой документ не должны заканчиваться
// предложением восстановить `.bak` поверх целого реестра.
const ALARM_FORM_TAIL = 'Проверьте projects.json в каталоге состояния отдела: его форма должна совпадать ' +
  'с версией установленного пакета. Файл предыдущей версии лежит рядом как projects.json.bak.'
const ALARM_PLAIN_TAIL = 'Проверьте projects.json в каталоге состояния отдела.'

function alarmText(problem) {
  return '🛑 Отдел разработки: не обслуживается ни один проект\n' +
    'Причина: ' + problem + '\n' + (problem.includes('реестр') ? ALARM_FORM_TAIL : ALARM_PLAIN_TAIL)
}

// Бот для тревоги — бот проекта, названного полем `default` того же файла реестра.
// Файл при этом может быть как раз в чужой форме (потому отдел и молчит), так что
// читаем его здесь ещё раз и снисходительно: нужна одна запись, и её отсутствие —
// не ошибка, а «тревога остаётся в журнале». Форму документа разбирает
// `registry.mjs` — `parseRegistry`, `projectsOf`, `developmentOf`, `telegramOf`:
// своей копии разбора здесь нет, иначе правка формы там молча разошлась бы с
// копией здесь. Руками читается только запись проекта формы v1 — её
// установленный пакет не разбирает вовсе, а бота из неё взять можно.
function alarmBot() {
  const file = readStateFile(STATE_FILES.projects)
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const wanted = typeof raw.default === 'string' && raw.default.trim() !== '' ? raw.default.trim() : null
  if (wanted === null) return undefined
  const parsed = parseRegistry(raw, file)
  if (parsed.document) {
    const project = projectsOf(parsed.document).find((item) => item.id === wanted)
    return project ? telegramOf(developmentOf(project).department) : undefined
  }
  const projects = raw.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) return telegramOf(projects[wanted])
  return undefined
}

// Состояние тревоги живёт в памяти: перезапуск приложения сбрасывает троттлинг, и
// это принятый деграйд — журнал остаётся источником правды, Telegram уведомлением.
// `reason` — причина, о которой уже сказали: по ней решается, повторять ли блок.
const registryAlarm = { active: false, since: null, lastSentAt: null, channel: null, reason: null }

// Одна тревога: блок в журнал смены и, если у проекта по умолчанию есть бот,
// сообщение в Telegram. `channel` в отчёте говорит, где тревога осталась: сеть
// могла не дойти, и тогда честный ответ — `log`, а не `telegram`. Отказ отправки
// возвращается текстом ошибки: `lastError` принадлежит диспетчеру, а не этому
// разделу, и ставит его вызывающий.
async function alarmEmit(problem, now) {
  const text = alarmText(problem)
  appendShiftLog(text)
  const bot = alarmBot()
  registryAlarm.channel = bot ? 'telegram' : 'log'
  registryAlarm.lastSentAt = now.toISOString()
  if (!bot) return { text, error: null }
  try {
    await sendTelegram(bot, text)
  } catch (error) {
    registryAlarm.channel = 'log'
    return { text, error: error && error.message ? error.message : String(error) }
  }
  return { text, error: null }
}

// Обслуживаемых проектов нет. Причина всегда названа: `loaded.problem` — если
// виноват файл или рабочая область, и «нет ни одного проекта с включённым отделом»
// — если отдел выключен везде. Тревоги без причины не бывает: иначе `active: true`
// без единого сообщения, а потом `✅` без предшествующего `🛑`.
// Тревога включается на первом же таком тике, молчит, пока причина та же и не
// прошло 30 минут, и повторяется сразу, если причина сменилась.
async function noteRegistrySilent(loaded, now) {
  const problem = loaded.problem || 'нет ни одного проекта с включённым отделом'
  if (!registryAlarm.active) {
    registryAlarm.active = true
    registryAlarm.since = now.toISOString()
    registryAlarm.reason = problem
    return alarmEmit(problem, now)
  }
  if (problem !== registryAlarm.reason) {
    registryAlarm.reason = problem
    return alarmEmit(problem, now)
  }
  if (registryAlarm.lastSentAt === null) return alarmEmit(problem, now)
  if (now.getTime() - new Date(registryAlarm.lastSentAt).getTime() < ALARM_REPEAT_MS) return null
  return alarmEmit(problem, now)
}

// Отдел снова обслуживает проекты: одно `✅` на переход, и только если тревога
// была включена (после перезапуска приложения сравнивать не с чем). `lastSentAt` и
// `channel` в статусе относятся к тревоге, а не к `✅`: после возврата они снова
// `null`, иначе поле «момент последней отправки» показывало бы время снятой тревоги.
async function noteRegistryServing(loaded) {
  if (!registryAlarm.active) return null
  const text = '✅ Отдел разработки снова обслуживает проекты: ' + loaded.projects.map((project) => project.id).join(', ')
  registryAlarm.active = false
  registryAlarm.since = null
  registryAlarm.reason = null
  registryAlarm.lastSentAt = null
  registryAlarm.channel = null
  const bot = alarmBot()
  if (!bot) return { text, error: null }
  try {
    await sendTelegram(bot, text)
  } catch (error) {
    return { text, error: error && error.message ? error.message : String(error) }
  }
  return { text, error: null }
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
    fs.appendFileSync(stateFile(STATE_FILES.mcpLog), new Date().toISOString() + ' ' + text + '\n')
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
    fs.appendFileSync(stateFile(STATE_FILES.shiftLog), '\n===== ' + new Date().toISOString() + ' =====\n' + text + '\n')
  } catch (error) {
    // журнал не должен ломать смену
  }
}

// Карта диалогов: 'проект:роль:номер тикета' → { session, workspace }. Без неё
// каждая доработка и каждый повторный тест открывали новый диалог, и агент
// начинал с нуля. Номер тикета уникален только внутри проекта, поэтому проект
// входит в ключ: у vahta #52 и у brain #52 — разные задачи.
//
// Путь рабочей копии хранится рядом с id не для красоты: сессия живёт в каталоге,
// где её создали, и после переезда копии подпроцесс-слой (`pwsh`, ripgrep) в ней
// мёртв. Сверка пути при переиспользовании — в `startSessionWork`; без неё роль
// молча теряет возможность грепать и запускать команды, а её вердикт выглядит
// как проверка «по чтению».
function dialogsFile() {
  return stateFile(STATE_FILES.dialogs)
}

function readDialogs() {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(dialogsFile(), 'utf8')))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const map = {}
    for (const key of Object.keys(raw)) {
      const value = raw[key]
      // Старый формат — строка с одним id. Путь рабочей копии в нём не записан,
      // поэтому значение считается «путь неизвестен» и диалог ротируется при
      // первом использовании (`startSessionWork`), а не продолжается вслепую.
      if (typeof value === 'string' && value !== '') {
        map[key] = { session: value, workspace: null }
        continue
      }
      if (value && typeof value === 'object' && typeof value.session === 'string' && value.session !== '') {
        map[key] = {
          session: value.session,
          workspace: typeof value.workspace === 'string' && value.workspace !== '' ? value.workspace : null,
        }
      }
    }
    return map
  } catch (error) {
    return {}
  }
}

function writeDialogs(map) {
  try {
    const out = {}
    for (const key of Object.keys(map)) {
      const entry = map[key]
      if (!entry) continue
      if (typeof entry.session !== 'string' || entry.session === '') continue
      out[key] = {
        session: entry.session,
        workspace: typeof entry.workspace === 'string' && entry.workspace !== '' ? entry.workspace : null,
      }
    }
    fs.writeFileSync(dialogsFile(), JSON.stringify(out, null, 2))
  } catch (error) {
    // Карта не должна ломать смену: в худшем случае заведётся новый диалог.
  }
}

// Внешний вид статуса не меняется: `dev_department_status` отдаёт карту
// `ключ → id сессии` строками, хотя внутри значение — объект с рабочей копией.
function dialogSessionIds(map) {
  const out = {}
  for (const key of Object.keys(map)) {
    const entry = map[key]
    const id = entry && entry.session
    if (typeof id === 'string' && id !== '') out[key] = id
  }
  return out
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

// Метка смены: дата её начала и время начала окна — `2026-11-21T13:00`.
//
// Одной даты мало: окон в расписании может быть два, и обе смены суток получают
// одну дату. Утренняя (07:00–09:00) уходит в веб в 09:00 и занимает пару
// `(project_ref, shift_key)`, а ночная (13:00–04:00) закрывается на следующие
// сутки с тем же ключом — веб отвечает `200 changed:false`, все её сессии уходят
// в `skipped`, и расход самой дорогой смены суток теряется молча.
//
// Время берётся из окна, а не из фактического старта смены: ключ обязан быть
// воспроизводимым, иначе повторная отправка того же тела (очередь) дала бы другой
// ключ и записала бы смену дважды. Дата по-прежнему считается `shiftKey`, со
// сдвигом на сутки назад для окна, переходящего полночь.
function shiftStamp(windows, date) {
  const w = openWindow(windows, date) || (windows && windows[0])
  const day = shiftKey(windows, date)
  if (!w) return day
  const pad = (n) => String(n).padStart(2, '0')
  return day + 'T' + pad(Math.floor(w.start / 60)) + ':' + pad(w.start % 60)
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
  // `sessionQuery` в этом списке НЕТ намеренно: запись в inject — это обязательная
  // зависимость (объектная форма в этом cordis — intercept, а не «необязательная»),
  // и сборка без сервиса опроса сессий не подняла бы отдел вовсе — ни тика, ни
  // статуса, ни сводки. Спрашиваем сервис в момент вызова (см. `sessionQueryOf`):
  // его нет — расход читается запасным путём по стенограммам, а смена ролей идёт
  // как раньше. Запасному пути эта ветка и написана.
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

    // Сервис опроса сессий спрашивается на каждом вызове, а не здесь: в inject его
    // нет (см. выше), поэтому он может появиться позже и может не появиться вовсе.
    // `ctx.get` без второго аргумента не бросает на неизвестном имени, но обёртка
    // нужна: отказ сервиса не должен уносить карточку и сводку.
    const sessionQueryOf = () => {
      try {
        return ctx.get('sessionQuery') || null
      } catch (error) {
        return null
      }
    }

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

    // Модуль учёта токенов лежит рядом с диспетчером (его раскладывает
    // `node sync.mjs apply`). Импорт отложенный и необязательный: установка,
    // которой файл ещё не разложили, обязана работать как раньше, только без счёта.
    // Правило повтора живёт в модуле, поэтому своего счёта у диспетчера нет.
    let usageLedger = null
    let usageLedgerProblem = null
    async function loadUsageLedger() {
      if (usageLedger !== null) return usageLedger
      try {
        usageLedger = await import('./usage-ledger.mjs')
      } catch (error) {
        usageLedgerProblem = error && error.message ? error.message : String(error)
      }
      return usageLedger
    }

    // Состояние. У КАЖДОГО проекта свой отдел: своя смена, свой её ключ, своя
    // активная сессия и свои счётчики. Общего state.run здесь больше нет.
    const state = {
      projects: {},       // id → { run, lastShiftKey, session, rework, attempts }
      dialogs: readDialogs(), // 'проект:роль:номер' → { session, workspace } — диалог, который ведёт этот тикет
      projectProblem: null,
      servedIds: [],
      disabledIds: [],
      lastError: null,
      lastTickAt: null,
      // Раскладка пресетов ролей: `applied` — что уже разложено в этом процессе
      // (`{revision, roles}`), остальное — то, что видно в статусе.
      presets: {
        ok: null,             // null — синхронизации ещё не было
        revision: null,
        applied: { revision: null, roles: {} },
        roles: [],
        removed: [],
        deployed: false,
        written: 0,
        updated: 0,
        at: null,
        error: null,
      },
      // Журнал расхода в вебе (#57): `ok: null` — отправок в этом процессе ещё не
      // было. `queue` — сколько смен ждёт канал, `sent`/`dropped` — счётчики
      // процесса, `line` — что последняя отправка сказала человеку.
      usageSync: {
        ok: null,
        at: null,
        error: null,
        queue: 0,
        sent: 0,
        dropped: 0,
        line: null,
      },
      // Heartbeat диспетчера в веб: `ok: null` — записи в этом процессе ещё не было.
      // Сбой веба смену не срывает — причина остаётся здесь и в `lastError`.
      agentSync: {
        ok: null,
        at: null,
        code: null,
        state: null,
        issue_number: null,
        error: null,
      },
    }

    // Переезд состояния со старого места (корень каталога установки) в каталог
    // профиля — один раз, на старте плагина, до первого чтения реестра и настроек
    // в этом тике. См. `migrateStateFiles` выше: без этого обхода два файла, которые
    // отдел только читает, не переехали бы никогда.
    try {
      const migration = migrateStateFiles()
      if (migration.moved.length > 0 || migration.copied.length > 0) {
        appendShiftLog('🛠 Состояние отдела в ' + stateDir() + ': перенесено ' +
          (migration.moved.length > 0 ? migration.moved.join(', ') : 'ничего') +
          (migration.copied.length > 0
            ? '; скопировано, старое оставлено: ' + migration.copied.join(', ')
            : '') + '.')
      }
    } catch (error) {
      state.lastError = 'состояние отдела: ' + (error && error.message ? error.message : String(error))
    }

    function projectState(id) {
      if (!state.projects[id]) {
        // reviewedHead — ревизия, которую ревьюер уже смотрел; noop — сколько
        // кругов подряд прошло без нового коммита; findings — пути из замечаний,
        // по которым выбран маршрут доработки; noWork — роли маршрута, которые
        // вернулись ни с чем (без ветки и PR), по одной на роль.
        state.projects[id] = {
          run: null,
          lastShiftKey: null,
          session: null,
          rework: {},
          attempts: {},
          dropped: {},
          reviewedHead: {},
          noop: {},
          unclosed: {},
          findings: {},
          noWork: {},
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

    // Роли обязаны лежать в пользовательском корне пресетов ДО первого запроса
    // сессии: без них agentPresets.resolve('dev-backend') падает ещё до создания
    // диалога, а человек видит это как «поставил метку, а агент задачу не взял».
    // Раскладка идёт на загрузке плагина, то есть при старте приложения и после
    // установки новой версии пакета.
    //
    // Роли, удалённые в вебе, пакет не возвращает: их коды лежат в `.department-roles.json`
    // (поле `removed`) и передаются раскладке как список пропуска. Без этого удаление
    // роли жило бы до первого перезапуска приложения.
    try {
      const presetsRoot = path.join(dshHome(), '.agent-presets')
      const deployed = deployPresets({ skip: readRemovedRoles(presetsRoot) })
      if (deployed.problem) {
        state.lastError = 'пресеты ролей: ' + deployed.problem
      } else if (deployed.written + deployed.updated + deployed.removed > 0) {
        appendShiftLog('🛠 Пресеты ролей разложены в ' + deployed.target + ': ' +
          deployed.presets.join(', ') +
          ' (новых файлов ' + deployed.written + ', обновлено ' + deployed.updated +
          ', убрано ' + deployed.removed + ').' +
          (deployed.skipped.length > 0 ? ' Удалены в вебе и пропущены: ' + deployed.skipped.join(', ') + '.' : '') +
          (deployed.foreign.length > 0 ? ' Свои пресеты не тронуты: ' + deployed.foreign.join(', ') + '.' : ''))
      }
    } catch (error) {
      state.lastError = 'пресеты ролей: ' + (error && error.message ? error.message : String(error))
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
    //
    // Само правило выбора половины живёт в `areaRoleOfLabels`: порядок ветвлений
    // (передача фронтенду раньше `area:*`) закреплён эталонным тестом, а не
    // повторяется здесь третьим списком условий.
    function implementer(issue, L) {
      return areaRoleOfLabels(labelsOf(issue), L)
    }

    // Пустой ход половины: роль вернулась без ветки и PR, метку перехода при этом
    // поставила. Ключ — роль маршрута, которую в этот момент называет
    // implementer() по меткам маршрута и фазы. Помеченные роли и есть «половины,
    // которые кончились»: когда помечены все, тикет снимается со всеми метками.
    function markNoWork(project, issue) {
      const st = projectState(project.id)
      st.noWork[issue.number] = Object.assign(st.noWork[issue.number] || {}, { [implementer(issue, project.labels)]: true })
      return st.noWork[issue.number]
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

    // ── секции чеклиста и его пункты ────────────────────────────────────────
    // Блокирующие секции (`### Бэкенд`, `### Фронтенд`, `### Новое`) решают
    // маршрут доработки и вердикт. Секция `### Замечания (не блокирует)` — это
    // тексты, тело PR и наблюдения вне диффа: её пункты не создают доработку и в
    // маршруте не участвуют. Пока секции «не блокирует» в комментарии нет, разбор
    // идёт по всему тексту: круги до этого правила писались прозой, и потерять их
    // пути значило бы оставить возврат без маршрута.
    const CHECKLIST_HEADING = /^#{1,6}\s+(.+)$/
    const NON_BLOCKING_HEADING = /не\s*блокир/i

    function headingHalf(title) {
      const t = String(title || '').toLowerCase()
      if (NON_BLOCKING_HEADING.test(t)) return 'nonblocking'
      if (/бэкенд|backend/.test(t)) return 'backend'
      if (/фронтенд|frontend/.test(t)) return 'frontend'
      // `### Новое` половину не называет: её решает путь пункта.
      return null
    }

    // Текст без неблокирующей секции. Прочие заголовки остаются на месте — по ним
    // вторая половина разбора восстанавливает половину пункта. Решения «вырезать
    // всё, кроме блокирующих секций» здесь нет намеренно: заголовок, написанный не
    // по канону, обязан деградировать в разбор целого текста, а не отдать пустоту
    // и оставить тикет без маршрута из-за кривой строки.
    function blockingPart(text) {
      const lines = String(text).split('\n')
      const kept = []
      let sawNonBlocking = false
      let skip = false
      for (const line of lines) {
        const head = CHECKLIST_HEADING.exec(line)
        if (head) {
          skip = headingHalf(head[1]) === 'nonblocking'
          if (skip) sawNonBlocking = true
          if (!skip) kept.push(line)
          continue
        }
        if (!skip) kept.push(line)
      }
      return sawNonBlocking ? kept.join('\n') : String(text)
    }

    // Пункты чеклиста: номер (Б1/Ф1), галочка, половина и путь из `path:line`.
    // Половина берётся из секции, если пункт под ней стоит, иначе — из пути: у
    // старых кругов секций нет, а путь есть. Пункты неблокирующей секции сюда не
    // попадают вовсе: по ним не бывает ни доработки, ни отказа в ревью.
    function checklistState(project, text) {
      const areas = areasOf(project)
      const items = []
      let half = null
      for (const line of String(text).split('\n')) {
        const head = CHECKLIST_HEADING.exec(line)
        if (head) { half = headingHalf(head[1]); continue }
        const marked = CHECKLIST_LINE.exec(line)
        if (!marked) continue
        if (half === 'nonblocking') continue
        const found = new RegExp(FINDING_PATH.source).exec(marked[5])
        const raw = found ? found[0] : null
        const at = raw ? ((raw.match(/:([0-9]+(?:-[0-9]+)?)$/) || [])[1] || null) : null
        const path = raw ? raw.replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '') : null
        const itemHalf = half === 'backend' || half === 'frontend' ? half : (path ? areaOfPath(path, areas) : null)
        items.push({ id: marked[4], checked: marked[2] !== ' ', path, at, half: itemHalf })
      }
      return items
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
      // Пункты неблокирующей секции в маршруте не участвуют: их путь не ищется
      // вовсе, иначе замечание «поправь текст в теле PR» отправляло бы
      // разработчика править код, который ревьюер не просил трогать.
      const text = blockingPart(round)
      FINDING_PATH.lastIndex = 0
      let match = FINDING_PATH.exec(text)
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
        match = FINDING_PATH.exec(text)
      }
      // Пункты блокирующих секций нужны отдельно: по ним отличается «разобрали,
      // но путей нет» (тикет ждёт человека) от «ничего не прочитано» (маршрут
      // решает метка area:*). Список пунктов идёт в комментарий с номерами.
      const items = checklistState(project, text)
      return { backend, frontend, source, items }
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
      // Секции разбираются ДО галочек: неблокирующая секция вырезается на целом
      // комментарии, иначе фильтр чеклиста оставил бы её пункты в тексте круга и
      // путь из «не блокирует» уехал бы в маршрут доработки.
      const round = texts.slice(from).map((text) => checklistPart(blockingPart(text))).join('\n')
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
      return collectFindings(project, checklistPart(blockingPart(texts[verdict >= 0 ? verdict : last])), 'тестировщика')
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
      // Откуда возврат, решает метка, а не источник найденных путей: после
      // test-failed маршрут живёт своей меткой, и «нет путей» его не касается —
      // иначе сбой чтения чеклиста тестировщика (testFindings() вернул null и
      // разбор ушёл в PR) превращался бы в снятие живого тикета.
      const fromTest = has(issue, L.failed)
      const findings = (fromTest ? await testFindings(project, issue) : null)
        || await reviewFindings(project, issue)
      if (findings) projectState(project.id).findings[issue.number] = findings
      if (findings) {
        const backend = findings.backend.length > 0
        const frontend = findings.frontend.length > 0
        if (backend && frontend) return 'dev-fullstack'
        if (frontend) return 'dev-frontend'
        if (backend) return 'dev-backend'
        // «Путей нет» — это когда их не назвал НИ ОДИН пункт. Пункт с путём вне
        // areas (в этом проекте так выглядит любой `plugins/*.mjs`) путь назвал:
        // половину по нему не определить, но маршрут по метке area:* остаётся
        // рабочим, и снимать живой тикет из-за этого нельзя. Возврат null при
        // сбое сети сюда не попадает вовсе: там findings === null, и ниже решает
        // метка, как раньше.
        const noPathsAtAll = (findings.items || []).length > 0 && !findings.items.some((item) => item.path)
        if (!fromTest && findings.source !== 'тестировщика' && noPathsAtAll) return null
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

    // ── матчер: какая ступень и какому тикету ───────────────────────────────
    //
    // Порядок ступеней и переходы меток задаёт документ процесса отдела
    // (`plugins/process.mjs`), а не ветвления этого файла. Здесь остаётся только
    // перевод «метки GitHub → ключи контракта» и выбор роли ступени.

    // Ключ контракта по стоящей метке: имена меток проекта — тоже данные (`labels`
    // файла или документа), поэтому обратное отображение строится каждый раз от
    // текущих имён, а не от констант.
    function keysOfIssue(project, issue) {
      const L = project.labels
      const keys = []
      for (const key of PROCESS_LABEL_KEYS) {
        if (L[key] && has(issue, L[key])) keys.push(key)
      }
      return keys
    }

    // Тикеты в форме, которую ждёт матчер: снятый с конвейера тикет ждёт человека,
    // и диспетчер его не берёт, пока человек не вернёт ready-for-dev (блок
    // возврата в step()); иначе живая сессия, дописавшая метку после снятия,
    // завезла бы тикет обратно.
    function processItems(project, issues) {
      const st = projectState(project.id)
      return issues.map((issue) => ({
        item: issue,
        labels: keysOfIssue(project, issue),
        dropped: Boolean(st.dropped[issue.number]),
      }))
    }

    // План на тик: ступени по приоритету и тикеты по порядку GitHub. Вне смены
    // исполняется только маршрутная ступень (`kinds`) — работа сессий требует
    // открытого окна.
    //
    // Владение ступенью — одно правило на всех (`stepOwnerOf`): ступень, у которой хоть
    // один входящий тег отдан включённому агенту, чей код не `dsh`, диспетчер не берёт.
    // Через `planFor` это видят и выдача, и карточка статуса, и очередь: второго правила
    // выбора в файле нет.
    function planFor(project, issues, options = {}) {
      const callerSkip = typeof options.skip === 'function' ? options.skip : null
      return planOfProcess(project.process.document, processItems(project, issues), Object.assign({}, options, {
        skip: (step, item) =>
          stepOwnerOf(step, project.tagAgents, project.agents) !== null ||
          Boolean(callerSkip && callerSkip(step, item)),
      }))
    }

    // Тикет и ступень, которые тик должен обслужить: первая ступень плана. Маршрутную
    // ступень берём, только если маршрут по постановке вообще выводится: без признаков
    // разметки она бы крутилась вхолостую и держала тикет впереди выдачи, а старая
    // ступень в этом случае выдавала задачу исполнителю по умолчанию. `options.skip`
    // вызывающего складывается с маршрутным: одно правило не должно затирать другое
    // (вне окна смены вызывающий просит пропустить входные ступени).
    function decisionOf(project, issues, options = {}) {
      const callerSkip = typeof options.skip === 'function' ? options.skip : null
      const plan = planFor(project, issues, Object.assign({}, options, {
        skip: (step, item) =>
          (step.kind === 'route' && !classifyArea(project, item).area) ||
          Boolean(callerSkip && callerSkip(step, item)),
      }))
      const next = nextOfPlan(plan)
      return next ? { step: next.step, issue: next.item, plan } : null
    }

    // Роль ступени. Резолверы (`by-area`, `by-findings`) сохранены как данные
    // процесса: маршрут доработки по замечаниям и доработка идущей работы — это
    // правила выбора роли, а не отдельные ступени.
    async function stepRole(project, step, issue, L, kind) {
      if (step.role === 'by-findings') return roleForRework(project, issue, L)
      if (step.role === 'by-area') return (await roleForRework(project, issue, L)) || implementer(issue, L)
      // Возврат в работу: маршрут доработки по замечаниям сильнее роли ступени.
      // Null от резолвера — «пункты есть, путей не назвал ни один»: такую
      // доработку снимает dropUnroutableRework в dispatch(), а не подстановка
      // роли ступени, иначе тикет крутился бы в доработке без адреса.
      if (step.guard === 'dispatch' && kind === 'rework') return roleForRework(project, issue, L)
      return step.role
    }

    // Вид работы для задания исполнителя. Промпты различают начало, возврат из
    // ревью или теста, половину фронтенда и продолжение — это читается по
    // входящим меткам ступени, а не по её id.
    function stepKind(project, step, issue) {
      if (isActiveStep(step)) {
        if (step.when.includes('failed')) return 'rework'
        if (step.when.includes('frontend')) return 'stage'
        if (step.when.includes('progress')) return 'continue'
        return 'new'
      }
      // Вход, но диалог исполнителя по тикету уже был: это доработка, а не новая
      // задача — иначе пара исполнитель↔код-ревью качалась бы без ограничения.
      return anyImplementerDialog(project, issue) ? 'rework' : 'new'
    }

    // Переходы меток ступени: что поставить и что снять. Один запрос на метку,
    // потому что набор меток тикета правится целиком.
    async function applyStepLabels(project, issue, step) {
      const L = project.labels
      const put = (step.put || []).map((key) => L[key]).filter(Boolean)
      const drop = (step.drop || []).map((key) => L[key]).filter(Boolean)
      for (const name of put) {
        await addLabel(project, issue.number, name)
      }
      if (drop.length > 0) await dropLabels(project, issue.number, drop)
      return { put, drop }
    }

    // «Активный» тикет проекта для карточки статуса: тикет самой ранней начатой
    // ступени плана. Роль выводится из ступени, поэтому карточка показывает то же
    // решение, которое примет тик, — второй логики выбора здесь нет.
    async function findActive(project, issues) {
      const active = activeOfPlan(planFor(project, issues))
      if (!active) return null
      const kind = stepKind(project, active.step, active.item)
      const role = await stepRole(project, active.step, active.item, project.labels, kind)
      return { role, issue: active.item, step: active.step, kind }
    }

    // Очередь на выдачу: тикеты, ждущие ступени сессии. Макет и маршрут в очередь
    // разработки не попадают — у них свои ступени.
    function queuedOf(project, issues) {
      return queueOfPlan(planFor(project, issues)).map((entry) => entry.item)
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

    // Маршрут одному тикету: разметка постановки и след в тикете. Возвращает
    // действие, чтобы следующий тик уже раздал задачу по метке, а не гадал повторно.
    async function routeIssue(project, issue) {
      const L = project.labels
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

    // Маршрут тикетам, которых ждёт маршрутная ступень процесса: вне смены это
    // единственная работа, которая идёт без сессии.
    async function assignArea(project, issues) {
      const L = project.labels
      const routed = planFor(project, issues, { kinds: ['route'] }).map((entry) => entry.item)
      const open = routed.filter((i) => !hasAnyArea(i, L))
      if (open.length === 0) return null
      return routeIssue(project, open[0])
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

    // Один путь — одно имя: регистр и хвостовые слэши Windows не различает, а
    // прямые и обратные пишутся в одной строке. Пустая строка путём не считается:
    // у значения старого формата путь неизвестен, и это повод ротировать диалог.
    function sameWorkspacePath(left, right) {
      const normalize = (value) => String(value == null ? '' : value)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
      const a = normalize(left)
      const b = normalize(right)
      return a !== '' && b !== '' && a === b
    }

    // Каталог рабочей копии обязан существовать: сессия из удалённого каталога —
    // ровно та мёртвая среда, в которой не живут `pwsh` и ripgrep.
    function workspaceDirectoryExists(value) {
      try {
        return fs.statSync(value).isDirectory()
      } catch (error) {
        return false
      }
    }

    // Страж переиспользования: диалог продолжаем только в той же самой и ещё
    // существующей рабочей копии. Любая ошибка сверки — повод завести новый
    // диалог, а не сорвать выдачу задачи: страж падает в сторону «новый».
    function dialogWorkspaceFits(entry, workspace) {
      try {
        if (!entry || !entry.workspace) return false
        if (!sameWorkspacePath(entry.workspace, workspace)) return false
        return workspaceDirectoryExists(workspace)
      } catch (error) {
        return false
      }
    }

    // Тот же вопрос, что и у стража, но для заданий роли: «продолжаешь прошлый
    // диалог?». Признак «есть запись» здесь не годится — страж может завести
    // новую сессию, и роль получила бы задание про историю, которой у неё нет.
    function dialogReusable(project, presetId, issueNumber) {
      const entry = existingDialog(project, presetId, issueNumber)
      return !!(entry && dialogWorkspaceFits(entry, project.workspace))
    }

    // История диалога не должна теряться молча: причина ротации идёт в тот же
    // канал, что и остальные проблемы диспетчера — `state.lastError` и журнал смены.
    function noteDialogRotation(sessionId, oldWorkspace, newWorkspace) {
      const line = 'диалог ' + sessionId + ' жил в рабочей копии ' + (oldWorkspace || 'неизвестна') +
        ' — заведён новый в ' + newWorkspace
      state.lastError = line
      appendShiftLog(line)
    }

    // requestId должен быть новым на каждый запрос: у одного диалога теперь
    // много заданий, а повторный id может быть отброшен как дубль. Одного
    // счётчика мало: после перезапуска приложения он начинается заново, и
    // продолжение диалога получило бы id, который уже выдавался до перезапуска.
    async function promptSession(project, sessionId, prompt) {
      const token = Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 8)
      notePromptedSession(project, sessionId)
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

    // ── расход токенов по тикету ───────────────────────────────────────────

    // Привязка «сессия → тикет» пишется ДО первого хода: смена может закрыться в
    // любой момент, а расход уже пошёл. Повторная выдача в тот же диалог вторую
    // запись не добавляет — дедуп по ключу «проект|тикет|сессия» живёт в модуле.
    async function recordUsageBinding(project, presetId, issue, sessionId) {
      const module = await loadUsageLedger()
      if (module === null) return null
      const attempt = projectState(project.id).attempts[issue.number] || null
      const result = module.appendLedgerEntry({
        at: new Date().toISOString(),
        project: project.id,
        issue: issue.number,
        role: presetId,
        session: sessionId,
        attempt,
        source: 'dispatcher',
      })
      if (result && result.reason) state.lastError = 'книга учёта: ' + result.reason
      return result
    }

    // Смена помнит диалоги, которым она дала ход. Привязка в книге пишется один раз
    // на диалог (дедуп по ключу «проект|тикет|сессия»), поэтому у доработки в тот же
    // диалог `at` остаётся от прошлой смены — и по времени её расход в сводку не
    // попал бы, хотя в эту смену он был. Набор живёт в состоянии смены и в книгу не
    // пишется: это «что смена пнула», а не «когда родилась привязка».
    function notePromptedSession(project, sessionId) {
      const run = projectState(project.id).run
      if (!run) return
      if (!(run.prompted instanceof Set)) run.prompted = new Set()
      run.prompted.add(String(sessionId))
    }

    function sessionWord(count) {
      const tail = Math.abs(count) % 100
      const last = tail % 10
      if (tail > 10 && tail < 20) return 'сессий'
      if (last === 1) return 'сессия'
      if (last > 1 && last < 5) return 'сессии'
      return 'сессий'
    }

    // Счёт по одной сессии: сперва стенограмма на диске, а живая поверхность
    // (`sessionQuery.readSurface`) — запасной путь для сессии, которой на диске ещё
    // нет. Причина в полноте: поверхность состоит из четырёх видов сообщений
    // (`SurfaceEventType`), в ней нет ни `assistant/attempt`, ни `llm/retry-started`,
    // ни вытесненных сжатием ходов. Считать по ней значит разойтись с отчётом
    // `tools/issue-tokens.mjs`, который читает стенограмму целиком: на шаге с
    // повтором у провалившейся попытки свой usage, и поверхность покажет меньше.
    // Молчаливые нули не прячем: сбои разбора стенограммы идут в problems.
    async function usageOfSession(module, entry) {
      const fromDisk = module.readUsageFromDisk(dshHome(), entry.session)
      const diskNumbers = () => ({
        usage: fromDisk.usage, turns: fromDisk.turns, events: fromDisk.events, problems: fromDisk.problems,
      })
      // Стенограмма есть и прочиталась целиком — другого источника не надо.
      if (!fromDisk.missing && fromDisk.problems.length === 0) return diskNumbers()
      const live = sessionQueryOf()
      if (live) {
        try {
          const surface = await live.readSurface(entry.session)
          const events = (surface && surface.events) || []
          const numbers = {
            usage: module.usageOfEvents(events),
            turns: module.turnsOfEvents(events),
            events: events.length,
          }
          // Стенограммы нет вовсе — это свежая сессия, и поверхность про неё полная:
          // лучшее, что есть, без оговорок.
          if (fromDisk.missing) return { ...numbers, problems: [] }
          // Стенограмма есть, но не дочиталась: числа поверхности её короче, поэтому
          // говорим об этом прямо, а не выдаём их за полные.
          return {
            ...numbers,
            problems: ['сессия ' + entry.session + ': стенограмма не дочиталась (' +
              fromDisk.problems.join('; ') + '), считаем по живой поверхности — в ней нет повторов шага и упавших' +
              ' попыток, числа по сессии меньше настоящих'],
          }
        } catch (error) {
          // Сессия недоступна живому чтению — остаётся стенограмма.
        }
      }
      return diskNumbers()
    }

    // Карточка расхода по тикету: строки по ролям и итог, как их хочет видеть
    // `dev_department_status`. Это заявление о данных, а не о работе: тикет без
    // записи в книге — норма для тикетов, начатых до выкатки учёта, и об этом
    // говорит `note`, а не пустая карточка без объяснения.
    //
    // `options.since` (ISO-время) оставляет записи не раньше этого момента — так
    // сводка смены считает свои выдачи ролей, а не весь расход тикета за всё время.
    // `options.sessions` — диалоги, которым смена дала ход: их записи входят в карточку
    // смены независимо от `at`, потому что привязка у диалога одна и у доработки в тот
    // же диалог она осталась от прошлой смены. Карточка статуса зовёт без обоих
    // аргументов: она про тикет, а не про смену.
    async function usageCard(project, issue, options) {
      const snapshotAt = new Date().toISOString()
      const since = options && options.since ? Date.parse(options.since) : NaN
      const module = await loadUsageLedger()
      if (module === null) {
        return {
          issue: issue.number,
          title: issue.title,
          sessions: [],
          carried: 0,
          totals: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
          snapshotAt,
          note: 'счёт токенов недоступен: рядом с диспетчером нет модуля учёта' +
            (usageLedgerProblem ? ' — ' + usageLedgerProblem : ''),
          problems: [],
        }
      }
      let entries = []
      let bound = []
      let note = null
      try {
        bound = module.readLedger().filter((entry) => entry.project === project.id && entry.issue === issue.number)
      } catch (error) {
        note = 'книга учёта не читается: ' + (error && error.message ? error.message : String(error))
      }
      // Диалоги этой смены: id книги и id сессий пишутся по-разному (с префиксом
      // session- и без), поэтому сравниваем нормализованные.
      const prompted = new Set(((options && options.sessions) || []).map((id) => module.normalizeSessionId(id)))
      const carriedEntry = (entry) => prompted.has(module.normalizeSessionId(entry.session))
      // Запись с неразбираемой датой не выбрасываем: потерять сессию хуже, чем
      // показать её в смене, к которой она могла не относиться.
      const freshEntry = (entry) => {
        if (!Number.isFinite(since)) return true
        const at = Date.parse(entry.at)
        return !Number.isFinite(at) || at >= since
      }
      // Свежая привязка или диалог, которому ход дала эта смена. Второе нужно
      // отдельно: у доработки в тот же диалог `at` остался от прошлой смены.
      entries = bound.filter((entry) => freshEntry(entry) || carriedEntry(entry))
      // Сколько строк вошло только как продолжение прежнего диалога — их и помечаем
      // в сводке, чтобы дневная цифра не выдавала себя за полностью свежую.
      const carried = entries.filter((entry) => carriedEntry(entry) && !freshEntry(entry)).length
      const summary = await module.summarizeIssue(entries, (entry) => usageOfSession(module, entry))
      // `source` не выбрасываем: на этой машине сессию постановки открывает человек
      // под пресетом `standard`, и по одной роли строку «постановка» не отличить от
      // обычной роли конвейера.
      const sessions = summary.sessions.map((row) => ({
        role: row.role,
        session: row.session,
        source: row.source,
        turns: row.turns,
        in: row.in,
        out: row.out,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
      }))
      if (note === null) {
        if (entries.length === 0) {
          note = bound.length > 0
            ? 'расход этой смены не выделен: сессии по тикету заведены раньше, и ход им давала не эта смена'
            : 'тикет не привязан: в книге учёта нет записи — счёт пойдёт со следующей выдачи роли'
        } else if (sessions.length > 0 && sessions.every((row) => row.turns === 0)) {
          note = 'сессии открыты, ходов ещё нет: ' +
            sessions.map((row) => (row.role || 'роль') + ' ' + row.session.slice(0, 8)).join(', ')
        }
      }
      return {
        issue: issue.number,
        title: issue.title,
        sessions,
        carried,
        totals: summary.totals,
        snapshotAt,
        note,
        problems: summary.problems,
      }
    }

    // Сессия, в которой родился тикет. Постановку пишет не наш код: с переездом
    // GitHub на MCP-сервер issue создаёт чужой процесс, и крючка «тикет создан» у
    // отдела нет. Поэтому привязка ищется на первом тике, который увидел новый
    // тикет: берётся сессия каталога проекта, чья жизнь накрывает `created_at`
    // тикета и которая ещё ни к одному тикету не привязана (подробности — в
    // `findDraftSession`). Запись получает `source: "issue-created"`, и расход
    // аналитика попадает в строки тикета, а не в блок «не привязано».
    //
    // Окно в три дня нужно не для скорости, а для честности: тикеты, заведённые до
    // выкатки учёта, задним числом в книгу не попадают — их история видна только
    // блоком «восстановлено по заголовку» в отчёте.
    const DRAFT_BIND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
    const DRAFT_BIND_SLACK_MS = 60 * 60 * 1000

    const createdAtOf = (issue) => {
      const raw = issue && (issue.created_at || issue.createdAt)
      return raw === undefined || raw === null ? NaN : Date.parse(raw)
    }

    async function bindDraftSessions(project, issues) {
      const module = await loadUsageLedger()
      if (module === null) return 0
      let ledger
      try {
        ledger = module.readLedger()
      } catch (error) {
        state.lastError = 'книга учёта: ' + (error && error.message ? error.message : String(error))
        return 0
      }
      const mine = ledger.filter((entry) => entry.project === project.id)
      const knownIssues = new Set(mine.map((entry) => Number(entry.issue)))
      const boundSessions = mine.map((entry) => entry.session)
      const now = Date.now()
      // Тикет без единой записи книги — это кандидат: у тикета с записями сессия
      // постановки либо уже привязана, либо её привязка не нужна.
      const candidates = (issues || []).filter((issue) => {
        if (!issue || knownIssues.has(Number(issue.number))) return false
        const created = createdAtOf(issue)
        if (!Number.isFinite(created)) return false
        return now - created <= DRAFT_BIND_WINDOW_MS
      })
      if (candidates.length === 0) return 0
      const listed = module.listSessionHeads(dshHome())
      if (listed.problems.length > 0) {
        state.lastError = 'книга учёта: ' + listed.problems.join('; ')
      }
      if (listed.heads.length === 0) return 0
      let written = 0
      for (const issue of candidates) {
        const head = module.findDraftSession(listed.heads, {
          created: createdAtOf(issue),
          cwds: [project.workspace, project.humanClone],
          bound: boundSessions,
          slackMs: DRAFT_BIND_SLACK_MS,
          windowMs: DRAFT_BIND_WINDOW_MS,
        })
        if (head === null) continue
        const result = module.appendLedgerEntry({
          at: new Date().toISOString(),
          project: project.id,
          issue: Number(issue.number),
          role: head.preset || 'analyst',
          session: head.session,
          attempt: null,
          source: 'issue-created',
        })
        if (result && result.reason) {
          state.lastError = 'книга учёта: ' + result.reason
          continue
        }
        boundSessions.push(head.session)
        knownIssues.add(Number(issue.number))
        written += 1
        // Привязка должна быть видна человеку: она не спросила у агента согласия и
        // догадывается по времени, поэтому её появление записывается в журнал.
        appendShiftLog('книга учёта: сессия постановки ' + head.session +
          (head.preset ? ' (' + head.preset + ')' : '') + ' привязана к тикету #' + issue.number +
          ' по времени создания тикета')
      }
      return written
    }

    // ── heartbeat диспетчера ────────────────────────────────────────────────
    //
    // Агент `dsh` — это сам диспетчер. Перед ходом он пишет себе `busy` с номером
    // тикета, после хода — `idle`: экран «Агенты» и `dev_department_status` видят, чем
    // отдел занят, не заглядывая в журнал. Сбой веба **не срывает ход**: та же политика,
    // что у `registrySync` — причина уходит в `lastError`, конвейер продолжается на
    // локальном состоянии.
    const AGENT_HEARTBEAT_TIMEOUT_MS = 5 * 1000

    function sendAgentStatus(code, agentState, issueNumber) {
      return new Promise((resolve) => {
        const settings = config.values.registry
        if (!settings || !settings.apiUrl) {
          resolve({ skipped: 'адрес API не задан' })
          return
        }
        const base = presetsApiBase(settings.apiUrl)
        if (!base) {
          resolve({ error: 'адрес API не разобран: ' + settings.apiUrl })
          return
        }
        let target
        try {
          target = new URL(base + '/api/agents/' + encodeURIComponent(code) + '/status')
        } catch (error) {
          resolve({ error: 'адрес heartbeat не разобран: ' + messageOf(error) })
          return
        }
        const transport = target.protocol === 'https:' ? https : http
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
        if (settings.token) headers['X-Registry-Token'] = settings.token
        const payload = JSON.stringify({ state: agentState, issue_number: issueNumber })
        const request = transport.request(target, { method: 'PUT', headers }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => {
            resolve(response.statusCode === 200
              ? { ok: true, status: response.statusCode }
              : { error: 'веб ответил кодом ' + response.statusCode })
          })
        })
        request.setTimeout(AGENT_HEARTBEAT_TIMEOUT_MS, () => request.destroy(new Error('таймаут ответа')))
        request.on('error', (error) => resolve({ error: messageOf(error) }))
        request.write(payload)
        request.end()
      })
    }

    async function reportAgentStatus(code, agentState, issueNumber) {
      const result = await sendAgentStatus(code, agentState, issueNumber)
      state.agentSync = {
        ok: result.error ? false : (result.skipped ? null : true),
        at: new Date().toISOString(),
        code,
        state: agentState,
        issue_number: issueNumber,
        error: result.error || null,
      }
      if (result.error) state.lastError = 'агент ' + code + ': ' + result.error
      return result
    }

    // Ход отдела: heartbeat `busy` ставится до подъёма сессии, `idle` — после того как
    // ход закончился. `finally` держит `idle` и на отказе сессии: висящий `busy` врал бы
    // человеку, что отдел всё ещё работает над тикетом.
    async function startSession(project, presetId, prompt, issue) {
      const number = issue && Number.isInteger(issue.number) ? issue.number : null
      if (number !== null) await reportAgentStatus(DISPATCHER_AGENT_CODE, 'busy', number)
      try {
        return await startSessionWork(project, presetId, prompt, issue)
      } finally {
        if (number !== null) await reportAgentStatus(DISPATCHER_AGENT_CODE, 'idle', null)
      }
    }

    async function startSessionWork(project, presetId, prompt, issue) {
      const key = dialogKey(project, presetId, issue.number)
      const known = state.dialogs[key]
      const knownId = known && known.session
      if (knownId && await dialogIsResumable(knownId)) {
        // Продолжаем диалог только если он жил в той же рабочей копии, что задана
        // проекту сейчас. Иначе подпроцесс-слой сессии привязан к переехавшему или
        // удалённому каталогу, и роль молча теряет `pwsh` и ripgrep.
        if (dialogWorkspaceFits(known, project.workspace)) {
          // Продолжаем тот же диалог, а не начинаем с нуля. Запись книги — на обоих
          // путях и до первого хода: возврат в доработку тоже расходует токены.
          try {
            await recordUsageBinding(project, presetId, issue, knownId)
            await promptSession(project, knownId, prompt)
            return knownId
          } catch (error) {
            // Диалог не ожил — смену не срываем, заводим новый.
            state.lastError = 'продолжение диалога ' + knownId + ': ' + (error && error.message ? error.message : String(error))
            delete state.dialogs[key]
            writeDialogs(state.dialogs)
          }
        } else {
          // Рабочая копия диалога не та (или неизвестна): ключ удаляем и заводим
          // новую сессию существующим путём ниже. Ротация пишется в журнал.
          noteDialogRotation(knownId, known.workspace, project.workspace)
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
      state.dialogs[key] = { session: sessionId, workspace: workspace.path }
      writeDialogs(state.dialogs)
      await recordUsageBinding(project, presetId, issue, sessionId)
      await promptSession(project, sessionId, prompt)
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
        // BLOCKED перестал быть «возвратом»: это «смотреть нечего». Диспетчер по
        // нему не создаёт доработку и не тратит бюджет, поэтому роль обязана
        // понимать, что за него не спрятать просьбу что-то поправить.
        '`BLOCKED` ставится ТОЛЬКО когда проверять нечего: PR нет, ветка пустая, дифф пустой. В этом случае пунктов чеклиста нет, бюджет доработок не тратится, а причина пишется одной строкой. `BLOCKED` — не повод вернуть тикет в разработку: диспетчер доработку по нему не создаст.',
        'В ' + project.base + ' и main не коммитить и не переключать ветки в рабочей копии: ревью читает, а не строит.' +
          (project.humanClone ? ' В клон человека ' + project.humanClone + ' не заходить.' : ''),
        'Поставь себе цель, чтобы довести ревью до конца: тикет не должен остаться без метки.',
      ]
      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже ревьюил этот тикет: твои прошлые замечания и правки разработчика в его истории — проверь в первую очередь то, что тогда вернул.')
      // Повторный круг читается сверху вниз: сначала закрыты ли прошлые пункты,
      // потом новое по диффу, и только потом всё, что не блокирует. Секции —
      // часть контракта: по `### Повторная проверка` и `### Новое` диспетчер
      // решает, закрыты ли пункты и куда идёт доработка, а секция «не блокирует»
      // не влияет ни на вердикт, ни на маршрут.
      if (repeat) {
        lines.splice(2, 0,
          'Повторный круг: в комментарии PR обязательны разделы по порядку — `### Повторная проверка` (по каждому пункту прошлого круга `Б1 — закрыто` либо `Б1 — не закрыто` с одной строкой доказательства), `### Новое` (только замечания по файлам, изменённым в этом круге: их список бери из `get_diff` PR) и `### Замечания (не блокирует)` (тексты, тело PR, доки, наблюдения вне диффа). Пункты секции «не блокирует» не создают доработку и в маршруте не участвуют — поэтому блокирующие пункты держи в первых двух разделах.')
      }
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

    // Передача тикета полного стека фронтенду — вторая половина работы. Два пути
    // ведут сюда, и оба — ступени процесса:
    //   1. ревьюер принял (ready-for-test) — тикет ждёт ступень `handoff-frontend`
    //      (вид `auto`): она ставит ready-for-frontend и снимает ready-for-test;
    //   2. for-code-review без PR — бэкенд-части в постановке не было, смотреть
    //      ревьюеру нечего: страж `no-code` передаёт тикет фронтенду сразу, не
    //      тратя круг ревью.
    // Комментарий, сброс счётчика и пустой ход половины одинаковы для обоих путей.
    async function handOffFullstack(project, issue, reason) {
      const L = project.labels
      await dropLabels(project, issue.number, [L.review, L.test])
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

    // ── ступень постановки: макет ──────────────────────────────────────────
    //
    // Тикет, которому автор постановки поставил needs-mockup, проходит через
    // дизайнера раньше разработки. Ступень работает без ready-for-dev: макет —
    // часть постановки, и человек ставит свою метку уже по готовому визуальному
    // ответу. Выбор тикета — дело матчера (`steps`: ступень `mockup` с входящими
    // метками needs-mockup и «кроме» mockups-ready), а страж `mockup-stage`
    // решает в плане, что делать с уже начатым тикетом.

    // ── один шаг диспетчера по проекту ─────────────────────────────────────

    // Ревизия, которую ревьюер уже смотрел. Живёт в памяти диспетчера, как
    // счётчики: после перезапуска DSH поведение откатывается к «позвать
    // ревьюера» — осознанный деграйд, зависнуть тикет не может.
    // Три исхода вместо null: 'error' — GitHub не ответил, 'none' — смотреть
    // нечего (PR по ветке feature/<номер>-* не существует или в нём пустой дифф),
    // 'sha' — PR есть и в нём есть изменения. Функция ничего не пишет в состояние
    // и ничего не кэширует: решение принимает dispatch().
    async function reviewHead(project, issue) {
      let pr = null
      try {
        pr = await findPr(project, issue.number)
      } catch (error) {
        // GitHub не ответил — не решаем за ревьюера, зовём как обычно.
        state.lastError = 'PR #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return { kind: 'error' }
      }
      if (!pr || !pr.head || !pr.head.sha) return { kind: 'none', why: 'pr' }
      // PR есть, а дифф пустой: смотреть ревьюеру нечего так же, как если бы PR
      // не было. Второй повод для 'none' — не новый исход: у диспетчера уже есть
      // одна ветка «работы нет», и второй экземпляр той же уборки завёл бы две
      // несогласованные копии.
      //
      // Числа диффа берутся из ЧТЕНИЯ ОДНОГО PR, а не из списка: живой
      // list_pull_requests отдаёт только number и head (проверено тестировщиком
      // на code-review #48 по возврату №2), поэтому гейт на списке был написан, но
      // в бою не срабатывал. Не прочитали подробности — считаем, что дифф есть:
      // отказ инструмента не повод снимать живой тикет.
      const details = await pullRequestDetails(project, pr.number)
      if (prHasNoDiff(details || pr)) return { kind: 'none', why: 'empty-diff', pr }
      const sha = String(pr.head.sha)
      return { kind: 'sha', sha, pr, same: projectState(project.id).reviewedHead[issue.number] === sha }
    }

    // Полное чтение одного PR: только оно отдаёт changed_files/additions/deletions
    // (list_pull_requests — нет). Отказ инструмента — null, а не исключение: ревью
    // из-за него не встаёт, а гейт пустого диффа остаётся fail-open.
    async function pullRequestDetails(project, number) {
      try {
        const { owner, repo } = repoOf(project)
        return await mcpRead('pull_request_read', { method: 'get', owner, repo, pullNumber: Number(number) })
      } catch (error) {
        state.lastError = 'PR #' + number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
    }

    // Пустой PR: менять в нём нечего. Числа берутся из полного чтения PR; нет их
    // (урезанный ответ, отказ инструмента) — считаем, что дифф не пустой: гейт не
    // должен срабатывать по отсутствию данных, иначе неполный ответ GitHub снимал
    // бы живые тикеты.
    function prHasNoDiff(pr) {
      const files = pr && pr.changed_files
      const adds = pr && pr.additions
      const dels = pr && pr.deletions
      if (typeof files === 'number' && files === 0) return true
      if (typeof adds === 'number' && typeof dels === 'number' && adds + dels === 0) return true
      return false
    }

    // Вердикт из шапки комментария ревьюера. Порядок чтения тот же, что в
    // isReviewerVerdict(): сначала СТРОКА вердикта в первых трёх строках, и только
    // если её нет — «вердикт …» в заголовке роли. Смешивать их нельзя: «о чём»
    // заголовка — свободный текст, и на тикете про семантику `BLOCKED` слово
    // `BLOCKED` в нём — обычная формулировка, а не вердикт. Пока вердикт искали
    // одной кучей, `**Роль:** код-ревьюер · гейты ревью: BLOCKED не доработка`
    // со строкой `FIX: 2` ниже читался как BLOCKED, и живой тикет уезжал в
    // «смотреть нечего» вместо доработки.
    function verdictWord(text) {
      const lines = String(text).split('\n')
      const head = lines.slice(0, 3).join('\n')
      const line = ROUND_VERDICT.exec(head)
      if (line) return line[1] === 'FIX:' ? 'FIX' : line[1]
      const about = (HEADER_ABOUT.exec(lines[0].replace(/\r$/, '')) || [])[1] || ''
      if (!/^вердикт(\s|:|$)/i.test(about.trim())) return null
      if (/BLOCKED\b/.test(about)) return 'BLOCKED'
      if (/FIX:/.test(about)) return 'FIX'
      if (/SHIP\b/.test(about)) return 'SHIP'
      return null
    }

    // Последний вердикт код-ревьюера в PR: 'SHIP' | 'FIX' | 'BLOCKED' | null.
    // Читается так же, как круг замечаний: комментарии PR, из них последний,
    // распознанный isReviewerVerdict(). null — вердикта нет или GitHub не ответил:
    // тогда решение принимает то, что есть (метки, ревизия, чеклист).
    async function reviewerVerdict(project, issue) {
      let pr = null
      try {
        pr = await findPr(project, issue.number)
      } catch (error) {
        state.lastError = 'вердикт ревьюера #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      if (!pr) return null
      let rows = null
      try {
        rows = await issueComments(project, pr.number)
      } catch (error) {
        state.lastError = 'вердикт ревьюера в PR #' + pr.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      let verdict = null
      for (const text of commentTexts(rows)) {
        if (!isReviewerVerdict(text)) continue
        const word = verdictWord(text)
        if (word) verdict = word
      }
      return verdict
    }

    // ── гейты ревью: файлы, которых не касались ─────────────────────────────
    // Последний коммит в ветке до указанной ревизии, затрагивающий путь. Двух
    // таких чтений хватает, чтобы понять, менялся ли файл между прошлым ревью и
    // текущей ревизией. Своего REST-клиента у диспетчера больше нет (GitHub —
    // только через MCP), поэтому сравнение идёт инструментом list_commits с
    // фильтром по пути: пустой список значит «в ветке этот файл не менялся».
    async function lastCommitForPath(project, sha, filePath) {
      const { owner, repo } = repoOf(project)
      const answer = await mcpRead('list_commits', { owner, repo, path: filePath, sha, perPage: 1 })
      const rows = Array.isArray(answer) ? answer : ((answer && answer.commits) || [])
      const first = rows[0] || null
      if (!first) return ''
      return String(first.sha || (first.commit && first.commit.sha) || '')
    }

    // Менялся ли файл между двумя ревизиями. null — сравнивать нельзя (сеть или
    // отказ инструмента): такой пункт не идёт в доказательство ни в одну из
    // сторон, и гейт деградирует в fail-open, а не снимает тикет по неполным
    // данным.
    async function fileChangedSince(project, prevSha, headSha, filePath) {
      try {
        const atHead = await lastCommitForPath(project, headSha, filePath)
        if (!atHead) return false
        const atPrev = await lastCommitForPath(project, prevSha, filePath)
        return atHead !== atPrev
      } catch (error) {
        state.lastError = 'сравнение ревизий по ' + filePath + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
    }

    // Половина по пунктам чеклиста — тем же правилом, что и в roleForRework().
    function halfOwner(items) {
      const backend = (items || []).some((item) => item.half === 'backend')
      const frontend = (items || []).some((item) => item.half === 'frontend')
      if (backend && frontend) return 'dev-fullstack'
      if (frontend) return 'dev-frontend'
      if (backend) return 'dev-backend'
      return null
    }

    // Замечания прочитаны, но ни один пункт не назвал путь: развести доработку по
    // половинам нечем. Без снятия ready-for-dev остался бы в очереди, и
    // разработчик получил бы задачу без замечаний — поэтому тикет ждёт человека, а
    // комментарий называет номера пунктов.
    async function dropUnroutableRework(project, issue) {
      const st = projectState(project.id)
      const L = project.labels
      const findings = st.findings[issue.number] || null
      const ids = ((findings && findings.items) || []).map((item) => item.id).filter(Boolean)
      const list = ids.length > 0 ? ids.join(', ') : 'Б1, Б2…'
      try {
        await postComment(project, issue.number, 'разбор замечаний невозможен',
          'Разбор замечаний невозможен: ни один пункт не называет путь — ' + list +
            ' без `path:line`. Ни одна половина сессию не получила: маршрут доработки определить нечем. ' +
            'Тикет снят с конвейера, нужен человек: поставь ' + L.dev + ', и диалоги обнулятся.')
      } catch (error) {
        state.lastError = 'комментарий о невозможном разборе замечаний: ' + (error && error.message ? error.message : String(error))
      }
      await dropFromPipeline(project, issue)
      if (st.run) {
        st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера: ни один пункт замечаний не называет путь' })
      }
      return { action: 'dropped', project: project.id, issue: issue.number, reason: 'no paths in findings' }
    }

    // Гейт перед сессией ревьюера. R1: незакрытые пункты прошлого чеклиста — не
    // повод звать ревьюера, доработка уходит по их путям. R2: отмеченный пункт, у
    // которого файл не менялся с прошлой ревизии, считается не исправленным, и в
    // комментарий идёт доказательство. Непустой возврат значит «ревьюер не
    // позван»; null — звать как раньше (fail-open: нет чеклиста, нет прошлого
    // круга, формат не распознан, сеть).
    async function reviewChecklistGate(project, issue, head, st) {
      const L = project.labels
      const hadRound = (st.rework[issue.number] || 0) > 0 || !!st.reviewedHead[issue.number]
      const pr = head.pr
      if (!hadRound || !pr || !pr.number) return null
      let rows = null
      try {
        rows = await issueComments(project, pr.number)
      } catch (error) {
        state.lastError = 'чеклист прошлого круга #' + issue.number + ': ' + (error && error.message ? error.message : String(error))
        return null
      }
      let last = null
      for (const text of commentTexts(rows)) {
        if (isReviewerVerdict(text)) last = text
      }
      if (!last) return null
      const items = checklistState(project, last)
      // Чеклиста нет — судить не о чем: ревьюера зовём как раньше.
      if (items.length === 0) { delete st.unclosed[issue.number]; return null }
      const prev = st.reviewedHead[issue.number]
      const open = []
      const unmoved = []
      for (const item of items) {
        if (!item.checked) { open.push(item); continue }
        // Сравнивать не с чем (нет прошлой ревизии или ревизия та же) — пункт не
        // доказательство ни в одну из сторон.
        if (!item.path || !prev || prev === head.sha) continue
        const changed = await fileChangedSince(project, prev, head.sha, item.path)
        if (changed === false) unmoved.push(item)
      }
      if (open.length === 0 && unmoved.length === 0) { delete st.unclosed[issue.number]; return null }
      st.unclosed[issue.number] = (st.unclosed[issue.number] || 0) + 1
      // Доказательство ссылается на ревизию ПРОШЛОГО ревью, а не на текущую:
      // «не менялся с <текущая>» тривиально верно для любого файла до неё и
      // разработчику ничего не доказывает. Смысл утверждения — файл не трогали
      // после того, как ревьюер его смотрел.
      const prevShort = prev ? String(prev).slice(0, 7) : ''
      const why = []
      if (open.length > 0) why.push('пункты ' + open.map((item) => item.id).join(', ') + ' не закрыты — ревью не зову')
      for (const item of unmoved) why.push('`' + item.path + '` не менялся с `' + prevShort + '` — пункт ' + item.id + ' не исправлен')
      // Второй отказ подряд: «не закрыл → не закрыл» — это уже не ревью, а
      // человеку. Уборка та же, что у сторожа пустых кругов.
      if (st.unclosed[issue.number] >= 2) {
        try {
          await postComment(project, issue.number, 'пункты чеклиста не закрыты дважды',
            'Второй раз подряд чеклист не закрыт: ' + why.join('; ') + '. Тикет снят с конвейера, нужен человек: поставь ' +
              L.dev + ', и счётчики вместе с диалогами обнулятся.')
        } catch (error) {
          state.lastError = 'комментарий о снятии после незакрытого чеклиста: ' + (error && error.message ? error.message : String(error))
        }
        await dropFromPipeline(project, issue)
        if (st.run) {
          st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера: пункты чеклиста не закрыты дважды' })
        }
        return { action: 'dropped', project: project.id, issue: issue.number, reason: 'review checklist not closed twice' }
      }
      try {
        await postComment(project, issue.number, 'ревью не зову: чеклист не закрыт', why.join('; ') + '.')
      } catch (error) {
        state.lastError = 'комментарий о незакрытых пунктах: ' + (error && error.message ? error.message : String(error))
      }
      // Круг ревью не состоялся, значит и бюджет доработок он тратить не вправе:
      // возвращаем счётчик назад, как это делает сторож пустого круга. Следующий
      // шаг — выдача доработки, и она снова его увеличит.
      st.rework[issue.number] = Math.max(0, (st.rework[issue.number] || 0) - 1)
      const refused = open.concat(unmoved)
      st.findings[issue.number] = {
        backend: refused.filter((item) => item.half === 'backend' && item.path).map((item) => ({ path: item.path, at: item.at })),
        frontend: refused.filter((item) => item.half === 'frontend' && item.path).map((item) => ({ path: item.path, at: item.at })),
        source: 'ревьюера',
        items: refused,
      }
      // Половина по пунктам, а когда её нет — по метке маршрута. Пункт без
      // секции половины может стоять на пути вне `areas` (в этом репозитории так
      // выглядит любой `plugins/*.mjs`): путь назван, значит маршрут по метке
      // `area:*` рабочий. Снимать тикет к человеку за это нельзя — ровно этот
      // случай закрыт в `roleForRework()`, и гейт обязан вести себя так же,
      // иначе повторный круг по `plugins/*` сам же снимает тикет. `null` остаётся
      // только для «путь не назвал ни один пункт».
      const owner = halfOwner(refused)
      const target = owner || (refused.some((item) => item.path) ? implementer(issue, L) : null)
      // Маршрута нет ни по половинам, ни по метке — повторный круг снимет тикет
      // штатным путём: это тот же случай, что у пустых замечаний в dispatch().
      if (!target) return dropUnroutableRework(project, issue)
      return startImplementer(project, issue, target, 'rework')
    }

    // «Смотреть нечего» — ревьюеру нет ревизии. Причин три, ветка одна: PR по
    // ветке нет, в PR пустой дифф, ревьюер написал BLOCKED (проверять нечего). Ни
    // одна из них не создаёт доработку и не тратит бюджет: половина маршрута,
    // которая только что сдала тикет, помечается пустым ходом, полный стек
    // передаётся фронтенду, а если пустые ходы уже у всех половин — тикет уходит
    // человеку.
    async function noCodeBranch(project, issue, note) {
      const st = projectState(project.id)
      const L = project.labels
      const emptyHanded = implementer(issue, L)
      const noWork = markNoWork(project, issue)
      if (has(issue, L.areaFullstack) && !has(issue, L.phaseFrontend) && !noWork['dev-frontend']) {
        // Вторая половина маршрута ещё не работала: тикет не снимаем, а передаём
        // фронтенду — первая половина была пустой, но это не повод хоронить весь
        // тикет полного стека.
        await dropLabels(project, issue.number, [L.review, L.dev])
        await addLabel(project, issue.number, L.frontend)
        // Передача — прогресс диспетчера, а не неудачная попытка агента: счётчик
        // обнуляем, иначе вторая половина сгорала бы на первом же шаге.
        st.attempts[issue.number] = 0
        try {
          await postComment(project, issue.number, 'ревизии нет, ревью не зову',
            note.text + ': ' + emptyHanded +
              ' вернулся без ревизии — смотреть ревьюеру нечего, код-ревью не зову. ' +
              'Тикет передан фронтенд-разработчику (' + L.frontend +
              '): он продолжит в той же ветке и том же PR.')
        } catch (error) {
          state.lastError = 'комментарий о пустом ходе первой половины: ' + (error && error.message ? error.message : String(error))
        }
        if (st.run) {
          st.run.entries.push({ number: issue.number, title: issue.title, role: emptyHanded, outcome: 'ревизии нет — передано фронтенду (' + L.frontend + ')' })
        }
        return { action: 'handoff', project: project.id, issue: issue.number, reason: note.reason }
      }
      // Работы не дала ни одна помеченная половина маршрута: тикет ждёт человека,
      // а не крутит ревьюера по пустому месту. Список ролей берётся из noWork
      // проекта, а не из догадки о маршруте.
      const emptyRoles = Object.keys(noWork).filter((name) => noWork[name])
      const outcomes = emptyRoles.map((name) => '- ' + name + ' — ветку не создавал и PR не открыл').join('\n')
      try {
        await postComment(project, issue.number, 'работы нет ни у одной половины маршрута',
          'Ревизии не дала ни одна половина маршрута — смотреть ревьюеру нечего (' + note.text + '):\n\n' + outcomes +
            '\n\nТикет снят с конвейера вместе со всеми метками, включая area:*. Нужен человек: поставь ' +
            L.dev + ', и маршрут вместе с диалогами выведется заново по постановке.')
      } catch (error) {
        state.lastError = 'комментарий о пустом ходе всех половин: ' + (error && error.message ? error.message : String(error))
      }
      await dropFromPipeline(project, issue)
      if (st.run) {
        st.run.entries.push({ number: issue.number, title: issue.title, outcome: 'снят с конвейера: работы нет ни у одной половины маршрута' })
      }
      return { action: 'dropped', project: project.id, issue: issue.number, reason: note.reason }
    }

    // Снятие тикета с конвейера: одна уборка на все поводы — лимит попыток, лимит
    // доработок, два круга ревью без нового коммита, пустые ходы всех половин
    // маршрута. Метки снимаются все до одной, вместе с маршрутом area:*: иначе
    // снятый тикет остаётся в очереди, человек ставит ready-for-dev, и цикл
    // «снят → возвращён → снят» крутится каждый тик. Маршрут снимается вместе с
    // остальными метками: после возврата человеком диспетчер выведет его заново
    // по постановке.
    async function dropFromPipeline(project, issue) {
      const L = project.labels
      // Одна правка на всю уборку: набор меток тикета пишется целиком.
      await dropLabels(project, issue.number, [L.progress, L.review, L.failed, L.test, L.frontend, L.phaseFrontend, L.ok, L.dev, L.mockup, L.mockupsReady, L.areaBackend, L.areaFrontend, L.areaFullstack])
      for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design', 'tester', 'code-review', 'devops-delivery']) {
        forgetDialog(project, presetId, issue.number)
      }
      const st = projectState(project.id)
      st.dropped[issue.number] = true
      // Снятый тикет начинается заново: ни истории ревизий, ни пустых кругов,
      // ни пустых ходов половин.
      delete st.reviewedHead[issue.number]
      delete st.noop[issue.number]
      delete st.unclosed[issue.number]
      delete st.findings[issue.number]
      delete st.noWork[issue.number]
    }

    // Выдача задачи разработчику — одна на все ступени сессий исполнителей: ступень
    // задаёт только роль, маршрут доработки и переходы меток, а лимиты, счётчики,
    // следы и запуск сессии общие.

    async function startImplementer(project, issue, role, kind) {
      const st = projectState(project.id)
      const L = project.labels
      // Ревьюер написал BLOCKED — проверять ему было нечего. Такой возврат
      // доработкой не считается: сессия половины не создаётся, бюджет не растёт
      // (выход идёт ДО увеличения счётчика, поэтому откатывать нечего), а тикету
      // находится другой путь — та же ветка «работы нет», что у пустого PR.
      // После test-failed вердикт ревьюера ни при чём: там решает метка.
      if (kind === 'rework' && !has(issue, L.failed)) {
        const verdict = await reviewerVerdict(project, issue)
        if (verdict === 'BLOCKED') {
          delete st.findings[issue.number]
          return noCodeBranch(project, issue, {
            text: 'ревью не состоялось: код-ревьюер написал BLOCKED — проверять нечего',
            reason: 'review blocked without code',
          })
        }
      }
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
      const prompt = implementerPrompt(project, issue, kind, dialogReusable(project, role, issue.number), role, findingPaths, findings.source)
      const sessionId = await startSession(project, role, prompt, issue)
      st.session = { role: role, issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
      st.run.sessions = (st.run.sessions || 0) + 1
      return { action: 'dispatched', project: project.id, role: role, issue: issue.number, sessionId }
    }
    // Исполнение одной ступени процесса: роль, стражи и переходы меток берутся из
    // строки таблицы, а работа с GitHub, счётчиками и сессиями остаётся здесь.
    async function dispatch(project, decision) {
      const st = projectState(project.id)
      const L = project.labels
      const issue = decision.issue
      const step = decision.step
      // Вид работы для задания и журнала читается по входящим меткам ступени, а не
      // по её id: у документа из веба id произвольные.
      const kind = stepKind(project, step, issue)
      let role = await stepRole(project, step, issue, L, kind)
      // Маршрут доработки не определён: пункты прочитаны, но пути не назвал ни
      // один. Снимать за это можно только возврат из ревью — у идущей работы и у
      // возврата тестировщика маршрут обязан остаться: там берётся метка.
      if (role === null) {
        if (kind === 'rework') return dropUnroutableRework(project, issue)
        role = implementer(issue, L)
      }
      // Ступень без сессии: диспетчер только переставляет метки и оставляет след.
      // Передача фронтенду — та же ступень, но с передачей половины работы.
      if (step.kind === 'auto') {
        if (step.put.includes('frontend') && has(issue, L.areaFullstack) && !has(issue, L.phaseFrontend)) {
          return handOffFullstack(project, issue, 'бэкенд-часть прошла код-ревью')
        }
        await applyStepLabels(project, issue, step)
        if (st.run) {
          st.run.entries.push({
            number: issue.number,
            title: issue.title,
            role: role,
            outcome: 'ступень «' + step.title + '»: метки переставлены без сессии',
          })
        }
        return { action: 'transitioned', project: project.id, issue: issue.number, step: step.id }
      }
      // Маршрутная ступень: разметка постановки, тоже без сессии.
      if (step.kind === 'route') {
        const routed = await routeIssue(project, issue)
        if (routed) return routed
        return null
      }
      // Ступень уже слитого PR: состояние дописывается по факту, сессия не нужна.
      if (step.guard === 'merged-already') {
        const settled = await settleAlreadyMerged(project, [issue])
        if (settled) return settled
      }
      // Ревизия, на которой сейчас выдаётся ревью. Записывается в reviewedHead
      // только после того, как сессия ревьюера создана: упавшее создание сессии
      // не должно превращаться в «ветка не менялась» на следующем тике.
      let reviewSha = null
      // Гейт ревью. Порядок ветвлений задан постановкой и не переставляется:
      //   1) 'error' — GitHub не ответил: ревьюера зовём как раньше, ни одна
      //      ветвь ниже не срабатывает;
      //   2) 'sha' и та же ревизия — сторож пустого круга;
      //   3) 'sha' и новая ревизия — гейт чеклиста прошлого круга, затем ревью;
      //   4) 'none' — смотреть нечего (PR нет или дифф пустой), сессия не создаётся.
      // Ветви — одна последовательность хода ревьюера, и включается она ролью
      // ступени, а не выбранным в документе стражем: страж строки говорит, ради какой
      // проверки ступень заведена, а не отменяет остальные. Иначе правка строки в
      // конструкторе (`same-head` → `limits`) тихо снимала бы защиту от повторного
      // ревью. У ступени `review` по умолчанию страж `no-code`.
      const reviewStage = role === 'code-review'
      if (reviewStage) {
        const head = await reviewHead(project, issue)
        if (head.kind === 'sha' && head.same) {
          // Сторож пустого круга. Если разработчик закончил ход, не запушив
          // коммит, а метку for-code-review переставил, ревьюер увидел бы ту же
          // ревизию, что и в прошлый раз: круг без нового коммита не тратит ни
          // ревью, ни бюджет доработок, а доработка уходит владельцу замечаний.
          st.noop[issue.number] = (st.noop[issue.number] || 0) + 1
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
          return startImplementer(project, issue, owner, 'rework')
        }
        if (head.kind === 'sha') {
          // Чеклист прошлого круга проверяется ДО создания сессии: незакрытый
          // пункт — не повод звать ревьюера, а отмеченный пункт без изменения
          // файла — не исправленный пункт.
          const gate = await reviewChecklistGate(project, issue, head, st)
          if (gate) return gate
          reviewSha = head.sha
        }
        if (head.kind === 'none') {
          // Смотреть нечего: PR по ветке feature/<номер>-* не существует или в нём
          // пустой дифф. Ревьюеру нет ревизии — startSession('code-review') в этой
          // ветви недостижим, а вся уборка лежит в noCodeBranch().
          return noCodeBranch(project, issue, head.why === 'empty-diff'
            ? { text: 'в PR #' + head.pr.number + ' нет изменений (пустой дифф)', reason: 'empty diff' }
            : { text: 'PR по ветке feature/' + issue.number + '-* нет', reason: 'no work in any half' })
        }
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
      if (role === 'design') {
        const repeat = dialogReusable(project, 'design', issue.number)
        await applyStepLabels(project, issue, step)
        const sessionId = await startSession(project, 'design', mockupPrompt(project, issue, repeat), issue)
        st.session = { role: 'design', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'design', stage: 'mockup', issue: issue.number, sessionId }
      }
      // Выдача задачи разработчику — ступень сессии исполнителя: роль, маршрут
      // доработки и переходы меток берутся из строки процесса.
      if (role === 'dev-fullstack' || role === 'dev-backend' || role === 'dev-frontend') {
        return startImplementer(project, issue, role, kind)
      }

      if (role === 'devops-delivery') {
        const sessionId = await startSession(project, 'devops-delivery', mergePrompt(project, issue, dialogReusable(project, 'devops-delivery', issue.number)), issue)
        st.session = { role: 'devops-delivery', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'devops-delivery', issue: issue.number, sessionId }
      }

      if (role === 'code-review') {
        const sessionId = await startSession(project, 'code-review', reviewPrompt(project, issue, dialogReusable(project, 'code-review', issue.number)), issue)
        // Сессия создана — только теперь ревизия считается показанной ревьюеру;
        // новый коммит обнуляет накопленные пустые круги.
        if (reviewSha) {
          st.reviewedHead[issue.number] = reviewSha
          delete st.noop[issue.number]
          // Ревью состоялось — счётчик отказов по чеклисту начинается заново.
          delete st.unclosed[issue.number]
        }
        st.session = { role: 'code-review', issue: issue.number, title: issue.title, sessionId, startedAt: new Date().toISOString() }
        st.run.sessions = (st.run.sessions || 0) + 1
        return { action: 'dispatched', project: project.id, role: 'code-review', issue: issue.number, sessionId }
      }

      const sessionId = await startSession(project, 'tester', testerPrompt(project, issue, dialogReusable(project, 'tester', issue.number)), issue)
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

      // Смена начинается сама в окне и только один раз на смену. Смена здесь —
      // это окно суток (`shiftStamp`: дата + время начала окна), а не календарный
      // день: утренняя и ночная смены одного дня — разные смены, и вторая не
      // должна считаться повтором первой.
      if (!st.run && inWin && st.lastShiftKey !== shiftStamp(windows, now)) {
        st.lastShiftKey = shiftStamp(windows, now)
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

      // Сессию постановки привязываем до раздачи: новый тикет входит в конвейер в
      // том же тике, а привязка нужна раньше, чем по нему пойдёт расход ролей.
      // Ошибка книги не должна останавливать смену — она уже названа в lastError.
      try {
        await bindDraftSessions(project, issues)
      } catch (error) {
        state.lastError = 'книга учёта: ' + (error && error.message ? error.message : String(error))
      }

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
        delete st.unclosed[issue.number]
        delete st.findings[issue.number]
        // Пустые ходы половин тоже начинаются заново: человек вернул задачу,
        // значит следующая половина снова получает свой шанс.
        delete st.noWork[issue.number]
        for (const presetId of ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design']) {
          forgetDialog(project, presetId, issue.number)
        }
        st.run.entries.push({ number: issue.number, title: issue.title, role: 'человек', outcome: 'тикет возвращён в работу, попытки и доработки сброшены' })
      }

      // Решение принимает таблица процесса: первая ступень плана по приоритету.
      // Стражи и переходы меток исполняет dispatch(), а порядок «что раньше»
      // задан документом — его правят в вебе, а не в этом файле.
      const decision = decisionOf(project, issues)
      const open = inWin || opts.ignoreWindow
      // В открытом окне обслуживается первая ступень плана целиком. Вне окна ступень
      // без сессии (маршрут, передача половины, слитый PR) и начатая работа решаются
      // сразу: их расписание не держит.
      if (decision && (open || !isEntryStep(decision.step))) return dispatch(project, decision)

      // Закрытое окно. Входная ступень поднимает сессию по свежему тикету (выдача
      // разработчику, макет) и ждёт расписания, но начатую работу — ревью, тест,
      // слияние — останавливать не должна: ход начатой работы доводится и вне окна.
      // Поэтому решение ищется ещё раз по плану без входных ступеней, и смена
      // закрывается только тогда, когда пуст и он. Иначе тикет со `needs-mockup`
      // (приоритет 1) держал бы впереди себя ревью до утра.
      if (!open) {
        const started = decisionOf(project, issues, { skip: (step) => isEntryStep(step) })
        if (started) return dispatch(project, started)
      }

      // Внутри окна и делать нечего — пустой тик, а не конец смены: ждём
      // следующего, смена закроется сама по расписанию.
      if (open) return null

      // Вне окна и делать нечего: смена проекта закрыта. Незаконченная работа к
      // этому моменту уже доведена — до этой точки доходит только пустой конвейер.
      await finishProjectShift(project, now, FINISH.window)
      return { action: 'finished-shift', project: project.id }
    }

    // ── Кеш реестра проектов из веба ────────────────────────────────────────
    // Источник правды — база веба (`GET /api/registry`), а `projects.json` — её
    // кеш. Push из контейнера невозможен: контейнер не видит каталог состояния
    // DSH, а монтировать его ради записи одного файла — хуже, чем один GET в
    // несколько минут. Поэтому диспетчер тянет документ сам: склеивает ответ с
    // локальными ключами (`overlay` в `registry.mjs`) и пишет файл, только если
    // содержимое изменилось.
    //
    // Ошибка сети, `401` и невалидный документ файл не трогают: смена
    // продолжается на прошлом кеше, а причина видна в `dev_department_status`.
    // Нет блока `registry` в общих настройках — синхронизации нет вовсе, и файл
    // остаётся единственным источником, как было до версии 2.
    const REGISTRY_SYNC_MS = 5 * 60 * 1000
    const REGISTRY_SYNC_TIMEOUT_MS = 10 * 1000
    const registrySync = {
      ok: false,
      attemptedAt: null,   // последняя попытка — удачная или нет
      fetchedAt: null,     // последний удачный ответ
      changedAt: null,     // когда файл действительно переписан
      revision: null,      // отпечаток применённого документа
      localKeys: [],       // ключи, которые живут только в файле
      droppedProjects: [], // проекты файла, которых нет в документе веба
      lost: [],            // ключи, которым некуда лечь при склейке (`overlay().lost`)
      error: null,
    }

    const messageOf = (error) => (error && error.message ? error.message : String(error))

    // Причина отказа записи кеша: какие именно локальные ключи некуда положить.
    // Постановка просит до пяти ключей на проект и «…» при большем — иначе одна
    // строка статуса вырастает в весь файл реестра.
    function registryLostText(lost) {
      return lost.map((item) => {
        const keys = item.keys.slice(0, 5)
        if (item.keys.length > 5) keys.push('…')
        const named = keys.length > 0
          ? keys.join(', ')
          : (item.departments && item.departments.length > 0 ? 'отделы: ' + item.departments.join(', ') : '')
        return named ? item.id + ': ' + named : item.id
      }).join('; ')
    }

    // Отпечаток настроек реестра. Ревизию наружу отдаёт только запись (`PUT`/`rebuild`),
    // а `GET` возвращает сам документ; поэтому «на какой ревизии стоит кеш» отвечает
    // отпечаток содержимого. Heartbeat агентов в нём не участвует: `busy`/`idle` меняется
    // на каждом ходу, но не означает правку реестра и не должен двигать `changedAt`.
    function registryDigest(document) {
      const stable = Object.assign({}, document)
      if (Array.isArray(document.agents)) {
        stable.agents = document.agents.map((agent) => {
          const copy = Object.assign({}, agent)
          delete copy.status
          return copy
        })
      }
      return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 12)
    }

    // `registry.apiUrl` — полный адрес ручки (`http://localhost:8096/api/registry`),
    // а не база приложения: путь `/api` — достояние веба, и собирать его здесь
    // значило бы держать вторую копию контракта.
    function fetchRegistry(url, token) {
      return new Promise((resolve, reject) => {
        let target
        try {
          target = new URL(url)
        } catch (error) {
          reject(new Error('адрес реестра не разобран: ' + url))
          return
        }
        const transport = target.protocol === 'https:' ? https : http
        const headers = { Accept: 'application/json' }
        if (token) headers['X-Registry-Token'] = token
        const request = transport.get(target, { headers }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => resolve({ status: response.statusCode, body }))
        })
        request.setTimeout(REGISTRY_SYNC_TIMEOUT_MS, () => request.destroy(new Error('таймаут ответа')))
        request.on('error', reject)
      })
    }

    async function syncRegistryFromApi(options) {
      const opts = options || {}
      const settings = config.values.registry
      if (!settings || !settings.apiUrl) return { skipped: 'адрес реестра не задан' }
      const attemptedAt = Date.now()
      if (!opts.force && registrySync.attemptedAt !== null && attemptedAt - registrySync.attemptedAt < REGISTRY_SYNC_MS) {
        return { skipped: 'рано: реестр забирается раз в ' + Math.round(REGISTRY_SYNC_MS / 60000) + ' мин' }
      }
      registrySync.attemptedAt = attemptedAt

      let response
      try {
        response = await fetchRegistry(settings.apiUrl, settings.token)
      } catch (error) {
        registrySync.ok = false
        registrySync.error = 'реестр из веба: ' + messageOf(error)
        return { error: registrySync.error }
      }
      if (response.status !== 200) {
        registrySync.ok = false
        // 401 — токен не тот; 404 — ревизий ещё нет. Оба случая оставляют кеш
        // как есть: документ собирают в вебе, а не подставляют из воздуха.
        registrySync.error = response.status === 401
          ? 'реестр из веба: токен реестра не принят'
          : (response.status === 404
            ? 'реестр из веба: реестр ещё не собран'
            : 'реестр из веба: ' + settings.apiUrl + ' ответил кодом ' + response.status)
        return { error: registrySync.error }
      }
      let raw
      try {
        raw = JSON.parse(response.body)
      } catch (error) {
        registrySync.ok = false
        registrySync.error = 'реестр из веба: ответ не JSON — ' + messageOf(error)
        return { error: registrySync.error }
      }
      const parsed = parseRegistry(raw, 'реестр из веба')
      if (parsed.fatal) {
        // Текст разбора уже начинается с «реестр из веба: …» — второй префикс не нужен.
        registrySync.ok = false
        registrySync.error = parsed.fatal
        return { error: registrySync.error }
      }

      // Локальные ключи берутся из текущего файла. Файл есть, но не разобран —
      // писать поверх нельзя: в нём лежит то, чего в вебе нет (telegram, labels),
      // и молча стереть это дороже, чем один тик без обновления.
      let local = null
      const current = readStateFile(STATE_FILES.projects)
      if (fs.existsSync(current)) {
        try {
          local = readRegistryFile(current).document
        } catch (error) {
          registrySync.ok = false
          registrySync.error = 'реестр из веба: локальный файл не разобран, кеш не переписан — ' + messageOf(error)
          return { error: registrySync.error }
        }
      }

      const merged = overlay(parsed.document, local)
      registrySync.localKeys = merged.localKeys
      registrySync.droppedProjects = merged.droppedProjects
      registrySync.lost = merged.lost
      // Склейка потеряла бы локальные ключи: проекта нет в документе API или у
      // локального отдела нет вида в документе. Писать такой файл нельзя — в нём
      // человек держит telegram, порты, areas и второе окно смены, — смена
      // продолжается на прошлом кеше, а причина с перечнем ключей видна в статусе.
      // Флага работы отдела (`enabled`) в этом перечне нет с #65: он приходит из
      // документа API и локальным ключом файла больше не бывает.
      // Ровно это и случилось на первой живой синхронизации,
      // когда `id` в документе был числовым, а в файле — слаги.
      if (merged.lost.length > 0) {
        registrySync.ok = false
        registrySync.error = 'реестр из веба: не совпали проекты — '
          + registryLostText(merged.lost) + '; кеш не переписан'
        return { error: registrySync.error, lost: merged.lost }
      }
      const written = writeRegistryFile(stateFile(STATE_FILES.projects), merged.document)
      registrySync.ok = true
      registrySync.error = null
      registrySync.fetchedAt = new Date().toISOString()
      const previousRevision = registrySync.revision
      registrySync.revision = registryDigest(merged.document)
      if (written.changed && (previousRevision === null || previousRevision !== registrySync.revision)) {
        registrySync.changedAt = registrySync.fetchedAt
      }
      return { ok: true, changed: written.changed, revision: registrySync.revision, localKeys: merged.localKeys }
    }

    // ── раскладка пресетов ролей из веба ───────────────────────────────────
    //
    // Раскладка при загрузке плагина ставит ПАКЕТ (`deployPresets`): до первого
    // ответа веба роли уже на месте. Тик сверяет раскладку с базой: правка роли
    // в браузере доезжает до `~/.dsh/.agent-presets` здесь. Пока ревизия набора
    // не менялась, сети — один запрос манифеста и ни одной записи файлов.
    //
    // Сбой не откатывает раскладку и не останавливает смену: `syncPresets`
    // трогает `target` только после того, как все документы собраны, поэтому
    // неудача оставляет прежние роли рабочими и называет себя в статусе.
    async function syncRolePresets() {
      const settings = config.values.registry
      if (!settings || !settings.apiUrl) {
        state.presets.error = null
        return { skipped: 'адрес API не задан' }
      }
      const apiUrl = presetsApiBase(settings.apiUrl)
      if (!apiUrl) {
        state.presets.ok = false
        state.presets.error = 'пресеты ролей: адрес API не разобран: ' + settings.apiUrl
        state.lastError = state.presets.error
        return { error: state.presets.error }
      }

      const result = await syncPresets({
        apiUrl,
        token: settings.token,
        source: PRESETS_SOURCE,
        template: PRESETS_TEMPLATE,
        target: path.join(dshHome(), '.agent-presets'),
        deploy: (options) => deployPresets(options),
        applied: state.presets.applied,
      })

      state.presets.at = new Date().toISOString()
      if (!result.ok) {
        state.presets.ok = false
        state.presets.error = result.error || 'пресеты ролей: синхронизация не удалась'
        state.presets.deployed = false
        state.lastError = state.presets.error
        return { error: state.presets.error }
      }

      state.presets.ok = true
      state.presets.error = null
      state.presets.revision = result.revision || null
      state.presets.roles = Array.isArray(result.roles) ? result.roles : []
      state.presets.removed = Array.isArray(result.removed) ? result.removed : []
      state.presets.deployed = !!result.deployed
      state.presets.written = Number.isInteger(result.written) ? result.written : 0
      state.presets.updated = Number.isInteger(result.updated) ? result.updated : 0
      // Ревизия, на которой стоит раскладка: следующий тик сравнит её с манифестом
      // и не станет ни читать документы, ни писать файлы без надобности.
      state.presets.applied = {
        revision: result.revision || null,
        roles: result.roleRevisions && typeof result.roleRevisions === 'object'
          ? result.roleRevisions
          : {},
      }
      if (state.presets.deployed || state.presets.removed.length > 0) {
        appendShiftLog('🛠 Пресеты ролей из веба разложены в ' + path.join(dshHome(), '.agent-presets') +
          ': ' + (state.presets.roles.length > 0 ? state.presets.roles.join(', ') : 'ни одной роли') +
          ' (новых файлов ' + state.presets.written + ', обновлено ' + state.presets.updated + ')' +
          (state.presets.removed.length > 0
            ? '. Убраны роли, которых нет в вебе: ' + state.presets.removed.join(', ')
            : '') + '.')
      }
      return { ok: true, revision: state.presets.revision }
    }

    // ── журнал расхода в вебе (#57, #72) ────────────────────────────────────
    //
    // Смена уезжает в веб количествами токенов, без денег: сумму считает веб по ценам
    // проекта (`app/money.py`), формула одна и на сервере. Отдел только печатает
    // `cost_usd` из ответа, а снимок цены остаётся у строки журнала — смена прайса
    // прошлых смен не переписывает.
    //
    // Отправка идёт в конце смены, а не по тику: журнал — это отчёт о смене, и
    // промежуточный POST дал бы строки, которых в смене ещё не было. Исключение —
    // очередь: смена, которую канал не взял, досылается на ближайшем тике.
    //
    // Адрес ручки собирается из `registry.apiUrl` — второго адреса надстройки нет.
    function usageEndpoint() {
      const settings = config.values.registry
      if (!settings || !settings.apiUrl) return ''
      return shiftReportUrl(presetsApiBase(settings.apiUrl))
    }

    async function flushShiftQueue() {
      state.usageSync.at = new Date().toISOString()
      const waiting = queueLength()
      state.usageSync.queue = waiting
      if (waiting === 0) {
        // Пустая очередь — не событие: `ok` остаётся прежним, чтобы статус не
        // показывал «всё хорошо» после сбоя, о котором ещё не дослали.
        return { skipped: 'очередь пуста' }
      }
      const settings = config.values.registry
      const url = usageEndpoint()
      const result = await flushQueue({ url, token: settings ? settings.token : null })
      state.usageSync.queue = result.left
      state.usageSync.sent += result.sent
      state.usageSync.dropped += result.dropped
      if (result.left > 0) {
        state.usageSync.ok = false
        state.usageSync.error = result.error || 'смены не уходят'
        state.lastError = 'журнал расхода: ' + state.usageSync.error
      } else {
        state.usageSync.ok = true
        state.usageSync.error = null
      }
      // Молчать нельзя: выброшенная смена — это потерянный расход, и узнать о ней
      // человек может только отсюда.
      if (result.sent > 0 || result.dropped > 0) {
        appendShiftLog('🛠 Журнал расхода: дослано смен — ' + result.sent +
          ', выброшено — ' + result.dropped + ', осталось в очереди — ' + result.left +
          (result.error ? ' (' + result.error + ')' : '') + '.')
      }
      return result
    }

    // Отправить закрытую смену проекта и вернуть строку для сводки. Денег в теле нет:
    // сумму каждой сессии и всей смены считает веб по ценам проекта (`app/money.py`),
    // а строка сводки печатает `cost_usd` из ответа как есть.
    async function pushShiftReport(project, options) {
      const cards = options.cards
      if (cards.length === 0) {
        return { line: REPORT_PREFIX + 'данных о расходе нет', skipped: 'нет сессий' }
      }
      // Ключ смены — дата её НАЧАЛА и время начала окна (`shiftStamp`). Одной даты
      // мало: утренняя и ночная смены одного дня дали бы одинаковый ключ, второй
      // POST вернул бы `changed:false`, и расход второй смены пропал бы молча.
      // Считать ключ от закрытия тоже нельзя: ночная смена, закрывшаяся после
      // полуночи, назвалась бы днём окончания. `startedAt` здесь — ISO-строка из
      // состояния проекта.
      const key = shiftStamp(
        project.department.windows,
        options.startedAt ? new Date(options.startedAt) : options.endedAt,
      )
      const report = buildShiftReport({
        project,
        shiftKey: key,
        startedAt: options.startedAt,
        endedAt: options.endedAt,
        reason: options.reason,
        cards,
      })
      state.usageSync.at = new Date().toISOString()
      const url = usageEndpoint()
      if (!url) {
        // Канал ещё не настроен, но смена посчитана: она ждёт в очереди, а не теряется.
        // Ошибку записи в очередь читаем: если файл недоступен, «останется в очереди» —
        // неправда, и сказать об этом надо и в строке сводки, и в статусе отдела.
        const enqueued = enqueue(report, { error: 'адрес веба не задан' })
        const note = enqueued.error ? '; в очередь не записана — ' + enqueued.error : '; останется в очереди'
        state.usageSync.ok = false
        state.usageSync.error = 'адрес веба не задан' + (enqueued.error ? '; в очередь не записана — ' + enqueued.error : '')
        state.usageSync.queue = enqueued.error ? queueLength() : enqueued.queued
        return {
          line: REPORT_PREFIX + 'смена ' + key + ' не отправлена — адрес веба не задан' + note,
          skipped: 'нет адреса',
        }
      }
      const result = await deliverShift(report, {
        url,
        token: config.values.registry ? config.values.registry.token : null,
      })
      state.usageSync.queue = result.queued
      state.usageSync.line = result.line
      if (result.ok) {
        // `sent` — это «смена записана в журнал», а не «веб ответил 2xx»: ответ
        // `changed:false` значит, что смена с таким ключом уже лежит в журнале и
        // расход не записан. Считать её отправленной — показывать в статусе
        // доставку, которой нет; потерянный расход виден только по `dropped`.
        if (!result.result || result.result.changed !== false) state.usageSync.sent += 1
        state.usageSync.ok = true
        state.usageSync.error = null
      } else {
        // Отказ по существу (`422`, `409` после всех попыток) в очередь не ложится —
        // это потерянный расход, и счётчик `dropped` показывает её в статусе. Смена,
        // которая ждёт канал, — временная беда: она остаётся в очереди. Считаем по
        // `retryable`, а не по пустоте очереди: при непустой очереди `422` тоже
        // теряет смену, и раньше это пропадало из счётчика.
        state.usageSync.ok = false
        state.usageSync.error = result.error
        if (result.result && result.result.retryable === false) state.usageSync.dropped += 1
      }
      return result
    }

    async function step(options) {
      const opts = options || {}
      config = loadConfig()
      const now = new Date()
      state.lastTickAt = now.toISOString()

      // Кеш реестра обновляется до чтения проектов: тик должен работать на том
      // документе, который только что пришёл из веба.
      await syncRegistryFromApi({ force: !!opts.forceRegistry })

      // Роли и скиллы правятся в вебе, а читаются из `~/.dsh/.agent-presets`,
      // поэтому раскладка сверяется с базой до первого хода проекта: иначе агент
      // взял бы тикет с устаревшим скиллом. Сбой синхронизации раскладку не
      // стирает — та, что была, остаётся рабочей.
      try {
        await syncRolePresets()
      } catch (error) {
        state.presets.ok = false
        state.presets.error = 'пресеты ролей: ' + messageOf(error)
        state.lastError = state.presets.error
      }

      // Смены, которые веб не взял в прошлый раз, досылаются до первого хода
      // проекта: журнал расхода не должен зависеть от того, был ли стенд поднят
      // ровно в минуту закрытия смены. Сбой досылки смену в конвейере не
      // останавливает — очередь переживёт и это.
      try {
        await flushShiftQueue()
      } catch (error) {
        state.usageSync.ok = false
        state.usageSync.error = 'журнал расхода: ' + messageOf(error)
        state.lastError = state.usageSync.error
      }

      const loaded = loadProjects(config.values)
      state.projectProblem = loaded.problem
      state.servedIds = loaded.projects.map((p) => p.id)
      state.disabledIds = loaded.disabled
      if (loaded.problem) state.lastError = 'проекты: ' + loaded.problem

      if (loaded.projects.length === 0) {
        // Отдел не обслуживает ни один проект. Причина может быть названа (файл
        // реестра не той формы, пропавшая рабочая область) или нет (отдел везде
        // выключен) — но молчать нельзя: об этой остановке человек узнаёт только
        // отсюда, из журнала смены и Telegram.
        const alarm = await noteRegistrySilent(loaded, now)
        if (alarm && alarm.error) state.lastError = 'Telegram: ' + alarm.error
        return {
          action: 'config-error',
          note: loaded.problem || 'нет ни одного проекта с включённым отделом',
          alarm: alarm ? alarm.text : null,
          projects: [],
        }
      }
      const recovered = await noteRegistryServing(loaded)
      if (recovered && recovered.error) state.lastError = 'Telegram: ' + recovered.error

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
      // Тикет, на котором смена застала живой ход, в журнал смены ещё не попал:
      // строка «закончил» появляется позже. Для отчёта о расходе он — участник
      // смены, иначе сводка закрывала бы смену, утаив её самые дорогие токены.
      const active = st.session
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
      } else if (active) {
        lines.push('')
        lines.push('• #' + active.issue + ' ' + active.title + ' — ' + active.role + ': в работе, ход не закончен')
      } else {
        lines.push('Работы не было: подходящих тикетов не нашлось.')
      }
      // Расход смены: строка на тикет смены и общий итог. Считает модуль учёта —
      // то же правило повтора, что в карточке статуса и в отчёте по токенам.
      // Модуля нет (старая установка) — строк нет вовсе: выдумывать нули хуже,
      // чем промолчать, а статус в этом случае прямо говорит о пропаже модуля.
      const inShift = run ? run.entries.slice() : []
      if (active) inShift.push({ number: active.issue, title: active.title, role: active.role })
      const usageModule = inShift.length > 0 ? await loadUsageLedger() : null
      if (usageModule !== null) {
        const numbers = []
        for (const entry of inShift) if (!numbers.includes(entry.number)) numbers.push(entry.number)
        const shiftTotals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
        const usageLines = []
        // Карточки, которые вошли в смену: их сессии и уезжают в веб. Одна карточка
        // на тикет — так строка журнала получает номер и заголовок тикета.
        const cards = []
        let counted = 0
        for (const number of numbers) {
          const title = (inShift.filter((entry) => entry.number === number)[0] || {}).title || ''
          // Смена отчитывается за СВОИ выдачи ролей: в книге лежат и записи прошлых
          // смен, и прежние доработки того же тикета, и складывать их в дневную
          // цифру нельзя — иначе «потрачено» пухнет с каждым возвратом в доработку.
          // Но диалог, которому смена дала ход, — её расход, даже если привязка у него
          // родилась в прошлой смене: доработка идёт в тот же диалог, и дедуп книги
          // второй записи не делает. Такие сессии карточка берёт по набору смены.
          const card = await usageCard(project, { number, title }, {
            since: run ? run.startedAt : null,
            sessions: run && run.prompted ? Array.from(run.prompted) : [],
          })
          if (card.sessions.length === 0) {
            // Ноль вместо расхода не печатаем: у тикета, заведённого до книги, сессии
            // есть только в заголовках отчёта, и «смена потратила 0» — неправда.
            // Говорим то же, что говорит карточка статуса, и её же замечания.
            usageLines.push('потрачено #' + number + ': ' + (card.note || 'данных о расходе нет'))
            for (const problem of card.problems || []) usageLines.push('  ! ' + problem)
            continue
          }
          counted += 1
          cards.push({ issue: number, title, sessions: card.sessions })
          shiftTotals.in += card.totals.in
          shiftTotals.out += card.totals.out
          shiftTotals.cacheRead += card.totals.cacheRead
          shiftTotals.cacheWrite += card.totals.cacheWrite
          // Денег в строке нет: сумму считает веб по ценам проекта и присылает в ответе
          // на приём смены, а её `cost_usd` печатается ниже строкой журнала.
          usageLines.push('потрачено #' + number + ': ' + usageModule.usageLine(card.totals) +
            ' (' + card.sessions.length + ' ' + sessionWord(card.sessions.length) + ')' +
            (card.carried > 0 ? ' · в т.ч. продолженный диалог: ' + card.carried : ''))
          for (const problem of card.problems || []) usageLines.push('  ! ' + problem)
        }
        // Итог печатается только когда есть что складывать: сумма нулей — та же
        // неправда, что строка с нулями по тикету.
        if (counted > 0) {
          usageLines.push('Итого за смену: ' + usageModule.usageLine(shiftTotals))
        }
        // Журнал в веб — после итогов и до сборки текста: строка о нём должна попасть
        // и в журнал смены, и в Telegram. Отправка не бросает: её собственный сбой
        // называется строкой сводки, а смена в очередь.
        let pushed = null
        try {
          pushed = await pushShiftReport(project, {
            cards,
            startedAt: run ? run.startedAt : null,
            endedAt: now,
            reason: reason === FINISH.manual ? 'manual' : 'window',
          })
        } catch (error) {
          // Смену на этом пути не удалось ни отправить, ни положить в очередь: обещать
          // «останется в очереди» нельзя — расход правда потерян, и это видно в статусе.
          state.usageSync.ok = false
          state.usageSync.error = 'журнал расхода: ' + messageOf(error)
          pushed = { line: REPORT_PREFIX + 'не отправлен — ' + messageOf(error) }
        }
        if (pushed && pushed.line) usageLines.push(pushed.line)
        if (usageLines.length > 0) {
          lines.push('')
          for (const line of usageLines) lines.push(line)
        }
      }
      if (state.lastError) lines.push('\n⚠️ Последняя ошибка: ' + state.lastError)
      // Единственный источник бота — поле telegram записи проекта в реестре.
      // Проект без бота работает без Telegram: это нормальное состояние, а не
      // сбой, поэтому в state.lastError о нём ничего не пишется — только строка
      // в тексте сводки, и она же попадает в журнал.
      if (!project.telegram) {
        lines.push('\nTelegram: не отправлено — у проекта не задан telegram (только журнал).')
      }
      const summaryText = lines.join('\n')
      // Сводку сначала кладём на диск: канал до Telegram бывает недоступен, и
      // терять отчёт за смену из-за этого нельзя.
      appendShiftLog(summaryText)
      // Доставку сообщаем вызывающему явно: глобальный state.lastError для этого
      // не годится — он нигде не сбрасывается, а при повторе того же отказа
      // (лежит сеть, битый токен у двух проектов) остаётся прежним, и сравнение
      // «до/после» объявило бы второй одинаковый сбой доставкой.
      let delivered = false
      if (project.telegram) {
        try {
          // Сводка проекта уходит боту ЭТОГО проекта; другого источника нет.
          await sendTelegram(project.telegram, summaryText)
          delivered = true
        } catch (error) {
          state.lastError = 'Telegram: ' + error.message
        }
      }
      return { text: summaryText, delivered }
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
        // Тревога считается и здесь: человек, который спросил статус, — это первый,
        // кто заметил остановку, и он вправе увидеть её в журнале и в Telegram, а
        // не только в пустом `serving`. Троттлинг общий с тиком.
        const alarm = loaded.projects.length === 0
          ? await noteRegistrySilent(loaded, now)
          : await noteRegistryServing(loaded)
        if (alarm && alarm.error) state.lastError = 'Telegram: ' + alarm.error
        const report = {
          now: now.toISOString(),
          // Токен реестра — секрет: в ответ инструмента он не попадает, но факт
          // его наличия виден (иначе не понять, почему 401).
          sharedConfig: {
            values: Object.assign({}, config.values, {
              registry: config.values.registry
                ? Object.assign({}, config.values.registry, { token: config.values.registry.token ? '***' : undefined })
                : config.values.registry,
            }),
            problem: config.problem,
          },
          registry: {
            problem: loaded.problem,
            defaultId: loaded.defaultId,
            serving: loaded.projects.map((p) => p.id),
            disabled: loaded.disabled,
            // Справочник агентов с последним heartbeat: его же видит раздел «Агенты» в
            // вебе. Пустой массив — «агентов нет»; `dsh` заводит миграция.
            agents: loaded.agents || [],
            // Тревога по реестру: отдел не обслуживает ни одного проекта. `since` —
            // когда отдел впервые увидели без проектов, `lastSentAt` — когда об этом
            // последний раз сказали (журнал и Telegram), `channel` — где сказали:
            // `telegram` или `log`, если бота у проекта по умолчанию нет.
            alarm: {
              active: registryAlarm.active,
              since: registryAlarm.since,
              lastSentAt: registryAlarm.lastSentAt,
              channel: registryAlarm.channel,
            },
          },
          // Состояние кеша: `ok` и `revision` — по контракту, остальное объясняет
          // расхождение. `localKeys` — то, что живёт только в файле: человек
          // должен видеть, что правка в вебе этих полей не задаёт.
          registrySync: {
            ok: registrySync.ok,
            revision: registrySync.revision,
            url: config.values.registry ? config.values.registry.apiUrl : null,
            fetchedAt: registrySync.fetchedAt,
            changedAt: registrySync.changedAt,
            attemptedAt: registrySync.attemptedAt === null ? null : new Date(registrySync.attemptedAt).toISOString(),
            localKeys: registrySync.localKeys,
            droppedProjects: registrySync.droppedProjects,
            // Ключи, которым некуда лечь: при непустом списке кеш не переписан,
            // и рядом стоит причина (`error`). Массив, а не строка: человеку нужен
            // перечень, а не пересказ.
            lost: registrySync.lost,
            error: registrySync.error,
          },
          // Heartbeat диспетчера: `ok: null` — записей в этом процессе ещё не было.
          // Отказ виден рядом с `registrySync`/`presetsSync` и остаётся в `lastError`,
          // но ход из-за него не срывается.
          agentSync: {
            ok: state.agentSync.ok,
            at: state.agentSync.at,
            code: state.agentSync.code,
            state: state.agentSync.state,
            issue_number: state.agentSync.issue_number,
            error: state.agentSync.error,
          },
          // Раскладка пресетов ролей: `ok: null` — синхронизации в этом процессе
          // ещё не было. `roles` — что разложено, `removed` — роли, которых в вебе
          // больше нет; ошибка называется рядом, а не только в `lastError`, потому
          // что она не останавливает смену и живёт до следующего тика.
          // Имя `presetsSync` — из контракта задачи (#56): по нему тестировщик и
          // человек смотрят, на какой ревизии стоит раскладка.
          presetsSync: {
            ok: state.presets.ok,
            revision: state.presets.revision,
            roles: state.presets.roles,
            removed: state.presets.removed,
            deployed: state.presets.deployed,
            attemptedAt: state.presets.at,
            error: state.presets.error,
          },
          // Журнал расхода в веб (#57): `ok: null` — отправок в этом процессе ещё не
          // было (и очередь пуста). `queue` — сколько смен ждёт канал; `dropped` —
          // сколько не принято и уже выброшено: это потерянный расход, и его видно
          // здесь, а не только в журнале смены.
          usageSync: {
            ok: state.usageSync.ok,
            url: config.values.registry && config.values.registry.apiUrl
              ? shiftReportUrl(presetsApiBase(config.values.registry.apiUrl))
              : null,
            queue: state.usageSync.queue,
            sent: state.usageSync.sent,
            dropped: state.usageSync.dropped,
            attemptedAt: state.usageSync.at,
            lastLine: state.usageSync.line,
            error: state.usageSync.error,
          },
          lastTickAt: state.lastTickAt,
          lastError: state.lastError,
          dialogs: dialogSessionIds(state.dialogs),
          projects: [],
        }
        // Настоящее состояние конвейера — в метках GitHub, поэтому оно переживает
        // перезапуск приложения и показывается здесь же, по каждому проекту.
        for (const project of loaded.projects) {
          const st = projectState(project.id)
          const dept = project.department
          const inWin = inWindow(dept.windows, now)
          const delegated = delegatedStepsOf(project.process.document, project.tagAgents, project.agents)
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
            // Чем отдел исполняет конвейер: документ из веба или умолчания, его
            // отпечаток и сколько в нём ступеней. Негодный документ виден здесь же
            // `problems`: он процессом не стал, и это надо увидеть, не читая лог.
            process: {
              source: project.process.source,
              digest: project.process.digest,
              steps: project.process.document.steps.filter((step) => step.enabled !== false).length,
              problems: project.process.problems,
            },
            // Ступени, отданные агентам: диспетчер их не берёт, и карточка обязана
            // назвать это, когда план пуст, — иначе пустой тик выглядит как «тикетов нет».
            delegatedSteps: delegated,
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
                kind: active.kind,
                labels: labelsOf(active.issue),
              }
              : null
            row.queuedForDev = queued.map((i) => ({ number: i.number, title: i.title }))
            // Расход по активному тикету: та же форма, что у отчёта
            // `tools/issue-tokens.mjs`, — числа берутся из одной книги и одного
            // правила повтора, поэтому карточка и отчёт не могут разойтись.
            row.usage = active ? await usageCard(project, active.issue) : null
            row.nextStep = active
              ? (active.role === 'code-review'
                ? 'поднять code-review по issue #' + active.issue.number
                : active.role === 'tester'
                  ? 'поднять tester по issue #' + active.issue.number
                  : 'поднять ' + active.role + ' по issue #' + active.issue.number + ' (' + active.kind + ')')
              : (queued.length > 0
                ? (inWin ? 'в окне — взять issue #' + queued[0].number : 'вне окна — ждать расписания, тогда issue #' + queued[0].number)
                : (delegated.length > 0
                  ? 'делать нечего: ступени разобраны агентами — ' +
                    delegated.slice(0, 5).map((entry) => entry.title + ' (' + entry.agent + ')').join(', ') +
                    (delegated.length > 5 ? ', …' : '')
                  : 'делать нечего: очередь пуста'))
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
        const result = await step({ ignoreWindow: true, forceRegistry: true })
        return { result, state: { projects: state.projects, disabled: state.disabledIds } }
      },
    )

    const summaryTool = define(
      'dev_department_summary',
      'Закрыть смены всех проектов, где они идут, и отправить их сводки в Telegram. Сводка уходит только боту отдела разработки проекта из реестра (projects[].departments[].telegram): у проекта без бота она остаётся в журнале.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        config = loadConfig()
        const loaded = loadProjects(config.values)
        const closed = []
        // sent — это «сводка ушла в Telegram», а не «смена закрылась»: у проекта
        // без бота сводка остаётся в журнале, и отчитываться за неё отправкой —
        // значит обещать человеку сообщение, которого в чате нет. Отдельно
        // названы доставленные проекты и те, у кого отправка сорвалась сетью.
        // Доставку называет сама finishProjectShift: сравнивать state.lastError
        // до и после нельзя — он не сбрасывается и при повторном одинаковом
        // отказе не меняется, поэтому второй такой же сбой считался бы доставкой.
        const telegram = []
        const failed = []
        const now = new Date()
        for (const project of loaded.projects) {
          const st = state.projects[project.id]
          if (!st || !st.run) continue
          const result = await finishProjectShift(project, now, FINISH.manual)
          closed.push(project.id)
          if (!project.telegram) continue
          if (result && result.delivered) telegram.push(project.id)
          else failed.push(project.id)
        }
        let note = null
        if (closed.length === 0) note = 'ни в одном проекте смена не идёт — отправлять нечего'
        else if (telegram.length + failed.length === 0) note = 'у закрытых проектов не задан telegram — сводки только в журнале'
        return { sent: telegram.length > 0, closed, telegram, failed, note }
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
      'Завести рабочие области агентов в реестре рабочих областей DSH для всех проектов из реестра проектов отдела (projects.json в каталоге состояния отдела, включая проекты с выключенным отделом) и сказать, у какого проекта нет каталога или git-клона. Повторный вызов ничего не дублирует: заведённая область возвращается как есть.',
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
