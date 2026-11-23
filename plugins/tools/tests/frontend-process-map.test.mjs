// Карта процесса на странице отдела: разбор документа в граф и раскладка полотна.
// Набор берёт **боевой** модуль `app/frontend/src/api/processGraph.ts` — сборка через
// `esbuild` из `app/frontend/node_modules` в память, копий исходника здесь нет. Документ
// тоже не копия: он разбирается из `app/backend/app/process_defaults.py`, того самого
// файла, который сервер отдаёт в `GET /api/departments/{id}/process`. Поэтому правка
// умолчаний (ступень выключили, ключ переехал из `unless` в `when`) роняет набор, а не
// уезжает молча на экран.
//
// Что проверяется:
//   1. числа приёмки на документе умолчаний: 13 ступеней, 12 меток, 33 ребра (17/9/7) и
//      «вне схемы» — `mockupsReady` (только в `unless`) и `merged` (нигде);
//   2. рёбра — ровно по полям ступеней, ни одного лишнего и ни одного пропущенного;
//   3. выключенная ступень уходит с полотна вместе со своими рёбрами;
//   4. раскладка не слипается: у документа из одной ступени метки встают друг под другом,
//      а не в одну точку (возврат код-ревью Ф1), и блоки не выходят за полотно.
//
// Запуск: node plugins/tools/tests/frontend-process-map.test.mjs

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const frontend = path.join(repo, 'app', 'frontend')
const graphFile = path.join(frontend, 'src', 'api', 'processGraph.ts')
const defaultsFile = path.join(repo, 'app', 'backend', 'app', 'process_defaults.py')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    (ok ? 'ok    ' : 'ФЕЙЛ  ') +
      name +
      ' → ' +
      JSON.stringify(actual) +
      (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'),
  )
}

function assert(name, condition, detail = '') {
  check(name + (detail === '' ? '' : ' — ' + detail), Boolean(condition), true)
}

// ---------------------------------------------------------------------------
// Боевой модуль фронта: esbuild собирает TypeScript в память, дальше — обычный import.

const frontendRequire = createRequire(path.join(frontend, 'package.json'))
const esbuild = frontendRequire('esbuild')
const bundled = esbuild.buildSync({
  entryPoints: [graphFile],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'node20',
  write: false,
})
const code = bundled.outputFiles[0].text
const graphApi = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

const {
  EDGE_TITLES,
  PROCESS_MAP_GEOMETRY,
  buildProcessGraph,
  layoutProcessGraph,
  labelNodeId,
  stepNodeId,
} = graphApi

// ---------------------------------------------------------------------------
// Документ умолчаний из питоновского исходника: маленький разбор `_step(...)`, а не копия.

const python = readFileSync(defaultsFile, 'utf8')

/** Разбить текст по запятым верхнего уровня, не заглядывая внутрь строк и скобок. */
function splitTop(text) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      current += ch
      if (ch === '\\') {
        current += text[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Строковые константы модуля: ступени ссылаются на `ROLE_BY_FINDINGS`, а не на литерал. */
const constants = {}
for (const match of python.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/gm)) {
  constants[match[1]] = match[2]
}

/** Значение питоновского литерала того вида, что встречается в таблице умолчаний. */
function parseValue(text) {
  const value = text.trim()
  if (value.startsWith('(')) {
    const inner = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'))
    return splitTop(inner).map(parseValue)
  }
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(1, -1)
  if (value === 'True') return true
  if (value === 'False') return false
  if (value === 'None') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value in constants) return constants[value]
  throw new Error('не разобрал значение в process_defaults.py: ' + value)
}

/** Вызовы `_step(...)` и их аргументы: позиционные — priority, id, title, when. */
function stepCalls(source) {
  const calls = []
  let from = 0
  for (;;) {
    const at = source.indexOf('_step(', from)
    if (at === -1) break
    let depth = 0
    let quote = null
    let end = -1
    for (let i = at + '_step'.length; i < source.length; i += 1) {
      const ch = source[i]
      if (quote !== null) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '(') depth += 1
      if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) throw new Error('не нашёл закрывающую скобку у _step(')
    calls.push(splitTop(source.slice(at + '_step('.length, end)))
    from = end + 1
  }
  return calls
}

