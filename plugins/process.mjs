// Процесс отдела как данные: умолчания, проверка документа, имена меток и матчер ступеней.
//
// Модуль вынесен из `dev-department.mjs` по двум причинам. Первая — тест: матчер и
// проверку документа можно проверять чистыми функциями, без фейкового ctx, таймеров и
// GitHub. Вторая — источник правды: таблица ступеней и имена меток живут в одном месте,
// а диспетчер только исполняет то, что вернул матчер.
//
// Документ процесса: `{version, tags, steps}`. Тег: `{key, name, title, agent}`. Ступень:
// `{id, title, kind, role, when, unless, put, drop, guard, priority, enabled}`. Тег в
// ступени — **ключ** из `PROCESS_LABEL_KEYS`, имя тега на GitHub — `tag.name`, подпись для
// глаза — `tag.title`, агент ступени — `tag.agent`. Поэтому переименование тега в вебе не
// меняет таблицу ступеней.
//
// Версия 2 пришла на смену `labels`: диспетчер обязан читать и версию 1 (стенды с
// сохранённым старым процессом), но внутренняя форма у обеих одна — `tags`. Версия 1
// переводится так: имя из `labels`, подпись — ключ, агент — `null`.
//
// Копия таблицы умолчаний есть и в Python (`app/backend/app/process_defaults.py`):
// `api` собирается из `app/backend`, диспетчер — из `plugins`, и файл репозитория не
// читает ни один из них. Расхождение копий сегодня сверяется глазами при каждой правке
// таблицы: `process.source` показывает только источник (`web`/`default`), а тела ступеней
// из двух языков ни один тест не сравнивает.

import crypto from 'node:crypto'

/** Версия формата, которую пишет веб. Диспетчер читает ещё и версию 1. */
export const PROCESS_VERSION = 2

/** Версия 1 с `labels`: только для чтения стендов, веб её больше не сохраняет. */
export const LEGACY_PROCESS_VERSION = 1

/** Код диспетчера: тег, отданный ему, владельцем ступени не считается. */
export const DISPATCHER_AGENT_CODE = 'dsh'

/** Ключи меток: порядок фиксирован и совпадает с порядком блока имён на экране. */
export const PROCESS_LABEL_KEYS = [
  'mockup',
  'mockupsReady',
  'progress',
  'dev',
  'frontend',
  'phaseFrontend',
  'review',
  'test',
  'ok',
  'failed',
  'merged',
  'areaBackend',
  'areaFrontend',
  'areaFullstack',
]

/**
 * Имена меток по умолчанию — те же, что у зашитого конвейера. Это последний источник:
 * сохранённый в вебе документ отдела и локальный `labels` файла `projects.json` стоят выше.
 */
export const DEFAULT_PROCESS_LABELS = {
  mockup: 'needs-mockup',
  mockupsReady: 'mockups-ready',
  progress: 'in-progress',
  dev: 'ready-for-dev',
  frontend: 'ready-for-frontend',
  phaseFrontend: 'phase:frontend',
  review: 'for-code-review',
  test: 'ready-for-test',
  ok: 'tested',
  failed: 'test-failed',
  merged: 'merged',
  areaBackend: 'area:backend',
  areaFrontend: 'area:frontend',
  areaFullstack: 'area:fullstack',
}

/**
 * Подписи тегов для глаза: приходят из документа процесса, а не из констант фронта.
 * Здесь — последний источник для стенда без сохранённого процесса.
 */
export const DEFAULT_PROCESS_LABEL_TITLES = {
  dev: 'К разработке',
  frontend: 'Фронтенд',
  areaBackend: 'Половина: бэкенд',
  areaFrontend: 'Половина: фронтенд',
  areaFullstack: 'Половина: полный стек',
  phaseFrontend: 'Фаза фронтенда',
  mockup: 'Нужен макет',
  mockupsReady: 'Макет готов',
  progress: 'В работе',
  review: 'На код-ревью',
  test: 'На тестирование',
  ok: 'Проверено',
  failed: 'Тест не прошёл',
  merged: 'Слито',
}

/** Предел подписи тега: тот же, что у проверки веба. */
export const TAG_TITLE_MAX_LENGTH = 100

