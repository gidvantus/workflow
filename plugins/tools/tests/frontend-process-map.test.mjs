// Карта процесса на странице отдела: разбор документа в граф ступеней и раскладка полотна.
// Набор берёт **боевой** модуль `app/frontend/src/api/processGraph.ts` — сборка через
// `esbuild` из `app/frontend/node_modules` в память, копий исходника здесь нет. Документ
// тоже не копия: он разбирается из `app/backend/app/process_defaults.py`, того самого
// файла, который сервер отдаёт в `GET /api/departments/{id}/process`. Поэтому правка
// умолчаний (ступень выключили, ключ переехал из `unless` в `when`) роняет набор, а не
// уезжает молча на экран.
//
// Что проверяется:
//   1. числа приёмки на документе умолчаний: 13 ступеней, 33 связи в полях (17/9/7) и
//      8 проводов между ступенями — только пары `put` ∩ `when`;
//   2. узлы карты — только ступени: меток-узлов нет, метки живут строками блока
//      (вход / выход / снимает / кроме) с подписями из документа;
//   3. провода — ровно по парам «одна ступень ставит, другая берёт», ни одного лишнего;
//   4. выключенная ступень уходит с полотна вместе со своими проводами, а её метки, если
//      брать их больше некому, честно попадают в «Вне схемы» с причиной;
//   5. раскладка: колонки по четыре в порядке `priority`, блоки не слипаются и не выходят
//      за полотно, провода идут слева направо и приходят в гребёнку разных портов;
//   6. подписи видов, ролей и провода живут в одном месте модуля.
//
// Запуск: node plugins/tools/tests/frontend-process-map.test.mjs

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  KIND_HINTS,
  KIND_TITLES,
  PROCESS_MAP_GEOMETRY,
  RESOLVER_TITLES,
  UNUSED_REASON_TITLES,
  WIRE_RULE,
  buildProcessGraph,
  layoutProcessGraph,
  roleTitle,
  wireTitle,
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
  const keysBlock = python.slice(python.indexOf('LABEL_KEYS:'), python.indexOf('DEFAULT_LABELS'))
  const labelsBlock = python.slice(python.indexOf('DEFAULT_LABELS'), python.indexOf('DEFAULT_LABEL_TITLES'))
  const titlesBlock = python.slice(python.indexOf('DEFAULT_LABEL_TITLES'), python.indexOf('GUARDS:'))
  const guardsBlock = python.slice(python.indexOf('GUARDS:'), python.indexOf('GUARD_IDS'))
  const version = Number(/PROCESS_VERSION\s*=\s*(\d+)/.exec(python)[1])

  const keys = [...keysBlock.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1])
  const labels = {}
  for (const match of labelsBlock.matchAll(/"([A-Za-z]+)":\s*"([^"]+)"/g)) {
    labels[match[1]] = match[2]
  }
  const titles = {}
  for (const match of titlesBlock.matchAll(/"([A-Za-z]+)":\s*"([^"]+)"/g)) {
    titles[match[1]] = match[2]
  }
  const tags = keys.map((key) => ({ key, name: labels[key], title: titles[key], agent: null }))

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

  return { document: { version, tags, steps }, guards }}

const { document: defaults, guards: defaultGuards } = readDefaults()

/** Имя тега на GitHub по ключу — то, что рисует карта. */
const tagName = (key) => defaults.tags.find((tag) => tag.key === key)?.name ?? ''

// Шапка разбора: если разбор исходника сломался, дальше проверять нечего.
check('документ умолчаний: версия формата', defaults.version, 2)
check('документ умолчаний: ступеней', defaults.steps.length, 13)
check('документ умолчаний: ключей тегов', defaults.tags.length, 14)
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

const enabledSteps = defaults.steps.filter((step) => step.enabled)

// ---------------------------------------------------------------------------
// 0. Узлов-меток больше нет: на полотне только ступени (замечание тестировщика «слева
//    отображается справочник лейблов»). Старые имена экспортов тоже не должны вернуться.

