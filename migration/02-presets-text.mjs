// Миграция пресетов, шаг 2: персоны и скиллы.
//
//   node 02-presets-text.mjs --dry-run
//   node 02-presets-text.mjs
//
// Делает три вещи:
//   1) вставляет в каждую персону блок «Проект этой сессии» с расшифровкой
//      заполнителей, которые отдаёт инструмент project_info;
//   2) заменяет все конкретные значения проекта (репозиторий, ветка, пути,
//      имя compose-проекта, порты) на заполнители <...>;
//   3) добавляет в скиллы короткую заметку о том же.
// Плюс добивает устаревшие комментарии в github.mjs и добавляет поле artifacts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multiproject'
const ROLES = ['analyst', 'dev', 'tester', 'devops-delivery', 'security-review']

let edits = 0
const notes = []

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
  edits += 1
  notes.push('  ' + file + '  |  ' + label)
  return parts.join(to)
}

function replaceAll(text, from, to, label, file) {
  const parts = text.split(from)
  const count = parts.length - 1
  if (count < 1) return text
  edits += count
  notes.push('  ' + file + '  |  ' + label + ' ×' + count)
  return parts.join(to)
}

// ── Блок «Проект этой сессии» для персон ────────────────────────────────────

const PERSONA_BLOCK = [
  '',
  '      Проект этой сессии. Репозиторий, базовая ветка, рабочая копия отдела, защищённый клон человека, имя compose-проекта, порты стенда и метки конвейера принадлежат ПРОЕКТУ, а не этому промту. Они лежат в реестре `~/.dsh/projects.json`, а проект определяется по твоей рабочей области `{{cwd}}`. Перед любыми действиями с git, GitHub и docker вызови инструмент `project_info` и подставь его значения вместо заполнителей, которые встречаются ниже:',
  '',
  '      - `<repo>` — поле `repo`; `<base>` — поле `base`; `<workspace>` — поле `workspace`;',
  '      - `<humanClone>` — поле `humanClone`; `<composeProject>` — поле `composeProject`;',
  '      - `<frontendPort>` и `<apiPort>` — поля `frontendPort` и `apiPort`;',
  '      - `<artifacts>` — поле `artifacts` (каталог артефактов, вне рабочей копии);',
  '      - `<id>` — поле `id`; `<labels.dev>`, `<labels.progress>`, `<labels.test>`, `<labels.ok>`, `<labels.failed>` — поля объекта `labels`.',
  '',
  '      Ни одно из этих значений не выводи из памяти, из примеров или из этого промта — только из `project_info`. Если он вернёт `resolvedFrom: проект по умолчанию`, значит рабочая область не совпала ни с одним проектом: проверь, тот ли это проект, и при сомнении остановись и спроси человека.',
].join('\n')

const PERSONA_ANCHOR = 'on the DeepSeek Harness, powered by the {{model}} model.'

// ── Заметка для скиллов ─────────────────────────────────────────────────────

const SKILL_NOTE = [
  '> **Проект.** Репозиторий, базовая ветка, рабочая копия отдела, защищённый клон человека,',
  '> имя compose-проекта, порты стенда и метки конвейера принадлежат проекту: они лежат в реестре',
  '> `~/.dsh/projects.json`, а проект определяется по рабочей области сессии. Перед первым действием',
  '> вызови инструмент `project_info` и подставь его значения вместо заполнителей, встречающихся ниже:',
  '> `<repo>`, `<base>`, `<workspace>`, `<humanClone>`, `<composeProject>`, `<frontendPort>`, `<apiPort>`,',
  '> `<artifacts>`, `<id>`, `<labels.dev>`, `<labels.progress>`, `<labels.test>`, `<labels.ok>`, `<labels.failed>`.',
  '> Ничего не выводи из памяти и не подставляй значения по умолчанию.',
  '',
].join('\n')

// ── Замены конкретных значений на заполнители ───────────────────────────────
// Порядок важен: сначала более специфичные строки.

const TEXT_REPLACEMENTS = [
  ['D:\\Agents\\analyst\\analysis', '<artifacts>', 'каталог артефактов аналитика'],
  ['D:\\Agents\\analyst', '<workspace>', 'клон аналитика'],
  ['D:\\Agents\\vahta-review-', '<workspace>-review-', 'worktree тестировщика (абсолютный)'],
  ['D:\\Agents\\vahta', '<workspace>', 'рабочая копия отдела'],
  ['..\\vahta-review-52', '..\\<id>-review-52', 'worktree тестировщика (относительный)'],
  ['..\\vahta-review-<номер>', '..\\<id>-review-<номер>', 'worktree тестировщика (шаблон)'],
  ['D:\\Development\\VideCoding\\Vahta', '<humanClone>', 'клон человека'],
  ['vahta-agent_pgdata', '<composeProject>_pgdata', 'том базы стенда'],
  ['vahta-agent', '<composeProject>', 'имя compose-проекта'],
  ['vahta-devops', '<composeProject>', 'имя compose-проекта (devops)'],
  ['vahta-security', '<composeProject>', 'имя compose-проекта (security)'],
  ['gidvantus/vahta', '<repo>', 'репозиторий'],
  ['project `vahta`, ports 80 and 8000', "the human's own stand", 'стенд человека (en)'],
  ['проект vahta, порты 80 и 8000', 'стенд человека', 'стенд человека (ru)'],
  ['к проекту `vahta` не прикасайся', 'к стенду человека не прикасайся', 'запрет трогать стенд человека'],
  ['имя `vahta` из', 'имя проекта из', 'имя проекта из docker-compose.yml'],
  ['проекта `vahta` не трогай', 'стенда человека не трогай', 'запрет трогать контейнеры человека'],
  ['ports 80 and 8000', "the human's published ports", 'порты человека (en)'],
  ['порты 80 и 8000', 'порты человека', 'порты человека (ru)'],
  ['http://localhost:8080', 'http://localhost:<frontendPort>', 'порт фронта'],
  ['http://localhost:8001', 'http://localhost:<apiPort>', 'порт API'],
  ['develop-m', '<base>', 'базовая ветка'],
  ['кабинета вахтовика на узких экранах', 'списка на узких экранах', 'пример заголовка issue'],
]