/**
 * Каталог стражей: id и заголовок. Страж — код, а не данные: документ выбирает страж по
 * id, написать новый в редакторе нельзя. Порядок совпадает с таблицей «Стражи» в
 * `plugins/docs/DEPARTMENT-PROCESS.md`.
 */
export const GUARD_CATALOG = [
  { id: 'route', title: 'Маршрут' },
  { id: 'mockup-stage', title: 'Макет' },
  { id: 'dispatch', title: 'Выдача' },
  { id: 'no-code', title: 'Есть что ревьюить' },
  { id: 'same-head', title: 'Та же ревизия' },
  { id: 'checklist-gate', title: 'Чеклист прошлого круга' },
  { id: 'merged-already', title: 'PR уже слит' },
]

/** Id стражей: по ним проверяется `guard` ступени. */
export const GUARD_IDS = GUARD_CATALOG.map((guard) => guard.id)

/** Вид ступени: что она делает, когда её условия выполнены. */
export const STEP_KINDS = ['session', 'route', 'auto']

/** Резолверы роли: половину работы и владельца замечаний решает код, а не документ. */
export const ROLE_BY_AREA = 'by-area'
export const ROLE_BY_FINDINGS = 'by-findings'
export const ROLE_RESOLVERS = [ROLE_BY_AREA, ROLE_BY_FINDINGS]

/**
 * Метки «работа уже начата». Ступень, у которой такая метка в `when`, — ступень
 * продолжения: она берёт тикет, по которому работа идёт, а не свежий из очереди.
 * По этому признаку статус отличает активный тикет от ожидающего.
 */
export const ACTIVE_LABEL_KEYS = ['progress', 'review', 'test', 'ok', 'failed', 'frontend']

/**
 * Метки, при которых ступень макета не берётся: по тикету уже шла работа.
 *
 * Это содержимое стража `mockup-stage` — прежний фильтр `mockupStage()` отсекал
 * `progress|review|test|ok|merged|failed` и снятые с конвейера тикеты (снятие приходит в
 * план отдельным полем `dropped`). Без этой проверки ступень приоритета 1 забирала бы
 * тикет, который прямо сейчас стоит в ревью или в тесте, и макет перебивал бы живую работу.
 */
export const MOCKUP_STAGE_BLOCKED_KEYS = ['progress', 'review', 'test', 'ok', 'failed', 'merged']

/** Приоритет ступени: целое от 1 до 999, как в проверке веба. */
export const PRIORITY_MIN = 1
export const PRIORITY_MAX = 999

/** Порядок строк таблицы: первая ступень — самая ранняя. Шаг 60 оставляет место между. */
const PRIORITY_STEP = 60

/**
 * Одна ступень умолчаний: все ключи контракта, пустые — пустыми массивами.
 * @param {number} priority
 * @param {string} id
 * @param {string} title
 * @param {string[]} when
 * @param {object} [extra]
 * @returns {object}
 */
function step(priority, id, title, when, extra = {}) {
  return {
    id,
    title,
    kind: extra.kind || 'session',
    role: extra.role || null,
    when: [...when],
    unless: [...(extra.unless || [])],
    put: [...(extra.put || [])],
    drop: [...(extra.drop || [])],
    guard: extra.guard || null,
    priority,
    enabled: true,
  }
}

/**
 * Таблица ступеней по умолчанию — сегодняшний конвейер строка в строку: порядок строк
 * таблицы §4.5 `plugins/docs/DEPARTMENT-PROCESS.md` и есть порядок `priority`.
 *
 * Порядок ветвлений тот же, что был зашит в `dispatch()`: макет → маршрут → передача
 * фронтенду → ревью → тест → слияние → доработка → выдача → продолжение. Единственное
 * отличие от старого кода — ступень макета стоит первой: постановка первична, и тикет,
 * ждущий макет, не должен ждать, пока освободится чужая ступень.
 */
