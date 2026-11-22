// Реестр проектов отдела, версия 2: разбор документа, проверка, отбор проекта
// отдела разработки и склейка с локальными ключами.
//
// Источник правды — база веба (`/api/registry`), а `projects.json` в каталоге
// состояния отдела — её кеш. Кеш пишет диспетчер: раз в несколько минут он
// забирает документ из API и кладёт в файл, сохраняя ключи, которых API не
// отдаёт. Эти ключи (`default`, `telegram`, `labels`, `areas`, `frontendPort`,
// `apiPort`) человек правит руками, веб их не знает, и ни GET, ни PUT
// их не трогают — поэтому синхронизация обязана их не потерять (см. `overlay`).
// Флаг работы отдела (`enabled`) локальным больше не бывает: он приходит из
// документа API и живёт в базе веба — см. поле `enabled` в форме ниже.
//
// Модуль — единственное место, где известна форма v2. Его читают диспетчер, мост
// Telegram, `sync.mjs` и инструменты `plugins/tools/`: ни один из них не разбирает
// `projects` сам, иначе пятая копия формы разошлась бы с первой молча.
//
// Форма документа:
//
//   {
//     "version": 2,
//     "default": "vahta",                    // необязательно, локальный ключ
//     "projects": [                          // массив, а не объект
//       {
//         "id": "vahta",                     // стабильный идентификатор, уникален
//         "title": "Вахта",
//         "departments": [
//           {
//             "kind": "development",         // код вида отдела
//             "repo": "gidvantus/vahta",     // ниже — поля отдела, версия 1
//             "base": "develop-m",
//             "workspace": "D:\\Agents\\Vahta",
//             "humanClone": "D:\\Development\\VideCoding\\Vahta",
//             "artifacts": "D:\\Agents\\vahta-artifacts",
//             "composeProject": "vahta-agent",
//             "windows": [{ "start": "13:00", "stop": "04:00" }],
//             "maxRework": 3,
//             "enabled": true,                   // из веба: работа отдела включена
//             "telegram": { "token": "…", "chatId": 1 },
//           }
//         ]
//       }
//     ]
//   }
//
// Версия 1 — это `projects` объектом, где запись проекта держала поля отдела
// прямо у себя (`repo`, `workspace`, `department.windows`, `telegram`). Такая
// форма больше не читается ни одним модулем: конвертер
// `plugins/tools/registry-v1-to-v2.mjs` переводит её один раз, и человека
// просят это сделать до выкатки, а не после.
import fs from 'node:fs'
import path from 'node:path'

/** Версия документа, которую понимает весь код отдела. */
export const REGISTRY_VERSION = 2

/** Код вида отдела, которым занимается диспетчер разработки. */
export const DEVELOPMENT_KIND = 'development'

