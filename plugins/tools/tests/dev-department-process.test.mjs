// Процесс отдела как данные: эталонная таблица ступеней, проверка документа, имена меток
// и матчер. Набор берёт **боевой** модуль `plugins/proc.mjs` в любой раскладке
// (рабочая копия, пакет, старая) через `plugin-paths` — копий исходника здесь нет, поэтому
// расхождение кода и теста невозможно.
//
// Главная проверка — «эталонный тест 14 сценариев» из постановки #67 (`§4.5` и `§8`
// `plugins/docs/DEPARTMENT-PROCESS.md`). Решение старого диспетчера снято в `legacyStep`
// **до** перевода конвейера на данные: это снимок ветвлений `dispatch()`, а не вызов
// живого кода. После перевода таблица по умолчанию обязана давать на тех же 14 наборах
// меток те же решения — иначе тихая смена поведения на первом же тике.
//
// Запуск: node plugins/tools/tests/dev-department-proc.test.mjs
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as pluginPaths from '../plugin-paths.mjs'

const moduleFile = pluginPaths.pluginFile('process')
const proc = await import(pathToFileURL(path.resolve(moduleFile)).href)

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  const shown = JSON.stringify(actual)
  console.log(
    (ok ? 'ok    ' : 'ФЕЙЛ  ') +
      name +
      ' → ' +
      shown +
      (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'),
  )
}

/** Снимок старого решения: какую ступень выбрал бы `dispatch()` до перевода на данные. */
function legacyStep(keys) {
  const labels = new Set(keys)
  const has = (key) => labels.has(key)
  // Макет шёл первой проверкой: пока макета нет, постановка ждёт.
  if (has('mockup') && !has('mockupsReady')) return 'mockup'
  // Активные ступени — в прежнем порядке ветвлений; передача фронтенду проверялась
  // раньше ревью и теста.
  if (has('test') && has('areaFullstack') && !has('phaseFrontend')) return 'handoff-frontend'
  if (has('review')) return 'review'
  if (has('test')) return 'test'
  if (has('ok')) return 'merge'
  if (has('failed')) return 'rework-test'
  if (has('progress')) return 'continue'
  // Вход: маршрут по постановке, затем выдача по площади работы.
  if (
    has('dev') &&
    !has('areaBackend') &&
    !has('areaFrontend') &&
    !has('areaFullstack')
  ) {
    return 'route'
  }
  if (has('dev') && has('areaBackend')) return 'dev-backend'
  if (has('dev') && has('areaFrontend')) return 'dev-frontend'
  if (has('dev') && has('areaFullstack')) return 'dev-fullstack-backend'
  if (has('frontend')) return 'dev-fullstack-frontend'
  if (has('dev')) return 'dev-fullstack-default'
  if (has('mockup')) return null
  return null
}

/** Решение таблицы по умолчанию для одного набора меток. */
function tableStep(keys, options = {}) {
  const plan = proc.planOfProcess(proc.defaultProcess(), [{ item: 'issue', labels: keys }], options)
  return plan.length > 0 ? plan[0].step.id : null
}

/** Ступень таблицы по умолчанию по id. */
function stepOf(id) {
  return proc.defaultProcess().steps.find((row) => row.id === id)
}