export const DEFAULT_PROCESS_STEPS = [
  step(1, 'mockup', 'Макет постановки', ['mockup'], {
    role: 'design',
    unless: ['mockupsReady'],
    put: ['progress'],
    guard: 'mockup-stage',
  }),
  step(61, 'route', 'Маршрут по постановке', ['dev'], {
    kind: 'route',
    unless: [
      'progress',
      'review',
      'test',
      'ok',
      'failed',
      'areaBackend',
      'areaFrontend',
      'areaFullstack',
    ],
    guard: 'route',
  }),
  step(121, 'handoff-frontend', 'Передача фронтенду', ['test', 'areaFullstack'], {
    kind: 'auto',
    unless: ['phaseFrontend'],
    put: ['frontend'],
    drop: ['test'],
  }),
  step(181, 'review', 'Код-ревью', ['review'], { role: 'code-review', guard: 'no-code' }),
  step(241, 'test', 'Тестирование', ['test'], { role: 'tester' }),
  step(301, 'merge', 'Слияние', ['ok'], { role: 'devops-delivery', guard: 'merged-already' }),
  step(361, 'rework-test', 'Доработка после тестировщика', ['failed'], {
    role: ROLE_BY_FINDINGS,
    put: ['progress'],
    drop: ['failed'],
    guard: 'dispatch',
  }),
  step(421, 'dev-backend', 'Бэкенд', ['dev', 'areaBackend'], {
    role: 'dev-backend',
    unless: ['progress', 'review', 'test', 'ok', 'failed'],
    put: ['progress'],
    drop: ['dev'],
    guard: 'dispatch',
  }),
  step(481, 'dev-frontend', 'Фронтенд', ['dev', 'areaFrontend'], {
    role: 'dev-frontend',
    unless: ['progress', 'review', 'test', 'ok', 'failed'],
    put: ['progress'],
    drop: ['dev'],
    guard: 'dispatch',
  }),
  step(541, 'dev-fullstack-backend', 'Полный стек: бэкенд', ['dev', 'areaFullstack'], {
    role: 'dev-backend',
    unless: ['progress', 'review', 'test', 'ok', 'failed'],
    put: ['progress'],
    drop: ['dev'],
    guard: 'dispatch',
  }),
  step(601, 'dev-fullstack-frontend', 'Полный стек: фронтенд', ['frontend'], {
    role: 'dev-frontend',
    unless: ['progress', 'review', 'test', 'ok', 'failed'],
    put: ['progress', 'phaseFrontend'],
    drop: ['frontend'],
    guard: 'dispatch',
  }),
  step(661, 'dev-fullstack-default', 'Полный стек без маршрута', ['dev'], {
    role: 'dev-fullstack',
    unless: ['progress', 'review', 'test', 'ok', 'failed'],
    put: ['progress'],
    drop: ['dev'],
    guard: 'dispatch',
  }),
  step(721, 'continue', 'Продолжение взятой работы', ['progress'], {
    role: ROLE_BY_AREA,
    guard: 'dispatch',
  }),
]

/** Документ процесса по умолчанию: новый объект на каждый вызов. */
export function defaultProcess() {
  return {
    version: PROCESS_VERSION,
    tags: PROCESS_LABEL_KEYS.map((key) => ({
      key,
      name: DEFAULT_PROCESS_LABELS[key],
      title: DEFAULT_PROCESS_LABEL_TITLES[key],
      agent: null,
    })),
    steps: DEFAULT_PROCESS_STEPS.map((row) => ({
      ...row,
      when: [...row.when],
      unless: [...row.unless],
      put: [...row.put],
      drop: [...row.drop],
    })),
  }
}

/** Объект, а не массив и не `null`: так же читает отдел `plugins/registry.mjs`. */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Строка с непустым значением после обрезки пробелов. */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Уникальные значения в порядке появления: повторы одного ключа в списке не нужны. */
function unique(list) {
  const seen = new Set()
  const result = []
  for (const value of list) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * Привести список ключей меток ступени к каноническому виду.
 *
 * Возвращает `{keys, problem}`: `problem` — текст отказа, если в списке есть ключ вне
 * каталога. Вид поля (массив или нет) проверяется до вызова.
 */
function labelKeys(raw, stepId, field, problems) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    problems.push(`Ступень «${stepId}»: поле ${field} — не массив ключей меток`)
    return []
  }
  const keys = []
  for (const value of raw) {
    if (typeof value !== 'string' || !PROCESS_LABEL_KEYS.includes(value)) {
      problems.push(`Неизвестный ключ метки в ступени «${stepId}»: «${value}»`)
      continue
    }
    keys.push(value)
  }
  return unique(keys)
}

