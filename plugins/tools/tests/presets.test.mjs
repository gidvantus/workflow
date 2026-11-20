// Проверка сборки пресетов ролей из документов веб-API — на РЕАЛЬНОМ модуле
// `plugins/presets.mjs`. Правила важнее формата файла: пакетный каталог переживает
// раскладку, исчезнувший из документа скилл в staging не попадает, а неудачная
// синхронизация не оставляет в корне пресетов ни одного изменённого байта.
//
// Запуск: node plugins/tools/tests/presets.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEPLOYED_ROLES_FILE,
  buildStaging,
  parseSkillMarkdown,
  readDeployedRoles,
  renderCordis,
  renderPresetYml,
  renderSkillMarkdown,
  syncPresets,
  writeDeployedRoles,
} from '../../presets.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const importTool = path.join(repo, 'plugins', 'tools', 'presets-import.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-presets-test-'))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) +
    (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    return null
  }
}

// Побайтовый снимок каталога: «target не изменён» проверяется сравнением
// словаря путей и содержимого, а не списком файлов.
function snapshot(dir) {
  const out = {}
  const walk = (current, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
      else if (entry.isFile()) out[rel] = fs.readFileSync(path.join(current, entry.name), 'utf8')
    }
  }
  walk(dir, '')
  return out
}

// ── 1. round-trip SKILL.md ─────────────────────────────────────────────────

console.log('=== renderSkillMarkdown → parseSkillMarkdown ===')
const skillDoc = {
  code: 'demo-skill',
  title: 'Демо навык',
  description: 'Описывает: демо #1 с кириллицей',
  sections: [
    { title: 'Первое', body: 'Текст раздела с кириллицей.' },
    { title: 'Пустой', body: '' },
    { title: 'Код', body: 'До блока.\n\n```bash\necho hi\n## не раздел\n```\n\nПосле блока.' },
  ],
}
const skillText = renderSkillMarkdown(skillDoc)
const parsed = parseSkillMarkdown(skillText)
check('заголовок вернулся', parsed.title, 'Демо навык')
check('описание вернулось одной строкой', parsed.description, 'Описывает: демо #1 с кириллицей')
check('разделов столько же', parsed.sections.length, 3)
check('порядок разделов и заголовки', parsed.sections.map((s) => s.title), ['Первое', 'Пустой', 'Код'])
check('тело первого раздела', parsed.sections[0].body, 'Текст раздела с кириллицей.')
check('пустое тело', parsed.sections[1].body, '')
check('`## не раздел` остался в теле', parsed.sections[2].body,
  'До блока.\n\n```bash\necho hi\n## не раздел\n```\n\nПосле блока.')
check('файл заканчивается одним переводом строки', /[^\n]\n$/.test(skillText), true)
check('frontmatter с описанием в кавычках', skillText.startsWith('---\nname: demo-skill\ndescription: "Описывает: демо #1 с кириллицей"\n---\n'), true)

// ── 2. реальный SKILL.md из пакета ────────────────────────────────────────