function readDefaults() {
  const stepsBlock = python.slice(python.indexOf('DEFAULT_STEPS'), python.indexOf('def default_process'))
  const labelsBlock = python.slice(python.indexOf('DEFAULT_LABELS'), python.indexOf('ROLE_BY_AREA'))
  const guardsBlock = python.slice(python.indexOf('GUARDS:'), python.indexOf('GUARD_IDS'))
  const version = Number(/PROCESS_VERSION\s*=\s*(\d+)/.exec(python)[1])

  const labels = {}
  for (const match of labelsBlock.matchAll(/"([A-Za-z]+)":\s*"([^"]+)"/g)) {
    labels[match[1]] = match[2]
  }

  const guards = [...guardsBlock.matchAll(/\(\s*"([A-Za-z-]+)",\s*"([^"]+)"\s*\)/g)].map((match) => ({
    id: match[1],
    title: match[2],
  }))

  const steps = stepCalls(stepsBlock).map((args) => {
    const positional = []
    const keywords = {}
    for (const arg of args) {
      const named = /^([A-Za-z_]+)\s*=\s*([\s\S]+)$/.exec(arg)
      if (named) keywords[named[1]] = named[2]
      else positional.push(arg)
    }
    if (positional.length !== 4) {
      throw new Error('у _step() ожидались четыре позиционных аргумента, пришло ' + positional.length)
    }
    const [priority, id, title, when] = positional.map(parseValue)
    const pick = (name, fallback) => (name in keywords ? parseValue(keywords[name]) : fallback)
    return {
      id,
      title,
      kind: pick('kind', 'session'),
      role: pick('role', null),
      when,
      unless: pick('unless', []),
      put: pick('put', []),
      drop: pick('drop', []),
      guard: pick('guard', null),
      priority,
      enabled: pick('enabled', true),
    }
  })

  return { document: { version, labels, steps }, guards }
}

const { document: defaults, guards: defaultGuards } = readDefaults()

// Шапка разбора: если разбор исходника сломался, дальше проверять нечего.
check('документ умолчаний: версия формата', defaults.version, 1)
check('документ умолчаний: ступеней', defaults.steps.length, 13)
check('документ умолчаний: ключей меток', Object.keys(defaults.labels).length, 14)
check('документ умолчаний: стражей', defaultGuards.length, 7)
check(
  'документ умолчаний: порядок ступеней по priority',
  [...defaults.steps].sort((a, b) => a.priority - b.priority).map((step) => step.id),
  defaults.steps.map((step) => step.id),
)
check('документ умолчаний: все ступени включены', defaults.steps.every((step) => step.enabled), true)

/** Документ с теми же ступенями, но включёнными только перечисленными: так правит веб. */
function onlyEnabled(...ids) {
  return {
    ...defaults,
    steps: defaults.steps.map((step) => ({ ...step, enabled: ids.includes(step.id) })),
  }
}

// ---------------------------------------------------------------------------
// 1. Числа приёмки на документе умолчаний.

const graph = buildProcessGraph(defaults, defaultGuards)

check('умолчания: ступеней на полотне', graph.steps.length, 13)
check('умолчания: меток на полотне', graph.states.length, 12)
check('умолчания: рёбер всего', graph.edges.length, 33)

const byKind = (kind) => graph.edges.filter((edge) => edge.kind === kind).length
check('умолчания: рёбер trigger', byKind('trigger'), 17)
check('умолчания: рёбер put', byKind('put'), 9)
check('умолчания: рёбер drop', byKind('drop'), 7)

check(
  'умолчания: вне схемы',
  graph.unused.map((item) => [item.key, item.reason]),
  [
    ['mockupsReady', 'unless'],
    ['merged', 'unused'],
  ],
)

check(
  'умолчания: ступени на полотне идут в порядке документа',
  graph.steps.map((node) => node.step.id),
  defaults.steps.filter((step) => step.enabled).map((step) => step.id),
)

check(
  'умолчания: название ступени и вид — из документа',
  graph.steps.slice(0, 2).map((node) => [node.step.title, node.kindTitle]),
  [
    ['Макет постановки', 'сессия'],
    ['Маршрут по постановке', 'маршрут'],
  ],
)

check(
  'умолчания: страж подписан словами каталога',
  graph.steps[0].guardTitle,
  defaultGuards.find((guard) => guard.id === 'mockup-stage').title,
)

check(
  'умолчания: «кроме» ступени',
  graph.steps[1].unlessKeys,
  ['progress', 'review', 'test', 'ok', 'failed', 'areaBackend', 'areaFrontend', 'areaFullstack'],
)

// ---------------------------------------------------------------------------
// 2. Рёбра — ровно по полям ступеней: ни одного лишнего, ни одного пропущенного.