/** Приоритет: целое от 1 до 999. `true` числом не считается. */
function priorityOf(raw, stepId, problems) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    problems.push(`Ступень «${stepId}»: приоритет — целое от 1 до 999`)
    return null
  }
  if (raw < PRIORITY_MIN || raw > PRIORITY_MAX) {
    problems.push(`Ступень «${stepId}»: приоритет — целое от 1 до 999`)
    return null
  }
  return raw
}

/**
 * Теги документа в одной внутренней форме — для обеих версий.
 *
 * Версия 2: `tags` массивом, каждый `{key, name, title, agent}`. Версия 1: `labels`
 * объектом, тег из него получает `title = key` и `agent = null`. Возвращает `null`,
 * если набор неполный или чужой: подставлять умолчания вместо опечатки значит молча
 * работать по другим тегам, чем человек сохранил.
 */
function tagsOfDocument(value, problems) {
  if (value.version === LEGACY_PROCESS_VERSION) {
    if (!isObject(value.labels)) {
      problems.push('Нужен объект процесса с полями version, labels, steps')
      return null
    }
    for (const key of Object.keys(value.labels)) {
      if (!PROCESS_LABEL_KEYS.includes(key)) {
        problems.push(`Неизвестный ключ тега: «${key}»`)
      }
    }
    const tags = []
    for (const key of PROCESS_LABEL_KEYS) {
      const name = value.labels[key]
      if (!isText(name)) {
        problems.push(`Имя тега пустое: «${key}»`)
        continue
      }
      tags.push({ key, name: name.trim(), title: key, agent: null })
    }
    return tags.length === PROCESS_LABEL_KEYS.length ? tags : null
  }

  if (!Array.isArray(value.tags)) {
    problems.push('Нужен объект процесса с полями version, tags, steps')
    return null
  }
  const byKey = new Map()
  for (const entry of value.tags) {
    if (!isObject(entry) || !isText(entry.key)) {
      problems.push('Нужен объект процесса с полями version, tags, steps')
      continue
    }
    const key = entry.key.trim()
    if (!PROCESS_LABEL_KEYS.includes(key)) {
      problems.push(`Неизвестный ключ тега: «${key}»`)
      continue
    }
    if (byKey.has(key)) {
      problems.push(`Ключ тега повторяется: «${key}»`)
      continue
    }
    byKey.set(key, entry)
  }

  const tags = []
  const names = new Set()
  for (const key of PROCESS_LABEL_KEYS) {
    const entry = byKey.get(key)
    if (!entry) {
      problems.push(`Имя тега пустое: «${key}»`)
      continue
    }
    const name = entry.name
    if (!isText(name)) {
      problems.push(`Имя тега пустое: «${key}»`)
      continue
    }
    const title = entry.title
    if (!isText(title)) {
      problems.push(`Подпись тега пустая: «${key}»`)
      continue
    }
    if (title.trim().length > TAG_TITLE_MAX_LENGTH) {
      problems.push(`Подпись тега длиннее 100 символов: «${key}»`)
      continue
    }
    const agent = entry.agent === undefined ? null : entry.agent
    if (agent !== null && !isText(agent)) {
      problems.push(`Агент тега «${key}» задан не кодом`)
      continue
    }
    const trimmed = name.trim()
    if (names.has(trimmed)) {
      problems.push(`Имена тегов повторяются: «${trimmed}»`)
      continue
    }
    names.add(trimmed)
    tags.push({ key, name: trimmed, title: title.trim(), agent: agent === null ? null : agent.trim() })
  }
  return tags.length === PROCESS_LABEL_KEYS.length ? tags : null
}

/**
 * Проверить документ процесса и вернуть его каноническим в версии 2.
 *
 * Принимаются обе версии: стенды с сохранённым процессом версии 1 обязаны продолжать
 * работать после выкатки. Версия 1 переводится в `tags` (`name` из `labels`,
 * `title = key`, `agent = null`) — веб пишет только версию 2.
 *
 * `options.roles` — коды ролей, которые хост умеет поднимать (`role-permissions.mjs`), плюс
 * резолверы. Роль, которой нет ни среди пресетов, ни среди резолверов, — валидна на вебе
 * (там справочник ролей свой) и невалидна здесь: ступень с ней не поднимет сессию, и
 * молча пропустить такую ступень нельзя. Поэтому это `problems`, а не тихая замена.
 * Каталог необязателен: без него связи «роль → пресет» проверить нечем, и проверка роли не
 * выполняется — так вызывают чистые тесты документа.
 *
 * Живость агентов здесь не проверяется: справочник приезжает отдельным ключом реестра
 * (`agents`), а процесс лишь называет код. Неизвестный код считается тегом без агента —
 * ступень остаётся за диспетчером, а не ждёт несуществующего гостя молча.
 *
 * @param {unknown} value документ из веба
 * @param {{roles?: string[]}} [options]
 * @returns {{document: object|null, problems: string[]}}
 */
