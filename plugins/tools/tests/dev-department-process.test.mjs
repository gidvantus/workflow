// Процесс отдела как данные: эталонная таблица ступеней, проверка документа, имена меток
// и матчер. Набор берёт **боевой** модуль `plugins/process.mjs` в любой раскладке
// (рабочая копия, пакет, старая) через `plugin-paths` — копий исходника здесь нет, поэтому
// расхождение кода и теста невозможно.
//
// Главная проверка — «эталонный тест 14 сценариев» из постановки #67 (`§4.5` и `§8`
// `plugins/docs/DEPARTMENT-PROCESS.md`). Решение старого диспетчера снято в `legacyStep`
// **до** перевода конвейера на данные: это снимок ветвлений `step()`/`dispatch()`, а не
// вызов живого кода. После перевода таблица по умолчанию обязана давать на тех же наборах
// меток те же решения — иначе тихая смена поведения на первом же тике.
//
// Запуск: node plugins/tools/tests/dev-department-process.test.mjs
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

/**
 * Снимок старого решения: какую ступень выбрал бы тик до перевода конвейера на данные.
 *
 * Порядок — тот, что был в `step()` ветки `main`, а не порядок строк таблицы: смысл
 * проверки в том, чтобы сравнить два независимых порядка, а не пересказать документ его
 * же строками. Прежний тик шёл так:
 *
 *   1. `handOffToFrontend()` — вторая половина полного стека;
 *   2. `settleAlreadyMerged()` — слитый PR;
 *   3. `assignArea()` — маршрут по постановке (он же `queuedOf()`: тикет без начатой
 *      работы, без метки маршрута и без ожидания макета);
 *   4. `findActive()` — передача фронтенду, ревью, тест, провал, взятая работа;
 *   5. `mockupStage()` — макет, только после активных ступеней;
 *   6. `pickQueued()` — выдача исполнителю по метке маршрута.
 *
 * `area` — выводится ли маршрут по тексту постановки (`classifyArea()`): без признаков
 * маршрута входная ступень не срабатывает, и старый код сразу выдавал задачу исполнителю
 * по умолчанию.
 */
function legacyStep(keys, area = null) {
  const labels = new Set(keys)
  const has = (key) => labels.has(key)
  const started = has('progress') || has('review') || has('test') || has('ok') || has('failed')
  const routed = has('areaBackend') || has('areaFrontend') || has('areaFullstack')
  const waitingMockup = has('mockup') && !has('mockupsReady')

  // 1. Передача фронтенду: бэкенд-часть полного стека прошла тест, второй раз её не
  //    показывают ни ревьюеру, ни тестировщику.
  if (has('areaFullstack') && !has('phaseFrontend') && has('test') && !has('review')) {
    return 'handoff-frontend'
  }
  // 2. Слитый PR закрывает тикет раньше любой ступени сессии.
  if (has('ok')) return 'merge'
  // 3. Маршрут по постановке: только у тикета без начатой работы, без метки маршрута и
  //    без ожидания макета, и только если признаки маршрута в постановке есть.
  if (has('dev') && !started && !routed && !waitingMockup && area) return 'route'
  // 4. Активная работа — в прежнем порядке `findActive()`.
  if (has('frontend')) return 'dev-fullstack-frontend'
  if (has('review')) return 'review'
  if (has('test')) return 'test'
  if (has('failed')) return 'rework-test'
  if (has('progress')) return 'continue'
  // 5. Макет — ниже активных ступеней: прежний `mockupStage()` отсекал тикеты, по которым
  //    работа уже шла, а не забирал их себе по приоритету 1.
  if (waitingMockup && !started && !has('merged')) return 'mockup'
  // 6. Вход в разработку: тикет без начатой работы и без ожидания макета.
  if (has('dev') && !started && !waitingMockup) {
    if (has('areaBackend')) return 'dev-backend'
    if (has('areaFrontend')) return 'dev-frontend'
    if (has('areaFullstack')) return 'dev-fullstack-backend'
    return 'dev-fullstack-default'
  }
  return null
}

/**
 * Решение таблицы по умолчанию для одного набора меток.
 *
 * `skip` — тот же, что передаёт `decisionOf()` (`plugins/dev-department.mjs`): маршрутная
 * ступень берётся, только если маршрут по постановке выводится. Без этого сценарий
 * «свежая постановка без площади» проверял бы путь, которым диспетчер не идёт.
 */
function tableStep(keys, options = {}) {
  const area = options.area === undefined ? null : options.area
  const plan = proc.planOfProcess(proc.defaultProcess(), [{ item: 'issue', labels: keys }], {
    skip: (step) => step.kind === 'route' && !area,
  })
  return plan.length > 0 ? plan[0].step.id : null
}