console.log('=== эталонная таблица ступеней (13 строк постановки) ===')
check(
  ' id',
  proc.defaultProcess().steps.map((row) => row.id),
  [
    'mockup',
    'route',
    'handoff-frontend',
    'review',
    'test',
    'merge',
    'rework-test',
    'dev-backend',
    'dev-frontend',
    'dev-fullstack-backend',
    'dev-fullstack-frontend',
    'dev-fullstack-default',
    'continue',
  ],
)
check(
  'приоритеты — шаг 60 от 1',
  proc.defaultProcess().steps.map((row) => row.priority),
  [1, 61, 121, 181, 241, 301, 361, 421, 481, 541, 601, 661, 721],
)
check('имена меток по умолчанию', proc.defaultProcess().labels, proc.DEFAULT_PROCESS_LABELS)
check('ключей меток — 14', proc.PROCESS_LABEL_KEYS.length, 14)
check(
  'каталог стражей',
  proc.GUARD_CATALOG.map((guard) => guard.id),
  ['route', 'mockup-stage', 'dispatch', 'no-code', 'same-head', 'checklist-gate', 'limits', 'merged-already'],
)
check(
  'ступень route — маршрутная и со стражем route',
  [stepOf('route').kind, stepOf('route').guard],
  ['route', 'route'],
)
check('ступень handoff-frontend — вид auto', stepOf('handoff-frontend').kind, 'auto')
check('ступень continue — резолвер by-area', stepOf('continue').role, 'by-area')
check('ступень rework-test — резолвер by-findings', stepOf('rework-test').role, 'by-findings')
check(
  'копия умолчаний не делится между вызовами',
  (() => {
    const first = proc.defaultProcess()
    first.steps[0].put.push('test')
    return proc.defaultProcess().steps[0].put
  })(),
  ['progress'],
)

console.log('\n=== 14 сценариев: таблица по умолчанию даёт прежние решения ===')
const SCENARIOS = [
  ['макет поставлен', ['mockup'], 'mockup'],
  ['макет готов, задачи нет', ['mockup', 'mockupsReady'], null],
  ['свежая постановка без площади', ['dev'], 'route'],
  ['постановка с бэкендом', ['dev', 'areaBackend'], 'dev-backend'],
  ['постановка с фронтендом', ['dev', 'areaFrontend'], 'dev-frontend'],
  ['постановка с полным стеком', ['dev', 'areaFullstack'], 'dev-fullstack-backend'],
  ['передача фронтенду начата', ['frontend', 'phaseFrontend'], 'dev-fullstack-frontend'],
  ['работа взята', ['progress'], 'continue'],
  ['на код-ревью', ['review'], 'review'],
  ['на тестировании', ['test'], 'test'],
  ['тест полного стека на бэкенде', ['test', 'areaFullstack'], 'handoff-frontend'],
  ['тесты прошли', ['ok'], 'merge'],
  ['тестировщик вернул', ['failed'], 'rework-test'],
  ['меток нет', [], null],
]
for (const [name, keys, expectedId] of SCENARIOS) {
  check(name + ' — старый код', legacyStep(keys), expectedId)
  check(name + ' — таблица', tableStep(keys), expectedId)
}

console.log('\n=== переходы меток из строк таблицы ===')
check('макет ставит работу', stepOf('mockup').put, ['progress'])
check('передача фронтенду ставит фронт и снимает тест', [stepOf('handoff-frontend').put, stepOf('handoff-frontend').drop], [
  ['frontend'],
  ['test'],
])
check('выдача снимает ready-for-dev', stepOf('dev-backend').drop, ['dev'])
check('доработка ставит работу и снимает провал', [stepOf('rework-test').put, stepOf('rework-test').drop], [
  ['progress'],
  ['failed'],
])
check('продолжение ничего не ставит', [stepOf('continue').put, stepOf('continue').drop], [[], []])

console.log('\n=== разбор меток ступени ===')
check('все when стоят', proc.stepMatches(stepOf('review'), ['review']), true)
check('нет входящей метки', proc.stepMatches(stepOf('review'), ['test']), false)
check('unless мешает', proc.stepMatches(stepOf('dev-backend'), ['dev', 'areaBackend', 'progress']), false)
check('пустой набор меток', proc.stepMatches(stepOf('review'), []), false)