// ── github.mjs: шапка и поле artifacts ─────────────────────────────────────

const GITHUB_HEADER_FROM = '// GitHub — плагин пресета: issues, метки и PR репозитория gidvantus/vahta.'
const GITHUB_HEADER_TO = [
  '// GitHub — плагин пресета: issues, метки и PR проекта сессии. Репозиторий и',
  '// базовая ветка берутся из ~/.dsh/projects.json по рабочей области сессии',
  '// (инструмент project_info), а не из этого файла.',
].join('\n')

const GITHUB_BASE_FROM = [
  '// Базовая ветка по умолчанию — develop-m: в неё открываются PR и от неё',
  '// ответвляются feature-ветки.',
].join('\n')
const GITHUB_BASE_TO = [
  '// Базовая ветка — поле base проекта: в неё открываются PR и от неё',
  '// ответвляются feature-ветки.',
].join('\n')

const ROW_ANCHOR = "    composeProject: typeof raw.composeProject === 'string' && raw.composeProject ? raw.composeProject : id,"
const ROW_INSERT = '\n    artifacts: projectArtifacts(raw),'

const ARTIFACTS_HELPER = [
  'function projectArtifacts(raw) {',
  "  if (typeof raw.artifacts === 'string' && raw.artifacts) return raw.artifacts",
  "  const workspace = String(raw.workspace || '').replace(/[\\\\/]+$/, '')",
  "  return workspace ? workspace + '-artifacts' : ''",
  '}',
  '',
  'function projectRow(registry, id, cwd) {',
].join('\n')

const ROW_FROM = 'function projectRow(registry, id, cwd) {'

const INFO_ANCHOR = '        composeProject: p.composeProject,'
const INFO_INSERT = '\n        artifacts: p.artifacts,'

// ── Прогон ──────────────────────────────────────────────────────────────────

for (const role of ROLES) {
  const dir = path.join(PRESETS, role)
  if (!fs.existsSync(dir)) continue

  // 1. Персона.
  const composition = path.join(dir, 'agent.cordis.yml')
  let yml = fs.readFileSync(composition, 'utf8')
  yml = replaceOnce(yml, PERSONA_ANCHOR, PERSONA_ANCHOR + '\n' + PERSONA_BLOCK, 'блок «Проект этой сессии»', role + '/agent.cordis.yml')
  for (const [from, to, label] of TEXT_REPLACEMENTS) {
    yml = replaceAll(yml, from, to, label, role + '/agent.cordis.yml')
  }
  writeFile(composition, yml)

  // 2. Скиллы.
  const skillsRoot = path.join(dir, 'skills')
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue
      const rel = role + '/skills/' + entry.name + '/SKILL.md'
      let md = fs.readFileSync(skillFile, 'utf8')
      const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(md)
      if (!front) throw new Error(rel + ': не найден front-matter')
      md = md.slice(0, front[0].length) + '\n' + SKILL_NOTE + md.slice(front[0].length)
      for (const [from, to, label] of TEXT_REPLACEMENTS) {
        md = replaceAll(md, from, to, label, rel)
      }
      writeFile(skillFile, md)
    }
  }

  // 3. github.mjs: шапка, helper artifacts, project_info.
  const github = path.join(dir, 'github.mjs')
  let js = fs.readFileSync(github, 'utf8')
  const g = role + '/github.mjs'
  js = replaceOnce(js, GITHUB_HEADER_FROM, GITHUB_HEADER_TO, 'шапка плагина', g)
  js = replaceOnce(js, GITHUB_BASE_FROM, GITHUB_BASE_TO, 'комментарий о базовой ветке', g)
  js = replaceOnce(js, ROW_FROM, ARTIFACTS_HELPER, 'helper projectArtifacts', g)
  js = replaceOnce(js, ROW_ANCHOR, ROW_ANCHOR + ROW_INSERT, 'поле artifacts в projectRow', g)
  js = replaceOnce(js, INFO_ANCHOR, INFO_ANCHOR + INFO_INSERT, 'artifacts в project_info', g)
  writeFile(github, js)
}

console.log(DRY ? '=== DRY RUN (ничего не записано) ===' : '=== ЗАПИСАНО ===')
for (const line of notes) console.log(line)
console.log('\nвсего правок: ' + edits)