// BOM в начале файла (его пишут редакторы Windows и PowerShell) ломает
// JSON.parse невидимым символом. Реестр — обычный файл, который человек правит
// руками, поэтому читаем его снисходительно.
export function stripBom(text) {
  const value = String(text)
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

// Путь для сравнения: слэши в одну сторону, хвостовой слэш прочь, регистр не важен
// (Windows). Та же нормализация, что у моста Telegram: проект ищется по рабочей
// области, а её человек пишет как удобно.
export function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Копия документа: реестр — обычный JSON, а склейка не должна править ни
// прочитанный файл, ни ответ API.
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function hasKey(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Разбор документа v2. Возвращает `{document, problems, fatal}`:
 * `document` — нормализованная копия (или `null`, если документ негоден целиком),
 * `problems` — всё, что отброшено по дороге (проект, отдел), но не мешает
 * остальным, `fatal` — текст, из-за которого документ не читается вовсе.
 */
export function parseRegistry(raw, at = 'projects.json') {
  const problems = []
  if (!isObject(raw)) {
    return { document: null, problems, fatal: at + ': в файле не объект' }
  }
  if (raw.version !== REGISTRY_VERSION) {
    const found = raw.version === undefined ? 'не указана' : String(raw.version)
    return {
      document: null,
      problems,
      fatal: at + ': версия реестра ' + found + ', а поддерживается только ' + REGISTRY_VERSION +
        ' — переведите файл конвертером plugins/tools/registry-v1-to-v2.mjs',
    }
  }
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    return { document: null, problems, fatal: at + ': реестр пуст — в "projects" нет ни одного проекта' }
  }

  const projects = []
  const ids = new Set()
  for (let index = 0; index < raw.projects.length; index += 1) {
    const where = 'проект №' + (index + 1)
    const rawProject = raw.projects[index]
    if (!isObject(rawProject)) {
      problems.push(at + ': ' + where + ' — не объект')
      continue
    }
    const id = nonEmptyString(rawProject.id) ? rawProject.id.trim() : ''
    if (!id) {
      problems.push(at + ': ' + where + ' — не задан id')
      continue
    }
    const label = 'проект «' + id + '»'
    if (ids.has(id)) {
      problems.push(label + ': id повторяется — вторая запись пропущена')
      continue
    }
    ids.add(id)
    if (!Array.isArray(rawProject.departments) || rawProject.departments.length === 0) {
      problems.push(label + ': не задано ни одного отдела — проект пропущен')
      continue
    }

    const departments = []
    const kinds = new Set()
    for (let number = 0; number < rawProject.departments.length; number += 1) {
      const departmentWhere = label + ', отдел №' + (number + 1)
      const rawDepartment = rawProject.departments[number]
      if (!isObject(rawDepartment)) {
        problems.push(departmentWhere + ': не объект')
        continue
      }
      const kind = nonEmptyString(rawDepartment.kind) ? rawDepartment.kind.trim() : ''
      if (!kind) {
        problems.push(departmentWhere + ': не задан вид отдела (kind)')
        continue
      }
      // Два отдела одного вида в проекте бессмысленны: какой из них обслуживать,
      // из документа не следует. Исключение — `development`: его дубль делает
      // проект необслуживаемым целиком, и об этом говорит developmentOf().
      if (kind !== DEVELOPMENT_KIND && kinds.has(kind)) {
        problems.push(label + ': отдел вида «' + kind + '» повторяется — вторая запись пропущена')
        continue
      }
      kinds.add(kind)
      departments.push(Object.assign(clone(rawDepartment), { kind }))
    }

    if (departments.length === 0) {
      problems.push(label + ': ни одного годного отдела — проект пропущен')
      continue
    }

    const project = Object.assign(clone(rawProject), {
      id,
      title: nonEmptyString(rawProject.title) ? rawProject.title : id,
      departments,
    })
    projects.push(project)
  }

  if (projects.length === 0) {
    return {
      document: null,
      problems,
      fatal: at + ': нет ни одного годного проекта' + (problems.length > 0 ? ' — ' + problems.join('; ') : ''),
    }
  }

  const document = Object.assign(clone(raw), { version: REGISTRY_VERSION, projects })
  if (!nonEmptyString(document.default)) delete document.default
  else document.default = document.default.trim()

  const known = new Set(projects.map((project) => project.id))
  if (document.default !== undefined && !known.has(document.default)) {
    problems.push('default указывает на неизвестный проект «' + document.default + '»')
  }
  return { document, problems: problems, fatal: null }
}

/**
 * Чтение файла реестра: та же ошибка «не читается реестр проектов <файл>», что
 * была у диспетчера, поэтому сообщение в состоянии смены не меняется.
 */
export function readRegistryFile(file) {
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error('не читается реестр проектов ' + file + ': ' + (error && error.message ? error.message : String(error)))
  }
  const parsed = parseRegistry(raw, file)
  if (parsed.fatal) throw new Error(parsed.fatal)
  return parsed
}