check('модуль: узлов-меток нет', graphApi.labelNodeId, undefined)
check('модуль: вида ребра нет', graphApi.EDGE_TITLES, undefined)

// ---------------------------------------------------------------------------
// 1. Числа на документе умолчаний.

const graph = buildProcessGraph(defaults, defaultGuards)

check('умолчания: ступеней на полотне', graph.steps.length, 13)
check('умолчания: связей «когда»', graph.links.when, 17)
check('умолчания: связей «ставит»', graph.links.put, 9)
check('умолчания: связей «снимает»', graph.links.drop, 7)
check('умолчания: связей всего', graph.links.total, 33)
check('умолчания: проводов между ступенями', graph.wires.length, 8)

check(
  'умолчания: вне схемы',
  graph.unused.map((item) => [item.key, item.reason]),
  [
    ['mockupsReady', 'unless'],
    ['merged', 'unused'],
  ],
)
check(
  'умолчания: причина «вне схемы» словами',
  graph.unused.map((item) => item.reasonTitle),
  [UNUSED_REASON_TITLES.unless, UNUSED_REASON_TITLES.unused],
)

check(
  'умолчания: ступени на полотне идут в порядке документа',
  graph.steps.map((node) => node.step.id),
  enabledSteps.map((step) => step.id),
)

check(
  'умолчания: вид и роль первой ступени',
  [graph.steps[0].kindTitle, graph.steps[0].roleTitle],
  [KIND_TITLES.session, 'роль design'],
)
check(
  'умолчания: у маршрута роли нет — это сказано словами',
  graph.steps[1].roleTitle,
  'роли нет · решает маршрут',
)
check(
  'умолчания: резолвер роли подписан правилом, а не кодом',
  graph.steps.find((node) => node.step.id === 'rework-test').roleTitle,
  'роль: ' + RESOLVER_TITLES['by-findings'],
)
check(
  'умолчания: страж подписан словами каталога',
  graph.steps[0].guardTitle,
  defaultGuards.find((guard) => guard.id === 'mockup-stage').title,
)
check(
  'умолчания: страж «Выдача» подписан каталогом',
  graph.steps.find((node) => node.step.id === 'dev-backend').guardTitle,
  defaultGuards.find((guard) => guard.id === 'dispatch').title,
)
check('умолчания: у «Тестирования» стража нет', graph.steps.find((node) => node.step.id === 'test').guardTitle, null)

// ---------------------------------------------------------------------------
// 2. Метки живут строками блока: подписи из документа, источник точки входа — `put`.

const mockupNode = graph.steps[0]
check(
  'умолчания: «вход» первой ступени',
  mockupNode.whenLabels.map((item) => [item.key, item.name, item.fromStep]),
  [['mockup', tagName('mockup'), false]],
)
check(
  'умолчания: «выход» первой ступени',
  mockupNode.putLabels.map((item) => [item.key, item.name, item.fromStep]),
  [['progress', tagName('progress'), true]],
)
check(
  'умолчания: «снимает» ступени передачи фронтенду',
  graph.steps.find((node) => node.step.id === 'handoff-frontend').dropLabels.map((item) => item.key),
  ['test'],
)
check(
  'умолчания: «кроме» маршрута',
  graph.steps[1].unlessLabels.map((item) => item.key),
  ['progress', 'review', 'test', 'ok', 'failed', 'areaBackend', 'areaFrontend', 'areaFullstack'],
)
check(
  'умолчания: метку, которую ставит другая ступень, видно по заливке точки',
  graph.steps
    .find((node) => node.step.id === 'dev-fullstack-frontend')
    .whenLabels.map((item) => [item.key, item.fromStep]),
  [['frontend', true]],
)
check(
  'умолчания: у авто роли в документе нет',
  graph.steps.find((node) => node.step.id === 'handoff-frontend').step.role,
  null,
)
check(
  'умолчания: роль ступени — из документа',
  roleTitle({ ...defaults.steps[0] }),
  'роль design',
)