console.log('\n=== разбор реального SKILL.md из пакета ===')
const realSkillsRoot = path.join(repo, 'plugins', 'agent-presets', 'code-review', 'skills')
const realSkillDir = fs.readdirSync(realSkillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()[0]
const realText = read(path.join(realSkillsRoot, realSkillDir, 'SKILL.md'))
const real = parseSkillMarkdown(realText)
check('скилл найден', typeof realText === 'string', true)
check('разделов не меньше трёх', real.sections.length >= 3, true)
check('ни один заголовок не пуст', real.sections.every((s) => s.title.trim() !== ''), true)
check('описание прочитано', real.description.length > 0, true)

// ── 3. preset.yml ─────────────────────────────────────────────────────────

console.log('\n=== renderPresetYml ===')
check('однострочное описание', renderPresetYml({ title: 'Аналитик', description: 'Роль аналитика' }),
  'name: Аналитик\ndescription: Роль аналитика\n')
check('двоеточие берётся в кавычки', renderPresetYml({ title: 'Аналитик', description: 'Роль: аналитик' }),
  'name: Аналитик\ndescription: "Роль: аналитик"\n')
check('многострочное — блоком >-',
  renderPresetYml({ title: 'Аналитик', description: 'Строка один.\nСтрока два.' }),
  'name: Аналитик\ndescription: >-\n  Строка один.\n  Строка два.\n')

// ── 4. buildStaging ───────────────────────────────────────────────────────

console.log('\n=== buildStaging ===')
const source = path.join(root, 'package')
write(path.join(source, 'analyst', 'agent.cordis.yml'), 'composition: analyst\n')
write(path.join(source, 'analyst', 'notes.txt'), 'файл вне skills\n')
write(path.join(source, 'analyst', 'preset.yml'), 'name: Старое имя\n')
write(path.join(source, 'analyst', 'skills', 'old-skill', 'SKILL.md'), '# старый скилл\n')
const template = path.join(root, 'template.yml')
write(template, 'composition of {{role-title}} ({{role-code}})\n')

const staging = path.join(root, 'staging')
const built = buildStaging({
  source,
  template,
  staging,
  documents: [
    {
      code: 'analyst',
      title: 'Аналитик (веб)',
      description: 'Описание из веба',
      skills: [{ code: 'new-skill', title: 'Новый', description: 'Описание', sections: [{ title: 'Цель', body: 'тело' }] }],
    },
    {
      code: 'gamma-role',
      title: 'Гамма',
      description: 'Роли нет в пакете',
      skills: [{ code: 'gamma-skill', title: 'Гамма-скилл', description: '', sections: [] }],
    },
  ],
})
check('сборка прошла', built.ok, true)
check('причина не названа', built.error, null)
check('роли перечислены', built.roles, ['analyst', 'gamma-role'])
check('композиция пакета на месте', read(path.join(staging, 'analyst', 'agent.cordis.yml')), 'composition: analyst\n')
check('файл вне skills/ пережил staging', read(path.join(staging, 'analyst', 'notes.txt')), 'файл вне skills\n')
check('preset.yml перезаписан из документа', read(path.join(staging, 'analyst', 'preset.yml')),
  'name: Аналитик (веб)\ndescription: Описание из веба\n')
check('старого скилла в staging нет', fs.existsSync(path.join(staging, 'analyst', 'skills', 'old-skill')), false)
check('новый скилл собран', fs.existsSync(path.join(staging, 'analyst', 'skills', 'new-skill', 'SKILL.md')), true)
const gammaComposition = read(path.join(staging, 'gamma-role', 'agent.cordis.yml'))
check('роль без пакета собрана из шаблона с подстановкой', gammaComposition,
  'composition of Гамма (gamma-role)\n')
check('плейсхолдеров не осталось', /\{\{role-/.test(gammaComposition), false)
check('renderCordis без плейсхолдеров не портит текст',
  renderCordis('как есть\n', { code: 'x', title: 'y' }), 'как есть\n')

const badStaging = path.join(root, 'staging-bad')
const bad = buildStaging({ source, template, staging: badStaging, documents: [{ code: 'Плохой Код', skills: [] }] })
check('кривой документ отвергнут', bad.ok, false)
check('причина названа', typeof bad.error === 'string' && bad.error.length > 0, true)
check('кривой код назван в тексте', /слаг/.test(String(bad.error)), true)

// ── 5. syncPresets ────────────────────────────────────────────────────────

function jsonResponse(status, body) {
  return { status, async text() { return JSON.stringify(body) } }
}

// Подмена сети: маршрут по полному адресу. Неизвестный адрес — 404 из контракта.
function transport(routes) {
  return async (url) => {
    const handler = routes[String(url)]
    if (!handler) return jsonResponse(404, { detail: 'Роль не найдена' })
    return handler()
  }
}

// Подмена раскладки: слияние staging в target и счётчик вызовов.
function makeDeploy() {
  const state = { calls: 0 }
  const copyInto = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const absFrom = path.join(from, entry.name)
      const absTo = path.join(to, entry.name)
      if (entry.isDirectory()) copyInto(absFrom, absTo)
      else if (entry.isFile()) fs.copyFileSync(absFrom, absTo)
    }
  }
  const fn = ({ source: staged, target }) => {
    state.calls += 1
    copyInto(staged, target)
    return { problem: null, written: 1, updated: 0, unchanged: 0, removed: 0 }
  }
  return { fn, state }
}

const API = 'http://127.0.0.1:8096'
const roleDoc = (code, title, revision) => ({
  code,
  title,
  description: 'Роль ' + code,
  revision,
  skills: [{ code: code + '-skill', title: 'Скилл ' + code, description: 'Описание', sections: [{ title: 'Цель', body: 'тело' }] }],
})
const manifest = (revision, roles) => ({ revision, roles })
const routesFor = (manifestBody, docs) => {
  const routes = {}
  routes[API + '/api/presets'] = () => jsonResponse(200, manifestBody)
  for (const doc of docs) {
    routes[API + '/api/presets/' + doc.code] = () => jsonResponse(200, doc)
  }
  return routes
}

const alpha = roleDoc('alpha', 'Альфа', 'ra1')
const beta = roleDoc('beta', 'Бета', 'rb1')

console.log('\n=== syncPresets: первая раскладка и повторный тик ===')
const targetA = path.join(root, 'target-a')
const deployA = makeDeploy()
const optionsA = {
  apiUrl: API,
  token: 't',
  source,
  template,
  target: targetA,
  deploy: deployA.fn,
  fetchImpl: transport(routesFor(manifest('r1', [
    { code: 'alpha', revision: 'ra1' },
    { code: 'beta', revision: 'rb1' },
  ]), [alpha, beta])),
}
const first = await syncPresets(Object.assign({}, optionsA, { applied: {} }))
check('первый вызов разложил', first.ok, true)
check('ошибка не названа', first.error, null)
check('deploy вызван один раз', deployA.state.calls, 1)
check('раскладка состоялась', first.deployed, true)
check('роли в отчёте', first.roles, ['alpha', 'beta'])
check('каталог роли появился', fs.existsSync(path.join(targetA, 'alpha', 'skills', 'alpha-skill', 'SKILL.md')), true)
check('список разложенных ролей записан', read(path.join(targetA, DEPLOYED_ROLES_FILE)),
  JSON.stringify({ roles: ['alpha', 'beta'] }, null, 2) + '\n')
check('readDeployedRoles читает его', readDeployedRoles(targetA), ['alpha', 'beta'])

const second = await syncPresets(Object.assign({}, optionsA, {
  applied: { revision: first.revision, roles: first.roleRevisions },
}))
check('второй тик ничего не разложил', second.deployed, false)
check('deploy не вызывался', deployA.state.calls, 1)
check('второй тик успешен', second.ok, true)

console.log('\n=== syncPresets: сетевая ошибка не трогает target ===')
const targetB = path.join(root, 'target-b')
writeDeployedRoles(targetB, ['alpha'])
write(path.join(targetB, 'alpha', 'preset.yml'), 'name: Прежняя альфа\n')
const beforeB = snapshot(targetB)
const failed = await syncPresets({
  apiUrl: API,
  token: 't',
  source,
  template,
  target: targetB,
  deploy: makeDeploy().fn,
  applied: {},
  fetchImpl: async () => { throw new Error('ECONNREFUSED') },
})
check('сетевая ошибка вернулась отказом', failed.ok, false)
check('причина названа по-русски', /пресеты из веба/.test(String(failed.error)), true)
check('target не изменён ни на файл', snapshot(targetB), beforeB)
check('прежний список ролей цел', readDeployedRoles(targetB), ['alpha'])

console.log('\n=== syncPresets: 401 тоже отказ ===')
const denied = await syncPresets({
  apiUrl: API,
  token: 'bad',
  source,
  template,
  target: path.join(root, 'target-denied'),
  deploy: makeDeploy().fn,
  fetchImpl: transport({ [API + '/api/presets']: () => jsonResponse(401, { detail: 'Токен реестра не принят' }) }),
})
check('401 — отказ', denied.ok, false)
check('причина — токен', /токен/.test(String(denied.error)), true)

console.log('\n=== syncPresets: роль исчезла из манифеста ===')
const targetC = path.join(root, 'target-c')
const deployC = makeDeploy()
const routesC1 = routesFor(manifest('r1', [
  { code: 'alpha', revision: 'ra1' },
  { code: 'beta', revision: 'rb1' },
]), [alpha, beta])
const c1 = await syncPresets({
  apiUrl: API, token: 't', source, template, target: targetC, deploy: deployC.fn,
  applied: {}, fetchImpl: transport(routesC1),
})
check('роли разложены', c1.roles, ['alpha', 'beta'])
write(path.join(targetC, 'my-own', 'preset.yml'), 'name: Моё\n')
const c2 = await syncPresets({
  apiUrl: API, token: 't', source, template, target: targetC, deploy: deployC.fn,
  applied: { revision: 'r1', roles: { alpha: 'ra1', beta: 'rb1' } },
  fetchImpl: transport(routesFor(manifest('r2', [{ code: 'alpha', revision: 'ra1' }]), [alpha])),
})
check('исчезнувшая роль убрана', c2.removed, ['beta'])
check('её каталога больше нет', fs.existsSync(path.join(targetC, 'beta')), false)
check('каталог оставшейся роли цел', fs.existsSync(path.join(targetC, 'alpha', 'preset.yml')), true)
check('чужой каталог не тронут', read(path.join(targetC, 'my-own', 'preset.yml')), 'name: Моё\n')
check('список ролей обновлён', readDeployedRoles(targetC), ['alpha'])
check('deploy не понадобился', deployC.state.calls, 1)

console.log('\n=== syncPresets: пустой манифест не стирает раскладку ===')
const targetD = path.join(root, 'target-d')
const deployD = makeDeploy()
const empty = await syncPresets({
  apiUrl: API, token: 't', source, template, target: targetD, deploy: deployD.fn,
  applied: {}, fetchImpl: transport(routesFor(manifest('r9', []), [])),
})
check('пустой манифест — успех', empty.ok, true)
check('раскладки не было', empty.deployed, false)
check('deploy не вызывался', deployD.state.calls, 0)

// ── 6. presets-import --dry-run без сети ─────────────────────────────────

console.log('\n=== presets-import --dry-run ===')
const importSource = path.join(root, 'import-source')
write(path.join(importSource, 'demo-role', 'preset.yml'),
  'name: Демо роль\ndescription: >-\n  Разовая проверка\n  заливки роли.\n')
write(path.join(importSource, 'demo-role', 'skills', 'demo-skill', 'SKILL.md'),
  renderSkillMarkdown({
    code: 'demo-skill',
    title: 'Демо скилл',
    description: 'Описание демо скилла',
    sections: [{ title: 'Цель', body: 'тело' }, { title: 'Шаги', body: 'раз' }],
  }))
let dryOutput = ''
let dryExit = null
try {
  dryOutput = execFileSync(process.execPath, [importTool, '--dry-run', '--source', importSource], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dryExit = 0
} catch (error) {
  dryExit = error.status
  dryOutput = String(error.stdout || '')
}
check('dry-run завершился нулём', dryExit, 0)
check('документ роли напечатан', dryOutput.includes('"code": "demo-role"'), true)
check('скилл попал в документ', dryOutput.includes('"code": "demo-skill"'), true)
check('описание роли из preset.yml склеено', dryOutput.includes('Разовая проверка заливки роли.'), true)
check('итог напечатан', /ролей: 1, изменено: 0/.test(dryOutput), true)

// ── уборка ────────────────────────────────────────────────────────────────

fs.rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nвсё прошло' : '\nпровалов: ' + failures)
process.exit(failures === 0 ? 0 : 1)