/** Проекты документа списком: `[]`, если документ ещё не разобран. */
export function projectsOf(document) {
  return isObject(document) && Array.isArray(document.projects) ? document.projects : []
}

/** Отделы проекта заданного вида списком: `[]`, если таких нет. */
export function departmentOf(project, kind) {
  const departments = isObject(project) && Array.isArray(project.departments) ? project.departments : []
  return departments.filter((department) => isObject(department) && department.kind === kind)
}

/**
 * Отдел разработки проекта. `department: null` и `problem: null` — «проект не
 * наш» (например, только маркетинг): такой проект диспетчер просто не трогает.
 * `problem` — проект пропускается, но с причиной в статусе.
 */
export function developmentOf(project) {
  const departments = departmentOf(project, DEVELOPMENT_KIND)
  if (departments.length === 0) return { department: null, problem: null }
  if (departments.length > 1) {
    return {
      department: null,
      problem: 'отделов вида «' + DEVELOPMENT_KIND + '» больше одного — проект пропущен',
    }
  }
  return { department: departments[0], problem: null }
}

/**
 * Корни проекта: рабочая копия отдела и каталог человека. Сессия может стоять в
 * любом из них — оба принадлежат проекту. Корни берутся у отдела разработки: в
 * версии 1 они лежали в записи проекта, и мост Telegram искал по ним.
 */
export function projectRoots(project) {
  const found = developmentOf(project)
  const department = found.department || {}
  return [department.workspace, department.humanClone]
    .map((value) => String(value || ''))
    .filter(Boolean)
}

/**
 * Бот проекта: `{token, chatId}` или `undefined`. Признак бота — и токен, и id
 * чата: половина бота значит «бота нет» (форма `chatId: 0` из старого примера),
 * иначе диспетчер стучался бы на chat_id: 0 и писал в состояние ошибку Telegram.
 */
export function telegramOf(department) {
  if (!isObject(department)) return undefined
  const telegram = department.telegram
  if (!isObject(telegram) || !telegram.token || !telegram.chatId) return undefined
  return { token: String(telegram.token), chatId: telegram.chatId }
}

/**
 * Проект по рабочей области: сравнение нормализованным путём, корень проекта может
 * быть предком пути. Возвращает самую длинную подошедшую область — как мост
 * Telegram, — или `null`.
 *
 * Ищет по готовому списку проектов и их корням, а не по документу: мост Telegram
 * держит проекты в своей форме (`roots`), и второй такой поиск ему не нужен.
 */
export function findProjectByRoots(projects, rootsOf, workspace) {
  const wanted = normalizePath(workspace)
  if (!wanted) return null
  let best = null
  let bestLength = -1
  for (const project of projects || []) {
    for (const candidate of rootsOf(project) || []) {
      const root = normalizePath(candidate)
      if (!root) continue
      if (wanted === root || wanted.indexOf(root + '\\') === 0) {
        if (root.length > bestLength) {
          best = project
          bestLength = root.length
        }
      }
    }
  }
  return best
}

/** Порты по умолчанию: прежние значения диспетчера, если отдел их не задал. */
export const DEFAULT_FRONTEND_PORT = 8080
export const DEFAULT_API_PORT = 8001

/**
 * Маппинг проекта в прежнюю внутреннюю форму диспетчера: `repo`, `base`,
 * `workspace`, `humanClone`, `artifacts`, `composeProject`, `frontendPort`,
 * `apiPort`, `labels`, `areas`, `telegram`. Внутренняя форма намеренно не
 * меняется — её читают тысячи строк конвейера ниже `loadProjects()`.
 *
 * Расписание, лимиты и `enabled` сюда не входят: их разбирает диспетчер, потому
 * что «ЧЧ:ММ» → минуты и запасные значения из общего конфига — его дело.
 */