const signature = (edges) =>
  edges
    .map(
      (edge) =>
        `${edge.kind}|${edge.key}|${edge.kind === 'trigger' ? edge.to : edge.from}`,
    )
    .sort()

const expectedEdges = []
for (const step of defaults.steps.filter((node) => node.enabled)) {
  const nodeId = stepNodeId(step.id)
  for (const key of step.when) expectedEdges.push(`trigger|${key}|${nodeId}`)
  for (const key of step.put) expectedEdges.push(`put|${key}|${nodeId}`)
  for (const key of step.drop) expectedEdges.push(`drop|${key}|${nodeId}`)
}

check('умолчания: набор рёбер совпадает с полями ступеней', signature(graph.edges), expectedEdges.sort())

const stateKeys = new Set(graph.states.map((state) => state.key))
const stepIds = new Set(graph.steps.map((node) => node.nodeId))
check(
  'умолчания: метка каждого ребра — узел полотна',
  graph.edges.every((edge) => stateKeys.has(edge.key)),
  true,
)
check(
  'умолчания: концы рёбер — узлы полотна',
  graph.edges.every((edge) =>
    edge.kind === 'trigger'
      ? edge.from === labelNodeId(edge.key) && stepIds.has(edge.to)
      : stepIds.has(edge.from) && edge.to === labelNodeId(edge.key),
  ),
  true,
)

check(
  'умолчания: узлы-ступени адресуются как step:<id>',
  graph.steps.every((node) => node.nodeId === `step:${node.step.id}`),
  true,
)
check(
  'умолчания: узлы-метки адресуются как label:<key>',
  graph.states.every((state) => labelNodeId(state.key) === `label:${state.key}`),
  true,
)

check(
  'умолчания: подписи меток — из документа, порядок — порядок ключей',
  graph.states.slice(0, 3).map((state) => [state.key, state.name]),
  [
    ['dev', defaults.labels.dev],
    ['frontend', defaults.labels.frontend],
    ['areaBackend', defaults.labels.areaBackend],
  ],
)

// ---------------------------------------------------------------------------
// 3. Выключенная ступень уходит с полотна вместе со своими рёбрами:
//    сценарий приёмки «снять „включена“ у „Слияние“».

const withoutMerge = buildProcessGraph(
  onlyEnabled(...defaults.steps.filter((step) => step.id !== 'merge').map((step) => step.id)),
  defaultGuards,
)
check('без «Слияния»: ступеней', withoutMerge.steps.length, 12)
check('без «Слияния»: рёбер', withoutMerge.edges.length, 32)
check('без «Слияния»: узла нет', withoutMerge.steps.some((node) => node.step.id === 'merge'), false)
// `ok` включает только «Слияние»: снятая ступень уносит свою метку с полотна, и метка
// не пропадает молча — она уходит в «Вне схемы» (кадр 5 макета рисует ровно это).
check(
  'без «Слияния»: `ok` ушла с полотна',
  withoutMerge.states.some((state) => state.key === 'ok'),
  false,
)
check(
  'без «Слияния»: `ok` во «Вне схемы»',
  withoutMerge.unused.map((item) => [item.key, item.reason]),
  [
    ['mockupsReady', 'unless'],
    ['ok', 'unless'],
    ['merged', 'unused'],
  ],
)

const nothingEnabled = buildProcessGraph(onlyEnabled(), defaultGuards)
check('все ступени выключены: ступеней', nothingEnabled.steps.length, 0)
check('все ступени выключены: меток', nothingEnabled.states.length, 0)
check('все ступени выключены: рёбер', nothingEnabled.edges.length, 0)
check('все ступени выключены: все метки вне схемы', nothingEnabled.unused.length, 14)

const noSteps = buildProcessGraph({ version: 1, labels: defaults.labels, steps: [] }, defaultGuards)
check('пустой документ: ступеней', noSteps.steps.length, 0)
check('пустой документ: рёбер', noSteps.edges.length, 0)

// ---------------------------------------------------------------------------
// 4. Раскладка: блоки не слипаются и не выходят за полотно.

/** Пары координат из `d`: `M x y C x1 y1 x2 y2 x y`. */
function pathPoints(d) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const points = []
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]])
  return { count: numbers.length, points }
}