// ---------------------------------------------------------------------------
// 3. Провода — ровно пары «одна ступень ставит, другая берёт»: ни лишних, ни пропущенных.

const expectedWires = []
for (const source of enabledSteps) {
  for (const target of enabledSteps) {
    if (source.id === target.id) continue
    for (const key of source.put) {
      if (target.when.includes(key)) {
        expectedWires.push(`${source.id}->${target.id}:${key}`)
      }
    }
  }
}

check(
  'умолчания: набор проводов совпадает с парами ставит ∩ когда',
  graph.wires.map((wire) => `${wire.from}->${wire.to}:${wire.key}`).sort(),
  expectedWires.sort(),
)
check(
  'умолчания: концы проводов — ступени полотна',
  graph.wires.every((wire) => graph.steps.some((node) => node.step.id === wire.from) && graph.steps.some((node) => node.step.id === wire.to)),
  true,
)
check(
  'умолчания: провода идут в «Продолжение взятой работы»',
  graph.wires.map((wire) => wire.to).sort(),
  ['continue', 'continue', 'continue', 'continue', 'continue', 'continue', 'continue', 'dev-fullstack-frontend'].sort(),
)
check(
  'умолчания: подпись провода — имя метки из документа',
  graph.wires.every((wire) => wire.labelName === tagName(wire.key)),
  true,
)
check(
  'умолчания: подпись провода называет обе ступени и метку',
  (() => {
    const wire = graph.wires[0]
    const phrase = wireTitle(wire)
    return [
      phrase.includes(wire.fromTitle),
      phrase.includes(wire.toTitle),
      phrase.includes(wire.labelName),
    ]
  })(),
  [true, true, true],
)
check(
  'умолчания: ступень считает свои провода',
  graph.steps
    .filter((node) => node.wiresOut > 0 || node.wiresIn > 0)
    .map((node) => [node.step.id, node.wiresIn, node.wiresOut]),
  [
    ['mockup', 0, 1],
    ['handoff-frontend', 0, 1],
    ['rework-test', 0, 1],
    ['dev-backend', 0, 1],
    ['dev-frontend', 0, 1],
    ['dev-fullstack-backend', 0, 1],
    ['dev-fullstack-frontend', 1, 1],
    ['dev-fullstack-default', 0, 1],
    ['continue', 7, 0],
  ],
)

// ---------------------------------------------------------------------------
// 4. Выключенная ступень уходит с полотна вместе со своими проводами: сценарий приёмки
//    «снять „включена“ у „Слияние“» и у «Передачи фронтенду», которая ставит `frontend`.

const withoutMerge = buildProcessGraph(
  onlyEnabled(...defaults.steps.filter((step) => step.id !== 'merge').map((step) => step.id)),
  defaultGuards,
)
check('без «Слияния»: ступеней', withoutMerge.steps.length, 12)
check('без «Слияния»: проводов', withoutMerge.wires.length, 8)
check('без «Слияния»: узла нет', withoutMerge.steps.some((node) => node.step.id === 'merge'), false)
// `ok` включает только «Слияние»; снятая ступень уносит свою метку с полотна, и метка не
// пропадает молча — она уходит в «Вне схемы» с причиной (кадр 5 макета рисует ровно это).
check(
  'без «Слияния»: `ok` во «Вне схемы»',
  withoutMerge.unused.map((item) => [item.key, item.reason]),
  [
    ['mockupsReady', 'unless'],
    ['ok', 'unless'],
    ['merged', 'unused'],
  ],
)

const withoutHandoff = buildProcessGraph(
  onlyEnabled(...defaults.steps.filter((step) => step.id !== 'handoff-frontend').map((step) => step.id)),
  defaultGuards,
)
check('без «Передачи фронтенду»: проводов', withoutHandoff.wires.length, 7)
check(
  'без «Передачи фронтенду»: пропал ровно её провод',
  withoutHandoff.wires.some((wire) => wire.from === 'handoff-frontend'),
  false,
)