export function projectFields(project) {
  const department = developmentOf(project).department || {}
  const workspace = String(department.workspace || '')
  return {
    repo: String(department.repo || ''),
    base: typeof department.base === 'string' && department.base ? department.base : 'main',
    workspace,
    humanClone: typeof department.humanClone === 'string' ? department.humanClone : '',
    composeProject: typeof department.composeProject === 'string' && department.composeProject
      ? department.composeProject
      : String(project && project.id ? project.id : ''),
    frontendPort: Number.isInteger(department.frontendPort) ? department.frontendPort : DEFAULT_FRONTEND_PORT,
    apiPort: Number.isInteger(department.apiPort) ? department.apiPort : DEFAULT_API_PORT,
    artifacts: typeof department.artifacts === 'string' && department.artifacts
      ? department.artifacts
      : (workspace ? workspace.replace(/[\\/]+$/, '') + '-artifacts' : ''),
    telegram: telegramOf(department),
    labels: isObject(department.labels) ? department.labels : undefined,
    // Каталоги половин работы. Необязательны: по умолчанию работают AREA_PREFIXES.
    areas: isObject(department.areas) ? department.areas : undefined,
  }
}

/**
 * Склейка: документ из API поверх локального файла. Из локального берутся только
 * те ключи, которых API не отдал — у документа, у проекта (по совпадению `id`) и у
 * отдела (по совпадению `kind`). Удаляются только те ключи, которые API отдал сам.
 *
 * Исключение одно — блок `telegram`: API отдаёт `token` и `chatId`, а `projects`
 * (видимость бота) и `voiceLang` живут только в файле. Поэтому, когда бот есть с
 * обеих сторон, из файла добираются недостающие подполя, а присланные вебом
 * остаются как есть.
 *
 * Флаг работы отдела (`enabled`) локальным не бывает: `rebuild` отдаёт его всегда, и
 * старое значение из файла перекрывается документом API. В `localKeys` его нет — этот
 * список перечисляет ключи, которые из файла **сохраняются**, — и в `lost` он тоже не
 * попадает: `lost` — авария «ключу некуда лечь», непустой `lost` запрещает
 * переписывать кеш, а вытеснённый флаг переписывать не мешает и переписывания не
 * требует. Поэтому старое значение исчезает молча, без записи в статусе: человек, у
 * которого после выкатки включился выключенный проект, ищет флаг в вебе, а не в
 * `registrySync.lost`. Это и есть перенос признака из файла в базу: файл после
 * синхронизации держит только то, чего веб не знает.
 *
 * Возвращает `{document, localKeys, droppedProjects, lost}`:
 * `localKeys` — что сохранено и живёт только в файле (это печатается в статусе),
 * `droppedProjects` — проекты, которых в документе API нет вовсе: их ключи
 * сохранить некуда, и молчать об этом нельзя — человек ищет свой telegram,
 * `lost` — второй канал потери, названный поимённо: `[{id, keys, departments}]`,
 * где `keys` — локальные ключи, которым некуда лечь, а `departments` — виды
 * локальных отделов, которых в документе нет. Склейка по-прежнему не бросает
 * такие ключи в результат, но и не теряет их молча: `droppedProjects` — это
 * `lost[].id` проектов, отсутствующих в документе целиком.
 */