export function validateProcess(value, options = {}) {
  const problems = []
  if (!isObject(value)) {
    return { document: null, problems: ['Нужен объект процесса с полями version, tags, steps'] }
  }
  if (value.version !== PROCESS_VERSION && value.version !== LEGACY_PROCESS_VERSION) {
    return { document: null, problems: ['Поддерживается только версия процесса 2'] }
  }
  if (!Array.isArray(value.steps)) {
    return { document: null, problems: ['Нужен объект процесса с полями version, tags, steps'] }
  }
  const tags = tagsOfDocument(value, problems)
  if (tags === null || problems.length > 0) {
    return { document: null, problems }
  }
  // Без каталога ролей проверять нечем: `null` здесь значит «каталог не передан».
  const roles = options.roles ? new Set([...options.roles, ...ROLE_RESOLVERS]) : null
  const seen = new Set()
  const steps = []
  for (const raw of value.steps) {
    if (!isObject(raw) || !isText(raw.id)) {
      problems.push('Нужен объект процесса с полями version, tags, steps')
      continue
    }
    const id = raw.id.trim()
    const when = labelKeys(raw.when, id, 'when', problems)
    if (when.length === 0) {
      problems.push(`У ступени «${id}» нет входящих тегов`)
      continue
    }
    if (seen.has(id)) {
      problems.push(`Дублируется id ступени: «${id}»`)
      continue
    }
    seen.add(id)
    const unless = labelKeys(raw.unless, id, 'unless', problems)
    const put = labelKeys(raw.put, id, 'put', problems)
    const drop = labelKeys(raw.drop, id, 'drop', problems)
    const kind = raw.kind === undefined || raw.kind === null ? 'session' : raw.kind
    if (!STEP_KINDS.includes(kind)) {
      problems.push(`Неизвестный вид ступени у «${id}»: «${kind}»`)
      continue
    }
    const role = raw.role === undefined ? null : raw.role
    if (role !== null) {
      if (typeof role !== 'string' || (roles !== null && !roles.has(role))) {
        problems.push(`Неизвестная роль у ступени «${id}»: «${role}»`)
        continue
      }
    }
    const guard = raw.guard === undefined ? null : raw.guard
    if (guard !== null) {
      if (typeof guard !== 'string' || !GUARD_IDS.includes(guard)) {
        problems.push(`Неизвестный страж у ступени «${id}»: «${guard}»`)
        continue
      }
    }
    const priority = priorityOf(raw.priority, id, problems)
    if (priority === null) continue
    if (kind === 'route' && guard !== 'route') {
      problems.push(`Ступень «${id}»: у маршрутной ступени должен быть страж route`)
      continue
    }
    const title = isText(raw.title) ? raw.title.trim() : id
    steps.push({
      id,
      title,
      kind,
      role,
      when,
      unless,
      put,
      drop,
      guard,
      priority,
      enabled: raw.enabled !== false,
    })
  }
  if (problems.length > 0) {
    return { document: null, problems }
  }
  return { document: { version: PROCESS_VERSION, tags, steps }, problems: [] }
}

/**
 * Короткий отпечаток документа: 12 шестнадцатеричных символов.
 *
 * Нужен статусу и человеку: по нему видно, что диспетчер привёз **другой** документ, не
 * разбирая таблицу глазами. Считается по канону (ключи в порядке контракта, ступени в
 * порядке документа), поэтому перестановка ключей в JSON отпечаток не меняет.
 */
export function digestOf(document) {
  const tags = new Map((document.tags || []).map((tag) => [tag.key, tag]))
  const canonical = {
    version: document.version,
    tags: PROCESS_LABEL_KEYS.map((key) => {
      const tag = tags.get(key) || { name: '', title: '', agent: null }
      return [key, tag.name, tag.title, tag.agent === undefined ? null : tag.agent]
    }),
    steps: document.steps.map((row) => [
      row.id,
      row.title,
      row.kind,
      row.role,
      row.when,
      row.unless,
      row.put,
      row.drop,
      row.guard,
      row.priority,
      row.enabled !== false,
    ]),
  }
  return crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
}