/** Роль решения таблицы: у резолвера `by-area` она выводится из ключей ступени, как в диспетчере. */
function tableRole(keys) {
  const id = tableStep(keys)
  if (id === null) return null
  if (id !== 'continue') return stepOf(id).role
  return proc.areaRoleOfKeys(keys)
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

console.log('\n=== 14 сценариев постановки: таблица по умолчанию даёт прежние решения ===')
// `area` — выводится ли маршрут по тексту постановки. Он есть только у свежей постановки
// без метки маршрута: у остальных строк маршрутная ступень и так не срабатывает. Поэтому
// набор `['dev']` проверяется дважды — с признаками маршрута в постановке и без них.
const SCENARIOS = [
  ['макет поставлен', ['mockup'], 'mockup'],
  ['макет готов, задачи нет', ['mockup', 'mockupsReady'], null],
  ['свежая постановка с признаками маршрута', ['dev'], 'route', 'backend'],
  ['свежая постановка без признаков маршрута', ['dev'], 'dev-fullstack-default'],
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
for (const [name, keys, expectedId, area = null] of SCENARIOS) {
  check(name + ' — старый код', legacyStep(keys, area), expectedId)
  check(name + ' — таблица', tableStep(keys, { area }), expectedId)
}

console.log('\n=== макет не перебивает начатую работу (страж mockup-stage) ===')
// Тикет, по которому работа уже шла, макету не отдают: старая ступень `mockupStage()`
// отсекала такие тикеты, а приоритет 1 забирал бы их у ревью и теста.
check('макет и ревью вместе — старый код', legacyStep(['mockup', 'review']), 'review')
check('макет и ревью вместе — таблица', tableStep(['mockup', 'review']), 'review')
check('макет и работа вместе', [legacyStep(['mockup', 'progress']), tableStep(['mockup', 'progress'])], [
  'continue',
  'continue',
])
check('макет и тест вместе', tableStep(['mockup', 'test']), 'test')
check('страж берёт начатую работу', proc.guardBlocks(stepOf('mockup'), ['mockup', 'test']), true)
check('страж не берёт чистую постановку', proc.guardBlocks(stepOf('mockup'), ['mockup']), false)
check('страж чужой ступени молчит', proc.guardBlocks(stepOf('review'), ['review', 'test']), false)

console.log('\n=== окно смены гасит каждую ступень входа, а не только выдачу ===')
// Признак входа — «ступень поднимает сессию по свежему тикету», и по нему диспетчер
// проверяет окно смены. Ступень макета — такая же ступень входа: пока признак был
// собран из меток очереди разработки, `needs-mockup` вне окна поднимал дизайнера,
// и расписание переставало ограничивать расход.
check('ступень макета — ступень входа', proc.isEntryStep(stepOf('mockup')), true)
check('выдача разработчику — ступень входа', proc.isEntryStep(stepOf('dev-backend')), true)
check(
  'начатая работа — не ступень входа',
  [proc.isEntryStep(stepOf('review')), proc.isEntryStep(stepOf('continue'))],
  [false, false],
)
check('маршрутная ступень — не ступень входа', proc.isEntryStep(stepOf('route')), false)
check('передача половины — не ступень входа', proc.isEntryStep(stepOf('handoff-frontend')), false)
const windowPlan = proc.planOfProcess(proc.defaultProcess(), [
  { item: 'mockup-1', labels: ['mockup'] },
  { item: 'dev-1', labels: ['dev', 'areaBackend'] },
])
check(
  'очередь разработки по-прежнему не берёт макет',
  proc.queueOfPlan(windowPlan).map((entry) => entry.item),
  ['dev-1'],
)

console.log('\n=== половина работы в доработке (by-area) ===')
// Порядок ветвлений прежнего `implementer()`: метка передачи фронтенду решает раньше
// `area:fullstack`, иначе доработка второй половины уезжала бы бэкендеру.
const L = proc.DEFAULT_PROCESS_LABELS
const names = (...keys) => keys.map((key) => L[key])
check(
  'передача фронтенду сильнее маршрута',
  proc.areaRoleOfLabels(names('frontend', 'progress', 'areaFullstack'), L),
  'dev-frontend',
)
check('полный стек до передачи — бэкенд', proc.areaRoleOfLabels(names('areaFullstack', 'progress'), L), 'dev-backend')
check(
  'вторая половина полного стека — фронтенд',
  proc.areaRoleOfLabels(names('areaFullstack', 'frontend', 'phaseFrontend'), L),
  'dev-frontend',
)
check('только бэкенд', proc.areaRoleOfLabels(names('areaBackend', 'progress'), L), 'dev-backend')
check('только фронтенд', proc.areaRoleOfLabels(names('areaFrontend', 'progress'), L), 'dev-frontend')
check('без маршрута — полный стек', proc.areaRoleOfLabels(names('progress'), L), 'dev-fullstack')
check(
  'решение таблицы по начатой работе совпадает с прежним',
  tableRole(['progress', 'frontend', 'areaFullstack']),
  'dev-frontend',
)

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