/** Проверка одного полотна: рамки, просветы меток, координаты рёбер. */
function checkLayout(name, layout) {
  const { padY, labelH, stepH } = PROCESS_MAP_GEOMETRY

  check(`${name}: ширина полотна`, layout.width, PROCESS_MAP_GEOMETRY.width)

  const labelTops = layout.states.map((placed) => placed.top)
  const stepTops = layout.steps.map((placed) => placed.top)
  const gaps = labelTops.slice(1).map((top, index) => top - labelTops[index])

  assert(`${name}: метки не слиплись`, gaps.every((gap) => gap >= labelH), 'минимальный просвет ' + (gaps.length === 0 ? '—' : Math.min(...gaps)))
  assert(
    `${name}: ступени не слиплись`,
    stepTops.slice(1).every((top, index) => top - stepTops[index] >= stepH),
  )
  assert(
    `${name}: все блоки внутри полотна`,
    [...labelTops.map((top) => [top, labelH]), ...stepTops.map((top) => [top, stepH])].every(
      ([top, height]) => top >= 0 && top + height <= layout.height,
    ),
    'высота ' + layout.height,
  )
  assert(
    `${name}: над полотном и под ним есть отступ`,
    labelTops.every((top) => top >= padY - 0.001) &&
      stepTops.every((top) => top >= padY - 0.001) &&
      layout.height - Math.max(0, ...labelTops.map((top) => top + labelH), ...stepTops.map((top) => top + stepH)) >= padY - 0.001,
  )

  const points = layout.edges.flatMap((placed) => pathPoints(placed.d).points)
  const numbersOk = layout.edges.every((placed) => pathPoints(placed.d).count === 8)
  assert(`${name}: путь каждого ребра — M + одна кривая`, numbersOk)
  assert(
    `${name}: рёбра внутри полотна`,
    points.every(([x, y]) => x >= 0 && x <= layout.width && y >= 0 && y <= layout.height),
    'точек ' + points.length,
  )
}

checkLayout('умолчания', layoutProcessGraph(graph))

// Сценарий возврата Ф1: у документа одна ступень, а меток у неё три. До правки все три
// метки получали один и тот же `top` и рисовались друг на друге.
const singleStep = buildProcessGraph(onlyEnabled('dev-backend'), defaultGuards)
check('одна ступень: ступеней', singleStep.steps.length, 1)
check('одна ступень: меток', singleStep.states.length, 3)
const singleLayout = layoutProcessGraph(singleStep)
check(
  'одна ступень: у меток разные `top`',
  new Set(singleLayout.states.map((placed) => placed.top)).size,
  3,
)
checkLayout('одна ступень', singleLayout)

// Две ступени и пять меток: шаг ступеней (78) меньше, чем нужен пяти меткам (5 × 56).
const twoSteps = buildProcessGraph(onlyEnabled('dev-backend', 'dev-fullstack-frontend'), defaultGuards)
check('две ступени: ступеней', twoSteps.steps.length, 2)
check('две ступени: меток', twoSteps.states.length, 5)
checkLayout('две ступени', layoutProcessGraph(twoSteps))

// Пустой документ тоже рисуется: высота положительная, узлов и рёбер нет.
const emptyLayout = layoutProcessGraph(noSteps)
check('пустой документ: узлов', emptyLayout.states.length + emptyLayout.steps.length, 0)
assert('пустой документ: высота положительная', emptyLayout.height > 0, 'высота ' + emptyLayout.height)

// ---------------------------------------------------------------------------
// 5. Подписи видов рёбер живут в одном месте: легенда карты и `<title>` стрелки берут их
//    из `EDGE_TITLES`, второго набора текстов в разметке нет.

check('подписи рёбер: три вида', Object.keys(EDGE_TITLES).sort(), ['drop', 'put', 'trigger'])
check(
  'подписи рёбер: в легенде разные строки',
  new Set(['trigger', 'put', 'drop'].map((kind) => EDGE_TITLES[kind].legend)).size,
  3,
)
check(
  'подписи рёбер: фраза стрелки называет метку и ступень',
  ['trigger', 'put', 'drop'].map((kind) => {
    const phrase = EDGE_TITLES[kind].arrow('метка-x', 'ступень-y')
    return phrase.includes('метка-x') && phrase.includes('ступень-y')
  }),
  [true, true, true],
)
assert(
  'подписи рёбер: фраза стрелки не пустая и не шаблон',
  ['trigger', 'put', 'drop'].every((kind) => !EDGE_TITLES[kind].arrow('a', 'b').includes('{')),
)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
process.exit(failures === 0 ? 0 : 1)