export function overlay(apiDocument, localDocument) {
  const document = clone(apiDocument)
  const localKeys = []
  const droppedProjects = []
  const lost = []
  if (!isObject(localDocument)) return { document, localKeys, droppedProjects, lost }

  for (const key of Object.keys(localDocument)) {
    if (key === 'version' || key === 'projects') continue
    if (hasKey(document, key)) continue
    document[key] = clone(localDocument[key])
    localKeys.push(key)
  }

  const locals = new Map()
  for (const project of projectsOf(localDocument)) {
    if (isObject(project) && nonEmptyString(project.id) && !locals.has(project.id)) {
      locals.set(project.id, project)
    }
  }

  const kept = new Set()
  for (const project of projectsOf(document)) {
    if (!isObject(project)) continue
    const local = locals.get(project.id)
    if (!local) continue
    kept.add(project.id)
    for (const key of Object.keys(local)) {
      if (key === 'id' || key === 'departments') continue
      if (hasKey(project, key)) continue
      project[key] = clone(local[key])
      localKeys.push(project.id + '.' + key)
    }
    const localDepartments = Array.isArray(local.departments) ? local.departments : []
    const departments = Array.isArray(project.departments) ? project.departments : []
    const matchedKinds = new Set()
    for (const department of departments) {
      const match = localDepartments.find((candidate) => isObject(candidate) && candidate.kind === department.kind)
      if (!match) continue
      matchedKinds.add(department.kind)
      for (const key of Object.keys(match)) {
        if (key === 'kind') continue
        // Бот — единственный блок, у которого часть полей приходит из веба
        // (`token`, `chatId`), а часть живёт только в файле: `projects` сужает
        // видимость бота, `voiceLang` задаёт язык голосовых. Присланный API блок
        // склеиваем по подполям, иначе `tg-bridge` терял бы и то и другое с
        // первой же синхронизации.
        if (key === 'telegram' && isObject(match.telegram) && isObject(department.telegram)) {
          for (const field of Object.keys(match.telegram)) {
            if (hasKey(department.telegram, field)) continue
            department.telegram[field] = clone(match.telegram[field])
            localKeys.push(project.id + '.departments[' + department.kind + '].telegram.' + field)
          }
          continue
        }
        if (hasKey(department, key)) continue
        department[key] = clone(match[key])
        localKeys.push(project.id + '.departments[' + department.kind + '].' + key)
      }
    }
    // Второй канал потери: отдел, который живёт в файле, а вида в документе нет.
    // Проект при этом совпал, поэтому `droppedProjects` его не называет — без
    // этой ветки отдел исчез бы молча вместе со своими ключами.
    const lostDepartments = []
    const lostKeys = []
    for (const candidate of localDepartments) {
      if (!isObject(candidate) || !nonEmptyString(candidate.kind)) continue
      if (matchedKinds.has(candidate.kind)) continue
      lostDepartments.push(candidate.kind)
      for (const key of Object.keys(candidate)) {
        if (key === 'kind') continue
        lostKeys.push(project.id + '.departments[' + candidate.kind + '].' + key)
      }
    }
    if (lostDepartments.length > 0) lost.push({ id: project.id, keys: lostKeys, departments: lostDepartments })
  }
  for (const [id, local] of locals) {
    if (kept.has(id)) continue
    droppedProjects.push(id)
    lost.push(lostProject(id, local))
  }
  return { document, localKeys, droppedProjects, lost }
}

/**
 * Что именно пропадёт, если проекта нет в документе API: его собственные ключи и
 * ключи его отделов. Без этого перечня человек видит только имя проекта и идёт
 * искать глазами, какие поля он потерял.
 */
function lostProject(id, local) {
  const keys = []
  const departments = []
  for (const key of Object.keys(local)) {
    if (key === 'id' || key === 'departments') continue
    keys.push(id + '.' + key)
  }
  const localDepartments = Array.isArray(local.departments) ? local.departments : []
  for (const department of localDepartments) {
    if (!isObject(department) || !nonEmptyString(department.kind)) continue
    departments.push(department.kind)
    for (const key of Object.keys(department)) {
      if (key === 'kind') continue
      keys.push(id + '.departments[' + department.kind + '].' + key)
    }
  }
  return { id, keys, departments }
}

/**
 * Запись кеша. Файл пишется только когда содержимое изменилось: лишняя запись
 * раз в тик дёргала бы наблюдателей файла и плодила бы одинаковые отметки времени.
 * Запись атомарная (временный файл рядом и `rename`), чтобы читатель — мост
 * Telegram в соседнем процессе — не увидел половину документа.
 *
 * Предыдущая версия остаётся в `projects.json.bak`: если документ из веба
 * окажется не тем, откат — это `copy projects.json.bak projects.json`, а не
 * восстановление руками из памяти.
 */