const nothingEnabled = buildProcessGraph(onlyEnabled(), defaultGuards)
check('все ступени выключены: ступеней', nothingEnabled.steps.length, 0)
check('все ступени выключены: проводов', nothingEnabled.wires.length, 0)
check('все ступени выключены: все метки вне схемы', nothingEnabled.unused.length, 14)

const noSteps = buildProcessGraph({ version: 2, tags: defaults.tags, steps: [] }, defaultGuards)
check('пустой документ: ступеней', noSteps.steps.length, 0)
check('пустой документ: проводов', noSteps.wires.length, 0)

// ---------------------------------------------------------------------------
// 5. Раскладка: колонки по четыре, блоки не слипаются, провода идут слева направо.

/** Пары координат из `d`: `M x y C x1 y1 x2 y2 x y`. */
function pathPoints(d) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const points = []
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]])
  return { count: numbers.length, points }
}

/** Пересечение двух блоков: по ней видно, что раскладка не наехала сама на себя. */
function overlaps(left, right) {
  return (
    left.x < right.x + PROCESS_MAP_GEOMETRY.blockW &&
    right.x < left.x + PROCESS_MAP_GEOMETRY.blockW &&
    left.y < right.y + PROCESS_MAP_GEOMETRY.blockH &&
    right.y < left.y + PROCESS_MAP_GEOMETRY.blockH
  )
}

/** Проверка одного полотна: размеры, рамки блоков, координаты проводов. */
function checkLayout(name, processGraph) {
  const { pad, blockW, blockH, perColumn } = PROCESS_MAP_GEOMETRY
  const layout = layoutProcessGraph(processGraph)
  const count = processGraph.steps.length
  const columns = Math.max(1, Math.ceil(count / perColumn))

  check(`${name}: ширина полотна`, layout.width, pad * 2 + columns * blockW + (columns - 1) * (PROCESS_MAP_GEOMETRY.colGap))
  assert(`${name}: высота положительная`, layout.height > 0, 'высота ' + layout.height)

  const overlapsFound = []
  for (let i = 0; i < layout.steps.length; i += 1) {
    for (let j = i + 1; j < layout.steps.length; j += 1) {
      if (overlaps(layout.steps[i], layout.steps[j])) {
        overlapsFound.push(`${layout.steps[i].node.step.id}/${layout.steps[j].node.step.id}`)
      }
    }
  }
  check(`${name}: блоки не наезжают друг на друга`, overlapsFound, [])

  assert(
    `${name}: все блоки внутри полотна`,
    layout.steps.every(
      (placed) =>
        placed.x >= pad &&
        placed.y >= pad &&
        placed.x + blockW <= layout.width - pad &&
        placed.y + blockH <= layout.height - pad,
    ),
    `блоков ${layout.steps.length}`,
  )

  check(
    `${name}: блоков столько же, сколько ступеней`,
    layout.steps.length,
    processGraph.steps.length,
  )
  check(
    `${name}: порядок блоков — порядок документа`,
    layout.steps.map((placed) => placed.node.step.id),
    processGraph.steps.map((node) => node.step.id),
  )
  check(
    `${name}: колонки по ${perColumn}`,
    layout.steps.map((placed) => placed.column),
    processGraph.steps.map((_, index) => Math.floor(index / perColumn)),
  )

  const points = []
  for (const placed of layout.wires) {
    const parsed = pathPoints(placed.d)
    assert(
      `${name}: путь провода ${placed.wire.from}→${placed.wire.to} — M + одна кривая`,
      parsed.count === 8,
      'чисел ' + parsed.count,
    )
    points.push(...parsed.points)
  }
  assert(
    `${name}: провода внутри полотна`,
    points.every(([x, y]) => x >= 0 && x <= layout.width && y >= 0 && y <= layout.height),
    'точек ' + points.length,
  )

  const byId = new Map(layout.steps.map((placed) => [placed.node.step.id, placed]))
  const endpointsOk = layout.wires.every((placed) => {
    const from = byId.get(placed.wire.from)
    const to = byId.get(placed.wire.to)
    if (from === undefined || to === undefined) return false
    const endOk =
      placed.to.x === to.x - PROCESS_MAP_GEOMETRY.portInset &&
      placed.to.y >= to.y &&
      placed.to.y <= to.y + blockH
    // Провод между колонками выходит из правого края источника, провод внутри колонки —
    // из её левого поля: там же, где вход цели.
    const startOk =
      to.column > from.column
        ? placed.from.x === from.x + blockW && placed.from.y === from.y + PROCESS_MAP_GEOMETRY.outRow
        : placed.from.x === from.x
    return endOk && startOk
  })
  check(`${name}: концы проводов стоят на своих блоках`, endpointsOk, true)

  const forwardWires = layout.wires.filter((placed) => {
    const from = byId.get(placed.wire.from)
    const to = byId.get(placed.wire.to)
    return from !== undefined && to !== undefined && to.column > from.column
  })
  check(
    `${name}: провода между колонками идут слева направо`,
    forwardWires.every((placed) => placed.to.x > placed.from.x),
    true,
  )

  return layout
}

