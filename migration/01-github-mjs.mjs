// Миграция пресетов к реестру проектов: заменяет жёсткие REPO/DEFAULT_BASE в
// github.mjs всех ролевых пресетов на резолв проекта по рабочей области сессии.
//
//   node 01-github-mjs.mjs --dry-run   # только отчёт, ничего не пишет
//   node 01-github-mjs.mjs             # пишет файлы, рядом кладёт .bak-multiproject
//
// Скрипт идемпотентен по замыслу: повторный запуск без --dry-run на уже
// мигрированном файле упадёт на проверке «ожидался ровно один фрагмент», и
// ничего не испортит — файл не будет записан.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'

const report = []

function note(file, what, count) {
  report.push({ file, what, count })
}

function writeFile(file, text) {
  if (DRY) return
  const backup = file + BACKUP_SUFFIX
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, text, 'utf8')
}

function replaceOnce(text, from, to, label, file) {
  const parts = text.split(from)
  if (parts.length !== 2) {
    throw new Error(file + ': для «' + label + '» ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  }
  note(file, label, 1)
  return parts.join(to)
}

function replaceAll(text, from, to, label, file) {
  const parts = text.split(from)
  const count = parts.length - 1
  if (count < 1) throw new Error(file + ': не найден фрагмент для «' + label + '»')
  note(file, label, count)
  return parts.join(to)
}

// ── Блок, который встаёт на место const REPO / const DEFAULT_BASE ────────────
// Собирается из строк, а не шаблоном, чтобы не возиться с экранированием.

const PROJECT_BLOCK = [
  '// ── Реестр проектов ─────────────────────────────────────────────────────────',
  '// Ни репозиторий, ни базовая ветка, ни рабочая копия здесь не заданы: они',
  '// принадлежат проекту и живут в ~/.dsh/projects.json. Проект выбирается по',
  '// рабочей области вызывающей сессии, поэтому один и тот же пресет обслуживает',
  '// все проекты машины. Формат файла:',
  '//   { "default": "<id>",',
  '//     "projects": { "<id>": { "repo": "owner/name", "base": "develop-m",',
  '//                             "workspace": "D:\\\\Agents\\\\<id>",',
  '//                             "humanClone": "D:\\\\...",',
  '//                             "composeProject": "<id>-agent",',
  '//                             "frontendPort": 8080, "apiPort": 8001 } } }',
  '',
  'const PIPELINE_LABELS = {',
  "  dev: 'ready-for-dev',",
  "  progress: 'in-progress',",
  "  test: 'ready-for-test',",
  "  ok: 'tested',",
  "  failed: 'test-failed',",
  '}',
  '',
  'function dshHomeDir() {',
  "  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')",
  '}',
  '',
  'function registryFile() {',
  "  return path.join(dshHomeDir(), 'projects.json')",
  '}',
  '',
  'function readRegistry() {',
  '  const file = registryFile()',
  '  let raw',
  '  try {',
  "    raw = JSON.parse(fs.readFileSync(file, 'utf8'))",
  '  } catch (error) {',
  '    throw new Error(',
  "      'не читается реестр проектов ' + file + ': ' + (error && error.message ? error.message : String(error)) +",
  '      \'. Нужен файл вида {"default":"<id>","projects":{"<id>":{"repo":"owner/name","base":"develop-m","workspace":"D:\\\\\\\\Agents\\\\\\\\<id>"}}}\',',
  '    )',
  '  }',
  '  const projects = (raw && raw.projects) || {}',
  '  const ids = Object.keys(projects)',
  '  if (ids.length === 0) throw new Error(\'реестр \' + file + \' пуст: в "projects" нет ни одного проекта\')',
  '  const fallbackId = typeof raw.default === \'string\' && raw.default ? raw.default : ids[0]',
  '  return { projects, ids, defaultId: fallbackId }',
  '}',
  '',
  'function normalizePath(value) {',
  "  return String(value || '').replace(/\\//g, '\\\\').replace(/\\\\+$/, '').toLowerCase()",
  '}',
  '',
  'function projectRow(registry, id, cwd) {',
  '  const raw = registry.projects[id] || {}',
  '  return {',
  '    id,',
  "    title: typeof raw.title === 'string' ? raw.title : id,",
  "    repo: String(raw.repo || ''),",
  "    base: typeof raw.base === 'string' && raw.base ? raw.base : 'main',",
  "    workspace: String(raw.workspace || ''),",
  "    humanClone: typeof raw.humanClone === 'string' ? raw.humanClone : '',",
  "    composeProject: typeof raw.composeProject === 'string' && raw.composeProject ? raw.composeProject : id,",
  '    frontendPort: Number.isInteger(raw.frontendPort) ? raw.frontendPort : 8080,',
  '    apiPort: Number.isInteger(raw.apiPort) ? raw.apiPort : 8001,',
  '    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),',
  '    matched: false,',
  "    cwd: cwd || '',",
  '  }',
  '}',
  '',
  '// Проект сессии — рабочая область с самым длинным совпадающим префиксом. Если',
  '// она не совпала ни с одним проектом, проект по умолчанию берётся только когда',
  '// он в реестре один: молча работать не с тем репозиторием хуже, чем встать.',
  'function pickProject(registry, cwd) {',
  '  const wanted = normalizePath(cwd)',
  '  if (wanted) {',
  '    let best = null',
  '    let bestLength = -1',
  '    for (const id of registry.ids) {',
  '      const row = projectRow(registry, id, cwd)',
  '      const root = normalizePath(row.workspace)',
  '      if (!root) continue',
  "      if (wanted === root || wanted.indexOf(root + '\\\\') === 0) {",
  '        if (root.length > bestLength) { best = row; bestLength = root.length }',
  '      }',
  '    }',
  '    if (best) { best.matched = true; return best }',
  '  }',
  '  if (registry.ids.length > 1) {',
  '    throw new Error(',
  "      'рабочая область ' + (cwd || '(неизвестна)') + ' не совпала ни с одним проектом из ' + registryFile() +",
  "      '. Известные проекты: ' + registry.ids.map((id) => id + ' (' + (registry.projects[id] || {}).workspace + ')').join(', ') +",
  "      '. Откройте сессию в рабочей области проекта.',",
  '    )',
  '  }',
  '  return projectRow(registry, registry.defaultId, cwd)',
  '}',
].join('\n')

// ── Вставка в apply(): доступ к рабочей области вызывающей сессии ────────────

const APPLY_ANCHOR = "    if (!tools) throw new Error('github: сервис tools недоступен, инструменты не зарегистрированы')"

const APPLY_INSERT = [
  '',
  "    const sessions = ctx.get('sessions')",
  '',
  '    // Инструменты пресета общие для всех сессий на этом пресете (standing',
  '    // mount), поэтому проект определяется на каждом вызове, а не при',
  '    // регистрации инструмента.',
  '    function callerCwd(exec) {',
  '      try {',
  '        const caller = exec && exec.agent',
  '        if (!caller || !sessions) return \'\'',
  '        const session = sessions.get(caller.id)',
  "        return (session && session.header && session.header.cwd) || ''",
  '      } catch (error) {',
  "        return ''",
  '      }',
  '    }',
  '',
  '    function resolveProject(exec) {',
  '      return pickProject(readRegistry(), callerCwd(exec))',
  '    }',
].join('\n')

const EXECUTE_FROM = [
  '        async execute(args) {',
  '          return JSON.stringify(await run(args || {}), null, 2)',
].join('\n')

const EXECUTE_TO = [
  '        async execute(args, exec) {',
  '          const p = resolveProject(exec)',
  '          return JSON.stringify(await run(args || {}, p), null, 2)',
].join('\n')

// ── project_info ────────────────────────────────────────────────────────────

const PROJECT_INFO_TOOL = [
  '',
  '    const projectInfoTool = define(',
  "      'project_info',",
  "      'Проект этой сессии: репозиторий, базовая ветка, рабочая копия отдела, защищённый клон человека, имя compose-проекта, порты стенда и метки конвейера. Вызывай до любых действий с git, GitHub и docker и используй значения дословно.',",
  "      { type: 'object', properties: {}, required: [], additionalProperties: false },",
  '      async (_a, p) => ({',
  '        id: p.id,',
  '        title: p.title,',
  '        repo: p.repo,',
  '        base: p.base,',
  '        workspace: p.workspace,',
  '        humanClone: p.humanClone || null,',
  '        composeProject: p.composeProject,',
  '        frontendPort: p.frontendPort,',
  '        apiPort: p.apiPort,',
  '        labels: p.labels,',
  "        resolvedFrom: p.matched ? 'рабочая область сессии' : 'проект по умолчанию (рабочая область не совпала ни с одним проектом)',",
  '        cwd: p.cwd || null,',
  '      }),',
  '    )',
].join('\n')

const REGISTER_ANCHOR = "    ctx.effect(() => tools.register(prTool), 'github:gh_pr')"

// Описания инструментов: убираем имя конкретного репозитория и ветки.
const DESCRIPTION_REPLACEMENTS = [
  [
    "'Прочитать issue репозитория ' + REPO + ': ",
    "'Прочитать issue проекта: ",
    'описание gh_issue',
  ],
  [
    "'Список issue репозитория ' + REPO + ', по умолчанию открытых.",
    "'Список issue проекта, по умолчанию открытых.",
    'описание gh_issues',
  ],
  [
    "'Создать issue в ' + REPO + '. ",
    "'Создать issue проекта. ",
    'описание gh_issue_create',
  ],
  [
    "'Открыть pull request. База по умолчанию — ' + DEFAULT_BASE + '. ",
    "'Открыть pull request. База — базовая ветка проекта (project_info.base). ",
    'описание gh_pr_create',
  ],
  [
    "description: 'Целевая ветка, по умолчанию ' + DEFAULT_BASE",
    "description: 'Целевая ветка; по умолчанию — базовая ветка проекта (project_info.base)'",
    'описание параметра base',
  ],
]

const presetIds = fs.existsSync(PRESETS) ? fs.readdirSync(PRESETS) : []
const targets = presetIds
  .map((id) => path.join(PRESETS, id, 'github.mjs'))
  .filter((file) => fs.existsSync(file))

if (targets.length === 0) throw new Error('не найдено ни одного github.mjs в ' + PRESETS)

for (const file of targets) {
  const rel = path.relative(PRESETS, file)
  let text = fs.readFileSync(file, 'utf8')

  // 1. Константы → реестр проектов.
  const constants = "const REPO = 'gidvantus/vahta'\nconst DEFAULT_BASE = 'develop-m'"
  text = replaceOnce(text, constants, PROJECT_BLOCK, 'const REPO/DEFAULT_BASE → реестр', rel)

  // 2. Описания инструментов без имени репозитория.
  for (const [from, to, label] of DESCRIPTION_REPLACEMENTS) {
    if (!text.includes(from)) continue
    text = replaceAll(text, from, to, label, rel)
  }

  // 3. Пути API: на проект вызова.
  text = replaceAll(text, "'/repos/' + REPO", "'/repos/' + p.repo", 'пути /repos/', rel)
  text = replaceAll(text, 'a.base || DEFAULT_BASE', 'a.base || p.base', 'базовая ветка PR', rel)

  // 4. Доступ к рабочей области сессии.
  text = replaceOnce(text, APPLY_ANCHOR, APPLY_ANCHOR + APPLY_INSERT, 'резолвер проекта в apply()', rel)

  // 5. execute() получает проект.
  text = replaceOnce(text, EXECUTE_FROM, EXECUTE_TO, 'execute(args, exec)', rel)

  // 6. Тела инструментов получают проект.
  text = replaceAll(text, 'async (a) =>', 'async (a, p) =>', 'параметр p у инструментов', rel)

  // 6b. Вложения tester: вспомогательные функции тоже должны знать проект.
  if (text.includes('uploadImageFile')) {
    text = replaceOnce(text, 'async function repositoryId() {', 'async function repositoryId(p) {', 'repositoryId(p)', rel)
    text = replaceOnce(text, 'await repositoryId()', 'await repositoryId(p)', 'вызов repositoryId(p)', rel)
    text = replaceOnce(text, 'async function uploadImageFile(filePath) {', 'async function uploadImageFile(filePath, p) {', 'uploadImageFile(filePath, p)', rel)
    text = replaceOnce(text, 'await uploadImageFile(image)', 'await uploadImageFile(image, p)', 'вызов uploadImageFile(image, p)', rel)
  }

  // 7. Инструмент project_info.
  text = replaceOnce(text, REGISTER_ANCHOR, REGISTER_ANCHOR + '\n' + PROJECT_INFO_TOOL + "\n    ctx.effect(() => tools.register(projectInfoTool), 'github:project_info')", 'регистрация project_info', rel)

  // 8. Контроль: ни REPO, ни DEFAULT_BASE не осталось.
  const leftovers = []
  for (const token of ['REPO', 'DEFAULT_BASE']) {
    const re = new RegExp('\\b' + token + '\\b', 'g')
    const hits = (text.match(re) || []).length
    if (hits > 0) leftovers.push(token + '×' + hits)
  }
  if (leftovers.length > 0) {
    throw new Error(rel + ': остались жёсткие константы — ' + leftovers.join(', '))
  }

  writeFile(file, text)
}

// ── Отчёт ───────────────────────────────────────────────────────────────────

console.log(DRY ? '=== DRY RUN (ничего не записано) ===' : '=== ЗАПИСАНО ===')
for (const row of report) {
  console.log('  ' + row.file + '  |  ' + row.what + '  |  ' + row.count)
}
console.log('\nвсего файлов: ' + targets.length + ', правок: ' + report.reduce((n, r) => n + r.count, 0))