export function writeRegistryFile(file, document) {
  const next = JSON.stringify(document, null, 2) + '\n'
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch (error) {
    current = null
  }
  if (current === next) return { changed: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (current !== null) fs.writeFileSync(file + '.bak', current)
  const temporary = file + '.tmp-' + process.pid
  fs.writeFileSync(temporary, next)
  fs.renameSync(temporary, file)
  return { changed: true }
}

/**
 * Перевод документа версии 1 в версию 2. Правило одно: запись проекта версии 1
 * становится проектом с ровно одним отделом `development`, а поля отдела
 * переносятся в этот отдел как есть — их имена не меняются, поэтому
 * `projectRow`, `tg-bridge` и `sync` переезжают без правки смысла.
 *
 * `department` версии 1 (`enabled`, `windows`, `maxRework`, …) разворачивается в
 * поля отдела: вложенности `department` в версии 2 нет. Документ версии 2
 * возвращается как есть с `alreadyV2: true` — конвертер идемпотентен.
 */
export function convertLegacyDocument(raw) {
  const problems = []
  if (!isObject(raw)) return { document: null, problems: ['в файле не объект'], alreadyV2: false }
  if (raw.version === REGISTRY_VERSION) return { document: clone(raw), problems, alreadyV2: true }

  const source = isObject(raw.projects) ? raw.projects : null
  if (source === null) {
    return { document: null, problems: ['в файле нет объекта "projects" — это не реестр версии 1'], alreadyV2: false }
  }

  const ids = Object.keys(source)
  if (ids.length === 0) problems.push('в "projects" нет ни одного проекта')

  const projects = ids.map((id) => {
    const row = isObject(source[id]) ? source[id] : {}
    const legacy = isObject(row.department) ? row.department : {}
    const department = { kind: DEVELOPMENT_KIND, title: nonEmptyString(row.title) ? row.title : id }
    // Порядок полей — тот же, что в примере `config/projects.example.json`: id,
    // название, затем отдел. Так файл читается глазами после конвертации.
    for (const key of ['repo', 'base', 'workspace', 'humanClone', 'artifacts', 'composeProject', 'frontendPort', 'apiPort', 'areas', 'labels', 'telegram']) {
      if (row[key] !== undefined) department[key] = clone(row[key])
    }
    for (const key of ['enabled', 'windows', 'maxRework', 'maxAttempts', 'stuckAfterMinutes']) {
      if (legacy[key] !== undefined) department[key] = clone(legacy[key])
    }
    for (const key of Object.keys(legacy)) {
      if (['enabled', 'windows', 'maxRework', 'maxAttempts', 'stuckAfterMinutes'].indexOf(key) !== -1) continue
      problems.push('проект «' + id + '»: поле department.' + key + ' в версии 2 неизвестно — не перенесено')
    }
    for (const key of Object.keys(row)) {
      if (['title', 'repo', 'base', 'workspace', 'humanClone', 'artifacts', 'composeProject', 'frontendPort', 'apiPort', 'areas', 'labels', 'telegram', 'department'].indexOf(key) !== -1) continue
      problems.push('проект «' + id + '»: поле ' + key + ' в версии 2 неизвестно — не перенесено')
    }
    return { id, title: nonEmptyString(row.title) ? row.title : id, departments: [department] }
  })

  const document = { version: REGISTRY_VERSION, projects }
  if (nonEmptyString(raw.default)) document.default = raw.default.trim()
  for (const key of Object.keys(raw)) {
    if (['version', 'default', 'projects'].indexOf(key) !== -1) continue
    problems.push('поле ' + key + ' в версии 2 неизвестно — не перенесено')
  }
  return { document, problems, alreadyV2: false }
}
