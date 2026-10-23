// Шаг 9: проект Brain — без отдела, без репозитория, на общем боте.
//
//   node 19-add-brain.mjs --dry-run
//   node 19-add-brain.mjs
//
// Brain — рабочий каталог, а не git-репозиторий: ни .git, ни remote. Поэтому у
// проекта нет repo, а инструменты GitHub должны сказать об этом прямо, а не
// строить путь /repos//issues/…
//
//   1) добавляет проект brain в ~/.dsh/projects.json (отдел выключен);
//   2) в github.mjs: без repo инструменты GitHub отказывают с внятной причиной,
//      а project_info продолжает работать и отдаёт repo: null;
//   3) в персонах и скиллах: пустой humanClone объясняется — защищённого клона
//      нет, рабочая область и есть каталог человека.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PRESETS = path.join(HOME, '.agent-presets')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-brain'

let edits = 0

function backup(file) {
  const target = file + BACKUP_SUFFIX
  if (!DRY && !fs.existsSync(target)) fs.copyFileSync(file, target)
}

function replaceOnce(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length !== 2) throw new Error('для «' + label + '» ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  edits += 1
  console.log('  ' + label)
  return parts.join(to)
}

// Для персон и скиллов: пресет может быть проектно-нейтральным (design) и не
// содержать блока о проекте вовсе — тогда просто нечего править.
function replaceIfPresent(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length === 1) return text
  if (parts.length !== 2) throw new Error('для «' + label + '» ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  edits += 1
  console.log('  ' + label)
  return parts.join(to)
}

function writeFile(file, text) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
  if (before === text) return
  backup(file)
  if (!DRY) fs.writeFileSync(file, text, 'utf8')
}

// ── 1. Проект ──────────────────────────────────────────────────────────────

{
  const file = path.join(HOME, 'projects.json')
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (registry.projects.brain) {
    console.log('[skip] проект brain уже есть в реестре')
  } else {
    let shared
    try {
      shared = JSON.parse(fs.readFileSync(path.join(HOME, 'telegram.json'), 'utf8'))
    } catch (error) {
      shared = undefined
    }
    const brain = {
      title: 'Brain',
      workspace: 'D:\\Development\\VideCoding\\Brain',
      department: { enabled: false },
    }
    if (shared && shared.token && shared.chatId) {
      brain.telegram = { token: String(shared.token), chatId: shared.chatId }
      console.log('[ok]  бот взят из telegram.json (' + String(shared.token).split(':')[0] + ')')
    } else {
      console.log('[warn] telegram.json не читается — проект brain останется без бота')
    }
    registry.projects.brain = brain
    writeFile(file, JSON.stringify(registry, null, 2) + '\n')
    console.log('[ok]  проект brain добавлен (' + Object.keys(registry.projects).length + ' проекта)')
  }
}

// ── 2. Пресеты: репозиторий может отсутствовать ────────────────────────────

const EXECUTE_FROM = [
  '        async execute(args, exec) {',
  '          const p = resolveProject(exec)',
  '          return JSON.stringify(await run(args || {}, p), null, 2)',
].join('\n')

const EXECUTE_TO = [
  '        async execute(args, exec) {',
  '          const p = resolveProject(exec)',
  '          // У проекта может не быть репозитория вовсе (рабочий каталог, не',
  '          // связанный с GitHub). Говорим об этом прямо: иначе инструмент ушёл',
  '          // бы на /repos//issues/… и вернул невнятную ошибку.',
  "          if (!p.repo && name !== 'project_info') {",
  "            throw new Error('у проекта ' + p.id + ' не задан repo в ~/.dsh/projects.json — инструменты GitHub для него недоступны')",
  '          }',
  '          return JSON.stringify(await run(args || {}, p), null, 2)',
].join('\n')

const REPO_FROM = '        repo: p.repo,'
const REPO_TO = '        repo: p.repo || null,'

// ── 3. Персоны и скиллы: защищённого клона может не быть ───────────────────

const PERSONA_FROM = '      - `<humanClone>` — поле `humanClone`; `<composeProject>` — поле `composeProject`;'
const PERSONA_TO = '      - `<humanClone>` — поле `humanClone`. Если оно пусто, отдельного защищённого клона у проекта нет: твоя рабочая область и есть каталог человека, и работать в ней — норма. `<composeProject>` — поле `composeProject`;'

const SKILL_FROM = '> `<artifacts>`, `<id>`. Метки конвейера берутся из `project_info.labels`, если проект их переопределяет.'
const SKILL_TO = [
  '> `<artifacts>`, `<id>`. Метки конвейера берутся из `project_info.labels`, если проект их переопределяет.',
  '> Пустое `<humanClone>` значит, что защищённого клона нет и рабочая область и есть каталог человека.',
  '> Пустой `<repo>` значит, что проект не связан с GitHub — инструменты `gh_*` на нём откажут.',
].join('\n')

for (const id of fs.readdirSync(PRESETS)) {
  const dir = path.join(PRESETS, id)
  if (!fs.statSync(dir).isDirectory()) continue

  const github = path.join(dir, 'github.mjs')
  if (fs.existsSync(github)) {
    let js = fs.readFileSync(github, 'utf8')
    if (js.includes('не задан repo в ~/.dsh/projects.json')) {
      console.log('[skip] ' + id + '/github.mjs: проверка уже есть')
    } else {
      js = replaceOnce(js, EXECUTE_FROM, EXECUTE_TO, id + '/github.mjs: отказ без repo')
      js = replaceOnce(js, REPO_FROM, REPO_TO, id + '/github.mjs: repo может быть null')
      writeFile(github, js)
    }
  }

  const composition = path.join(dir, 'agent.cordis.yml')
  if (fs.existsSync(composition)) {
    let yml = fs.readFileSync(composition, 'utf8')
    if (yml.includes('отдельного защищённого клона у проекта нет')) {
      console.log('[skip] ' + id + '/agent.cordis.yml: пояснение уже есть')
    } else {
      yml = replaceIfPresent(yml, PERSONA_FROM, PERSONA_TO, id + '/agent.cordis.yml: пояснение про humanClone')
      writeFile(composition, yml)
    }
  }

  const skillsRoot = path.join(dir, 'skills')
  if (!fs.existsSync(skillsRoot)) continue
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skill = path.join(skillsRoot, entry.name, 'SKILL.md')
    if (!fs.existsSync(skill)) continue
    let md = fs.readFileSync(skill, 'utf8')
    if (md.includes('Пустое `<humanClone>` значит')) {
      console.log('[skip] ' + id + '/' + entry.name + ': пояснение уже есть')
      continue
    }
    md = replaceIfPresent(md, SKILL_FROM, SKILL_TO, id + '/' + entry.name + ': пояснение про humanClone')
    writeFile(skill, md)
  }
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
console.log('правок: ' + edits)