/**
 * Разрешить процесс отдела: документ из реестра, иначе умолчания.
 *
 * `source: 'web'` — документ сохранён в вебе и проверку прошёл; `source: 'default'` —
 * своего процесса у отдела нет, работает таблица по умолчанию. Невалидный документ
 * процессом не становится: отдел работает на умолчаниях, а причина остаётся в `problems`
 * и в статусе отдела — молча остановить смену из-за опечатки в вебе нельзя.
 *
 * @param {unknown} raw отдел `process` из документа реестра
 * @param {{roles?: string[]}} [options]
 * @returns {{document: object, source: 'web'|'default', problems: string[], digest: string}}
 */
export function processOf(raw, options = {}) {
  if (raw === undefined || raw === null) {
    const document = defaultProcess()
    return { document, source: 'default', problems: [], digest: digestOf(document) }
  }
  const checked = validateProcess(raw, options)
  if (checked.document) {
    return {
      document: checked.document,
      source: 'web',
      problems: [],
      digest: digestOf(checked.document),
    }
  }
  const document = defaultProcess()
  return {
    document,
    source: 'default',
    problems: checked.problems,
    digest: digestOf(document),
  }
}

/**
 * Теги проекта: документ (сохранённый в вебе) → локальные `labels` файла → умолчания.
 *
 * Возвращает `{labels, agents}`: `labels` — имена тегов на GitHub, `agents` — код агента
 * на ключ (`null` — «ступень берёт диспетчер»). Локальный `labels` из `projects.json`
 * остаётся переопределением **имени**: агент приходит только из документа.
 *
 * Порядок из постановки. Тонкость одна: у отдела **без** сохранённого процесса
 * `document.tags` — это и есть умолчания, и если поставить их выше файла, локальные
 * переименования из `projects.json` перестали бы работать. Поэтому имена веба идут первыми
 * только при `source === 'web'`; при `source === 'default'` первым идёт файл, как было до
 * этой задачи.
 *
 * @param {{document: object, source: string}} process
 * @param {object|null|undefined} localLabels `labels` отдела из `projects.json`
 * @returns {{labels: Record<string, string>, agents: Record<string, string|null>}}
 */
export function tagsOfProcess(process, localLabels) {
  const fromFile = isObject(localLabels) ? localLabels : {}
  const labels = { ...DEFAULT_PROCESS_LABELS }
  const agents = {}
  for (const key of PROCESS_LABEL_KEYS) agents[key] = null
  for (const key of PROCESS_LABEL_KEYS) {
    const name = fromFile[key]
    if (isText(name)) labels[key] = name.trim()
  }
  const fromWeb = process.source === 'web' ? process.document.tags || [] : []
  for (const tag of fromWeb) {
    if (isText(tag.name)) labels[tag.key] = tag.name.trim()
    agents[tag.key] = typeof tag.agent === 'string' && tag.agent.trim() !== '' ? tag.agent.trim() : null
  }
  return { labels, agents }
}

/**
 * Владельцы входящих тегов ступени: коды **включённых** агентов, которым отдан хоть один
 * тег из `keys`. Тег без агента, тег `dsh` и тег выключенного агента владельцем не
 * считаются — ступень остаётся за диспетчером.
 *
 * Это единственное правило владения: им пользуются выбор ступени (`decisionOf`/`planFor`)
 * и карточка статуса. Теги в `put`/`drop` владение не задают — это передача тикета.
 *
 * @param {string[]} keys ключи тегов (обычно `step.when`)
 * @param {Record<string, string|null>|undefined} tagAgents код агента на ключ
 * @param {Array<{code: string, enabled?: boolean}>|undefined} liveAgents живые агенты
 * @returns {string[]} коды владельцев в порядке появления ключей
 */