const defaultsLayout = checkLayout('умолчания', graph)
check('умолчания: размеры полотна как в макете', [defaultsLayout.width, defaultsLayout.height], [1520, 724])

const continueLayout = defaultsLayout.steps.find((placed) => placed.node.step.id === 'continue')
check('умолчания: одинокая ступень последней колонки — по центру', [continueLayout.x, continueLayout.y], [1212, 282])

// Гребёнка портов: семь проводов в одну точку слиплись бы, и карта показывала бы одну связь.
const continuePorts = defaultsLayout.wires
  .filter((placed) => placed.to.x === 1212 - PROCESS_MAP_GEOMETRY.portInset)
  .map((placed) => placed.to.y)
check('умолчания: в «Продолжение» приходит семь проводов', continuePorts.length, 7)
check('умолчания: порты входа не слиплись', new Set(continuePorts).size, 7)
check(
  'умолчания: порты входа раздвинуты шагом гребёнки',
  continuePorts
    .slice(1)
    .map((port, index) => Math.round((port - continuePorts[index]) * 100) / 100),
  [6.5, 6.5, 6.5, 6.5, 6.5, 6.5],
)

// Сценарий приёмки Ф1 прошлого круга: у документа одна ступень. Полотно обязано остаться
// читаемым — один блок, положительные размеры, ни одного провода.
const singleStep = buildProcessGraph(onlyEnabled('dev-backend'), defaultGuards)
check('одна ступень: ступеней', singleStep.steps.length, 1)
check('одна ступень: проводов', singleStep.wires.length, 0)
const singleLayout = checkLayout('одна ступень', singleStep)
check('одна ступень: полотно не схлопнулось', [singleLayout.width, singleLayout.height], [320, 184])

// Две ступени с проводом между ними: концы провода на своих блоках.
const twoSteps = buildProcessGraph(onlyEnabled('handoff-frontend', 'dev-fullstack-frontend'), defaultGuards)
check('две ступени: проводов', twoSteps.wires.length, 1)
checkLayout('две ступени', twoSteps)