console.log('\n=== порядок ступеней ===')
const unsorted = proc.defaultProcess()
unsorted.steps.reverse()
check(
  'матичер идёт по приоритету, а не по месту в массиве',
  proc
    .planOfProcess(unsorted, [
      { item: 'a', labels: ['mockup'] },
      { item: 'b', labels: ['ok'] },
    ])
    .map((entry) => entry.item),
  ['a', 'b'],
)
const withInsert = proc.defaultProcess()
withInsert.steps.push({
  id: 'между',
  title: 'Ступень между',
  kind: 'session',
  role: 'analyst',
  when: ['progress'],
  unless: ['review', 'test', 'ok', 'failed'],
  put: [],
  drop: [],
  guard: 'dispatch',
  priority: 91,
  enabled: true,
})
check(
  'вставленная ступень приоритетом 91 перекрывает продолжение',
  proc.planOfProcess(withInsert, [{ item: 'a', labels: ['progress'] }])[0].step.id,
  'между',
)
const disabled = proc.defaultProcess()
disabled.steps.find((row) => row.id === 'test').enabled = false
check(
  'выключенная ступень пропускается',
  proc.planOfProcess(disabled, [{ item: 'a', labels: ['test'] }])[0]?.step.id,
  undefined,
)
check(
  'вне смены исполняется только маршрутная ступень',
  proc
    .planOfProcess(
      proc.defaultProcess(),
      [
        { item: 'a', labels: ['dev'] },
        { item: 'b', labels: ['review'] },
      ],
      { kinds: ['route'] },
    )
    .map((entry) => entry.step.id),
  ['route'],
)
check(
  'снятый тикет в план не попадает',
  proc.planOfProcess(proc.defaultProcess(), [{ item: 'a', labels: ['dev'], dropped: true }]),
  [],
)

console.log('\n=== активный тикет и очередь для статуса ===')
const statusPlan = proc.planOfProcess(proc.defaultProcess(), [
  { item: 'review-1', labels: ['dev', 'areaBackend'] },
  { item: 'review-2', labels: ['review'] },
])
check('активная ступень — самая ранняя из начатых', proc.activeOfPlan(statusPlan)?.item, 'review-2')
check('очередь — тикеты, ждущие сессии', proc.queueOfPlan(statusPlan).map((entry) => entry.item), ['review-1'])
// Решение — самая ранняя по приоритету ступень: ревью (181) раньше выдачи бэкенду (421).
check('решение — первая ступень плана', proc.nextOfPlan(statusPlan).item, 'review-2')

console.log('\n=== разрешение процесса отдела ===')
const none = proc.processOf(undefined)
check('своего процесса нет — умолчания', [none.source, none.problems], ['default', []])
check('отпечаток умолчаний', none.digest.length, 12)
const saved = proc.processOf(proc.defaultProcess())
check('сохранённый документ — источник web', saved.source, 'web')
const renamed = proc.defaultProcess()
renamed.labels.test = 'qa-ready'
const renamedProcess = proc.processOf(renamed)
check('отпечаток меняется от переименования метки', renamedProcess.digest !== saved.digest, true)
const broken = proc.processOf({ version: 1, labels: { test: 'x' }, steps: [] })
check('битый документ процессом не становится', broken.source, 'default')
check('причина названа', broken.problems.length > 0, true)
check('служебный документ не прошёл проверку', proc.validateProcess({ version: 7 }).document, null)

console.log('\n=== имена меток: веб → файл → умолчания ===')
check(
  'без своего процесса имена берутся из файла',
  proc.labelsOfProcess(none, { test: 'из-файла' }).test,
  'из-файла',
)
check(
  'сохранённый процесс перекрывает файл',
  proc.labelsOfProcess(renamedProcess, { test: 'из-файла' }).test,
  'qa-ready',
)
check(
  'остальные имена — умолчания',
  proc.labelsOfProcess(none, {}).merged,
  'merged',
)
const withRole = proc.defaultProcess()
withRole.steps[0].role = 'нет-такой'
// Каталог хоста: роли, которые диспетчер умеет поднимать, — остальные ступени держат их.
const HOST_ROLES = [
  'design',
  'code-review',
  'tester',
  'devops-delivery',
  'dev-backend',
  'dev-frontend',
  'dev-fullstack',
]
check(
  'роль вне каталога хоста — проблема, а не тихая замена',
  proc.processOf(withRole, { roles: HOST_ROLES }).problems.length > 0,
  true,
)
check(
  'роль из каталога хоста проходит',
  proc.processOf(withRole, { roles: [...HOST_ROLES, 'нет-такой'] }).source,
  'web',
)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛО: ' + failures)
process.exit(failures === 0 ? 0 : 1)