export function tagOwnersOf(keys, tagAgents, liveAgents) {
  if (!isObject(tagAgents)) return []
  const live = new Map((liveAgents || []).map((agent) => [agent.code, agent]))
  const owners = []
  for (const key of keys || []) {
    const code = tagAgents[key]
    if (!code || code === DISPATCHER_AGENT_CODE) continue
    const agent = live.get(code)
    if (!agent || agent.enabled === false) continue
    if (!owners.includes(code)) owners.push(code)
  }
  return owners
}

/** Владелец ступени: первый включённый агент её входящих тегов или `null`. */
export function stepOwnerOf(step, tagAgents, liveAgents) {
  const owners = tagOwnersOf(step.when, tagAgents, liveAgents)
  return owners.length > 0 ? owners[0] : null
}

/**
 * Ступени, отданные агентам: `[{id, title, agent}]` по возрастанию приоритета.
 * Нужны карточке статуса, чтобы назвать «ступени разобраны агентами», когда план пуст.
 */
export function delegatedStepsOf(document, tagAgents, liveAgents) {
  return sortedSteps(document)
    .filter((step) => step.enabled !== false)
    .map((step) => ({ id: step.id, title: step.title, agent: stepOwnerOf(step, tagAgents, liveAgents) }))
    .filter((entry) => entry.agent !== null)
}

/** Ступени включённого процесса по возрастанию приоритета; выключенные — в конце. */
export function sortedSteps(document) {
  return document.steps
    .map((row, index) => ({ row, index }))
    .sort((left, right) => left.row.priority - right.row.priority || left.index - right.index)
    .map((entry) => entry.row)
}

/** Все `when` стоят и ни одна `unless` не стоит. */
export function stepMatches(step, labels) {
  const present = labels instanceof Set ? labels : new Set(labels || [])
  for (const key of step.when) {
    if (!present.has(key)) return false
  }
  for (const key of step.unless) {
    if (present.has(key)) return false
  }
  return true
}

/** Ступень продолжения: работа по тикету уже начата. */
export function isActiveStep(step) {
  return step.when.some((key) => ACTIVE_LABEL_KEYS.includes(key))
}

/**
 * Страж ступени как предикат по меткам: `true` — ступень для этого тикета не работает.
 *
 * Здесь только те стражи, которым не нужен ни GitHub, ни состояние диспетчера. Остальные
 * (`route`, `dispatch`, `no-code`, `same-head`, `checklist-gate`, `merged-already`)
 * исполняет `dispatch()`: без запроса к PR или без счётчиков попыток их не решить, и
 * matcher о них знать не обязан.
 *
 * @param {object} step ступень документа
 * @param {string[]|Set<string>} labels ключи стоящих меток
 */
export function guardBlocks(step, labels) {
  if (step.guard !== 'mockup-stage') return false
  const present = labels instanceof Set ? labels : new Set(labels || [])
  return MOCKUP_STAGE_BLOCKED_KEYS.some((key) => present.has(key))
}

/**
 * Роль половины по стоящим ключам меток — порядок прежних `findActive()`/`implementer()`.
 *
 * Передача фронтенду (`frontend`) решает раньше маршрута `area:*`: к этому моменту
 * бэкенд-часть полного стека уже сделана, и сессия должна подняться у фронтендера.
 * Обратный порядок отправлял доработку второй половины бэкендеру по `area:fullstack`, и
 * правка уезжала не тому исполнителю.
 */
export function areaRoleOfKeys(keys) {
  const present = keys instanceof Set ? keys : new Set(keys || [])
  if (present.has('frontend')) return 'dev-frontend'
  if (present.has('areaFullstack')) return present.has('phaseFrontend') ? 'dev-frontend' : 'dev-backend'
  if (present.has('areaFrontend')) return 'dev-frontend'
  if (present.has('areaBackend')) return 'dev-backend'
  return 'dev-fullstack'
}

/**
 * То же по именам меток GitHub: `names` — метки тикета, `labels` — имена ключей проекта.
 * Ступень продолжения держит резолвер `by-area`, и диспетчер спрашивает его этой функцией.
 *
 * @param {string[]|Set<string>} names
 * @param {Record<string, string>} labels
 */
export function areaRoleOfLabels(names, labels) {
  const standing = names instanceof Set ? names : new Set(names || [])
  const keys = PROCESS_LABEL_KEYS.filter((key) => {
    const name = labels ? labels[key] : null
    return Boolean(name) && standing.has(name)
  })
  return areaRoleOfKeys(keys)
}