// Провод «назад»: метку ставит ступень ниже по `priority`, а берёт её ступень выше, поэтому
// колонка цели левее колонки источника и обычная ветка раскладки не срабатывает. В умолчаниях
// таких пар нет, но документ их допускает (правка порядка на вкладке «Процесс»), и провод
// обязан остаться внутри полотна, а не уехать за край. Замечание ревью Ф3: ветка без проверки.
const backwardBase = {
  kind: 'session',
  role: null,
  when: [],
  unless: [],
  put: [],
  drop: [],
  guard: null,
  enabled: true,
}
const backwardDocument = {
  version: 2,
  tags: defaults.tags,
  steps: [
    { ...backwardBase, id: 'early', title: 'Ранняя', when: ['progress'], priority: 10 },
    { ...backwardBase, id: 'fill-a', title: 'Наполнение А', priority: 20 },
    { ...backwardBase, id: 'fill-b', title: 'Наполнение Б', priority: 30 },
    { ...backwardBase, id: 'fill-c', title: 'Наполнение В', priority: 40 },
    { ...backwardBase, id: 'fill-d', title: 'Наполнение Г', priority: 50 },
    { ...backwardBase, id: 'late', title: 'Поздняя', put: ['progress'], priority: 60 },
  ],
}
const backwardGraph = buildProcessGraph(backwardDocument, defaultGuards)
check('провод назад: проводов', backwardGraph.wires.length, 1)
check(
  'провод назад: пара «ставит ∩ когда»',
  backwardGraph.wires.map((wire) => [wire.from, wire.to, wire.key]),
  [['late', 'early', 'progress']],
)
check(
  'провод назад: ступени считают его на карте',
  [
    backwardGraph.steps.find((node) => node.step.id === 'late').wiresOut,
    backwardGraph.steps.find((node) => node.step.id === 'early').wiresIn,
  ],
  [1, 1],
)
// checkLayout проверяет размеры, неслипание, попадание всех точек пути в полотно и концы на
// блоках; для провода назад он ждёт выход из левого края источника, а не из правого.
const backwardLayout = checkLayout('провод назад', backwardGraph)
const backwardWire = backwardLayout.wires[0]
const earlyPlaced = backwardLayout.steps.find((placed) => placed.node.step.id === 'early')
const latePlaced = backwardLayout.steps.find((placed) => placed.node.step.id === 'late')
check('провод назад: колонки', [latePlaced.column, earlyPlaced.column], [1, 0])
check(
  'провод назад: из левого края источника в левый порт цели',
  [
    backwardWire.from.x,
    backwardWire.from.y,
    backwardWire.to.x,
    backwardWire.to.y,
  ],
  [
    latePlaced.x,
    latePlaced.y + PROCESS_MAP_GEOMETRY.outRow,
    earlyPlaced.x - PROCESS_MAP_GEOMETRY.portInset,
    earlyPlaced.y + PROCESS_MAP_GEOMETRY.inRow,
  ],
)
check(
  'провод назад: линия целиком внутри полотна',
  pathPoints(backwardWire.d).points.every(
    ([x, y]) => x >= 0 && x <= backwardLayout.width && y >= 0 && y <= backwardLayout.height,
  ),
  true,
)

const emptyLayout = layoutProcessGraph(noSteps)
check('пустой документ: блоков', emptyLayout.steps.length, 0)
assert('пустой документ: высота положительная', emptyLayout.height > 0, 'высота ' + emptyLayout.height)
assert('пустой документ: ширина положительная', emptyLayout.width > 0, 'ширина ' + emptyLayout.width)

// ---------------------------------------------------------------------------
// 6. Подписи видов, ролей, причин и правило провода живут в одном месте модуля.

check('подписи видов: три вида', Object.keys(KIND_TITLES).sort(), ['auto', 'route', 'session'])
check('подписи видов: разные строки', new Set(Object.values(KIND_TITLES)).size, 3)
check('пояснения видов: три вида', Object.keys(KIND_HINTS).sort(), ['auto', 'route', 'session'])
check('пояснения видов: разные строки', new Set(Object.values(KIND_HINTS)).size, 3)
assert(
  'пояснения видов: у каждого вида пояснение словами',
  Object.values(KIND_HINTS).every((hint) => typeof hint === 'string' && hint.length > 10),
  JSON.stringify(KIND_HINTS),
)
check('подписи резолверов: два правила', Object.keys(RESOLVER_TITLES).sort(), ['by-area', 'by-findings'])
check('подписи причин: две разные строки', new Set(Object.values(UNUSED_REASON_TITLES)).size, 2)
assert('правило провода описано словами', typeof WIRE_RULE === 'string' && WIRE_RULE.length > 20, WIRE_RULE)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
process.exit(failures === 0 ? 0 : 1)