/**
 * Ступень входа: тикет ждёт сессии, но работа по нему ещё не начата.
 *
 * Это признак «ступень поднимает сессию по свежему тикету», и по нему диспетчер
 * гасит ступень закрытым окном смены (`dispatch()` в `dev-department.mjs`). Ступень
 * макета — тоже вход: дизайнер берёт `needs-mockup`-тикет без `ready-for-dev`, то
 * есть свежий тикет, и вне окна его брать не должен так же, как выдачу разработчику.
 * Очередь разработки — отдельное понятие (`queueOfPlan`), и признак `dev` живёт там.
 */
export function isEntryStep(step) {
  return step.kind === 'session' && !isActiveStep(step)
}

/**
 * План по ступеням: для каждого тикета — первая подходящая ступень по приоритету.
 *
 * `items` — `[{item, labels, dropped}]`: `item` возвращается как есть (вызывающему нужен
 * его номер), `labels` — ключи стоящих меток, `dropped` — тикет снят с конвейера и в план
 * не попадает. Возвращает массив `{step, item}` по возрастанию приоритета ступени; внутри
 * одной ступени порядок — порядок `items`, потому что `Array.prototype.sort` устойчив.
 *
 * `options.kinds` — ограничить набор видов (например, вне окна смены исполняется только
 * маршрутная ступень: сессию поднимать некуда).
 *
 * Страж, который решается по одним меткам, `planOfProcess` исполняет сам (`guardBlocks`):
 * ступень макета не попадает в план по начатому тикету. Это же делает и карточка статуса —
 * она считает план тем же вызовом, а не вторым правилом.
 *
 * @param {object} document
 * @param {Array<{item: any, labels: string[]|Set<string>, dropped?: boolean}>} items
 * @param {{kinds?: string[]}} [options]
 * @returns {Array<{step: object, item: any}>}
 */
export function planOfProcess(document, items, options = {}) {
  const kinds = options.kinds ? new Set(options.kinds) : null
  // `skip` — отказ вызывающего: ступень не берётся для этого тикета. Так диспетчер
  // пропускает маршрутную ступень, когда маршрут по постановке не выводится: иначе
  // она стояла бы первой и держала тикет впереди выдачи.
  const skip = typeof options.skip === 'function' ? options.skip : null
  const steps = sortedSteps(document).filter(
    (row) => row.enabled !== false && (!kinds || kinds.has(row.kind)),
  )
  const plan = []
  for (const entry of items) {
    if (entry.dropped) continue
    const labels = entry.labels instanceof Set ? entry.labels : new Set(entry.labels || [])
    for (const row of steps) {
      if (guardBlocks(row, labels)) continue
      if (skip && skip(row, entry.item)) continue
      if (!stepMatches(row, labels)) continue
      plan.push({ step: row, item: entry.item })
      break
    }
  }
  return plan.sort((left, right) => left.step.priority - right.step.priority)
}

/**
 * Единственное решение: ступень с наименьшим приоритетом и первый подходящий тикет.
 * `null` — делать нечего.
 */
export function nextOfPlan(plan) {
  return plan.length > 0 ? plan[0] : null
}

/** Первая ступень продолжения из плана: активный тикет для карточки статуса. */
export function activeOfPlan(plan) {
  return plan.find((entry) => isActiveStep(entry.step)) || null
}

/** Входные метки очереди разработки: ступень с ними отвечает на `ready-for-dev`. */
const QUEUE_LABEL_KEYS = ['dev', 'frontend']

/**
 * Тикеты, ждущие сессии, но ещё не взятые: очередь разработки для карточки статуса.
 *
 * Очередь — это вход в разработку по `ready-for-dev`, а не всякая ступень входа:
 * ступень макета берёт тикет без этой метки, и в очереди разработки ей делать нечего.
 * Признак `dev` живёт здесь, а не в `isEntryStep()`: иначе окно смены пропускало бы
 * макет мимо расписания.
 */
export function queueOfPlan(plan) {
  return plan.filter(
    (entry) => isEntryStep(entry.step) && entry.step.when.some((key) => QUEUE_LABEL_KEYS.includes(key)),
  )
}

/** Шаг приоритета: экспортируется для теста, чтобы таблица не разъехалась с числами. */
export const PROCESS_PRIORITY_STEP = PRIORITY_STEP
