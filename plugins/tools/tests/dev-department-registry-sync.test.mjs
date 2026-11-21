// Синхронизация кеша реестра проектов с вебом: настоящий диспетчер, настоящий
// HTTP — только сервер поддельный и на loopback.
//
// Проверяется главное правило версии 2: источник правды — база веба, а файл в
// каталоге состояния — её кеш. Кеш забирают раз в несколько минут на тике, и
// ошибка забирания (401, битый ответ, мёртвый сервер) не должна оставлять смену
// без реестра: работа идёт на прошлом кеше, а причина видна в `registrySync`.
// Локальные ключи (телеграм, порты, `default`) не имеют права пропасть.
//
// Запуск: node plugins/tools/tests/dev-department-registry-sync.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import * as pluginPaths from '../plugin-paths.mjs'

const pluginFile = pluginPaths.pluginFile('dev-department')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-sync-test-'))
const home = path.join(sandbox, 'home')
const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
const WORKSPACE = path.join(sandbox, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true })
fs.mkdirSync(path.join(home, 'mcp', 'github-mcp-server'), { recursive: true })
fs.writeFileSync(path.join(home, 'mcp', 'github-mcp-server', 'token'), 'test-token\n')
process.env.DSH_HOME = home

const projectsFile = path.join(stateDir, 'projects.json')
const TOKEN = 'secret-registry-token'

// Документ веба: проект называется по-другому и приносит новое расписание —
// значит, файл обязан измениться. Ключи бота и портов веб не знает.
const webDocument = (repo) => ({
  version: 2,
  projects: [
    {
      id: 'vahta',
      title: 'Вахта из веба',
      departments: [
        {
          kind: 'development',
          repo,
          base: 'main',
          workspace: WORKSPACE,
          windows: [{ start: '13:00', stop: '04:00' }],
          maxRework: 2,
        },
      ],
    },
  ],
})

const localDocument = () => ({
  version: 2,
  default: 'vahta',
  projects: [
    {
      id: 'vahta',
      title: 'Вахта из файла',
      departments: [
        {
          kind: 'development',
          repo: 'gidvantus/old',
          base: 'develop-m',
          workspace: WORKSPACE,
          frontendPort: 8095,
          apiPort: 8096,
          areas: { backend: ['backend/'], frontend: ['frontend/'] },
          telegram: { token: 'bot-token', chatId: 1 },
        },
      ],
    },
  ],
})

// Порт сервера нужен до записи настроек, а синхронизация начинается на первом же
// тике — поэтому сервер поднимается сразу, а отвечает тем, что лежит в `mode`.
let mode = { kind: 'ok', body: webDocument('gidvantus/vahta'), status: 200 }
let requests = 0
const server = http.createServer((request, response) => {
  requests += 1
  if (mode.kind === 'ok') {
    response.writeHead(mode.status, { 'Content-Type': 'application/json' })
    response.end(typeof mode.body === 'string' ? mode.body : JSON.stringify(mode.body))
    return
  }
  if (mode.kind === 'status') {
    response.writeHead(mode.status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ detail: 'нет' }))
    return
  }
  if (mode.kind === 'broken') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{ это не json')
    return
  }
  response.writeHead(500)
  response.end('')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = 'http://127.0.0.1:' + server.address().port + '/api/registry'

const writeConfig = (registry) => {
  const config = {
    windows: [{ start: '00:00', stop: '23:59' }],
    maxRework: 3,
    maxAttempts: 4,
    stuckAfterMinutes: 30,
    usageRates: { inputUsdPerM: 0.15, cacheReadUsdPerM: 0.003, cacheWriteUsdPerM: 0, outputUsdPerM: 0.6 },
  }
  if (registry) config.registry = registry
  fs.writeFileSync(path.join(stateDir, 'dev-department.json'), JSON.stringify(config, null, 2))
}
writeConfig({ apiUrl, token: TOKEN })
fs.writeFileSync(projectsFile, JSON.stringify(localDocument(), null, 2))

// ── диспетчер на поддельных сервисах ───────────────────────────────────────
let generation = 0
async function boot() {
  generation += 1
  const mod = await import('file:///' + pluginFile.replace(/\\/g, '/') + '?v=' + generation)
  const tools = []
  const services = {
    timer: {},
    tools: { register(tool) { tools.push(tool) } },
    agents: {},
    sessions: {},
    agentPresets: { async mount() {} },
    workspaceRegistry: { async resolveByPath() { return undefined }, async create(p) { return { path: p, attachSession() {} } } },
    sessionController: {},
    permissionPresets: { set() {}, current: () => 'workspace-write' },
    sessionTitle: { rename() {} },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? services.tools : services[name]),
    effect(fn) { fn(); return () => {} },
    interval() { return () => {} },
  }
  mod.default.apply(ctx)
  return {
    // Тик делает много всего поверх поддельных сервисов GitHub, и падение шага
    // после синхронизации — не то, что здесь проверяется: кеш пишется раньше, а
    // причина падения к делу не относится.
    async tick() {
      try {
        await tools.find((tool) => tool.name === 'dev_department_tick').execute({})
      } catch (error) {
        // намеренно: см. выше
      }
    },
    status: async () => JSON.parse(await tools.find((tool) => tool.name === 'dev_department_status').execute({})),
  }
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
function includes(name, actual, needle) {
  const ok = String(actual || '').includes(needle)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось «' + needle + '»)'))
}
const readCache = () => JSON.parse(fs.readFileSync(projectsFile, 'utf8'))
const cacheDepartment = () => readCache().projects[0].departments[0]

console.log('=== удачный ответ: кеш обновлён, локальные ключи целы ===')
let app = await boot()
await app.tick()
let status = await app.status()
check('запрос к вебу был', requests > 0, true)
check('проект пришёл из веба', readCache().projects[0].title, 'Вахта из веба')
check('repo тоже из веба', cacheDepartment().repo, 'gidvantus/vahta')
check('расписание из веба', cacheDepartment().windows, [{ start: '13:00', stop: '04:00' }])
check('порт остался локальным', [cacheDepartment().frontendPort, cacheDepartment().apiPort], [8095, 8096])
check('бот остался локальным', cacheDepartment().telegram, { token: 'bot-token', chatId: 1 })
check('areas остались локальными', cacheDepartment().areas, { backend: ['backend/'], frontend: ['frontend/'] })
check('default остался локальным', readCache().default, 'vahta')
check('синхронизация отмечена удачной', status.registrySync.ok, true)
check('ревизия — короткий отпечаток', /^[0-9a-f]{12}$/.test(status.registrySync.revision), true)
check('локальные ключи названы в статусе', status.registrySync.localKeys.includes('vahta.departments[development].telegram'), true)
check('ошибки нет', status.registrySync.error, null)
check('токен в статус не попал', JSON.stringify(status).includes(TOKEN), false)
check('и адрес ручки виден', status.registrySync.url, apiUrl)

console.log('\n=== тот же документ второй раз: файл не переписывается ===')
const changedAt = status.registrySync.changedAt
const fetchedAt = status.registrySync.fetchedAt
await app.tick()
status = await app.status()
check('время изменения файла то же', status.registrySync.changedAt, changedAt)
check('а время удачного ответа новое', status.registrySync.fetchedAt !== fetchedAt, true)
check('при этом синхронизация снова удачна', status.registrySync.ok, true)

console.log('\n=== документ не совпал по id: локальные ключи не теряются, кеш не переписан ===')
// Ровно инцидент из постановки #63: в вебе коды проектов не заполнены, и `id`
// приходит числовым, а файл держится на слагах. Склейка по `id` не совпадёт —
// писать такой документ поверх файла нельзя, иначе пропадут telegram, порты,
// areas, `enabled: false` и второе окно смены.
const beforeLost = fs.readFileSync(projectsFile, 'utf8')
mode = {
  kind: 'ok',
  status: 200,
  body: {
    version: 2,
    projects: [
      {
        id: '1',
        title: 'Вахта',
        departments: [{ kind: 'development', repo: WORKSPACE, base: 'main', workspace: WORKSPACE, windows: [{ start: '13:00', stop: '04:00' }] }],
      },
    ],
  },
}
await app.tick()
status = await app.status()
check('успех снят', status.registrySync.ok, false)
check('файл байт в байт прежний', fs.readFileSync(projectsFile, 'utf8') === beforeLost, true)
includes('причина названа словами постановки', status.registrySync.error, 'реестр из веба: не совпали проекты — ')
includes('в причине назван проект', status.registrySync.error, 'vahta')
includes('в причине названы ключи', status.registrySync.error, 'vahta.title')
includes('перечень ключей укорочен многоточием', status.registrySync.error, '…; кеш не переписан')
includes('и сказано, что кеш не переписан', status.registrySync.error, 'кеш не переписан')
check('lost в статусе — массив', Array.isArray(status.registrySync.lost), true)
check('lost называет проект', status.registrySync.lost.map((item) => item.id), ['vahta'])
check('lost называет его ключи', status.registrySync.lost[0].keys.includes('vahta.departments[development].telegram'), true)
check('и виды отделов', status.registrySync.lost[0].departments, ['development'])
check('droppedProjects тоже названы', status.registrySync.droppedProjects, ['vahta'])
check('ревизия прошлой удачи не забыта', /^[0-9a-f]{12}$/.test(status.registrySync.revision), true)
check('кеш всё равно обслуживается', status.registry.serving, ['vahta'])
check('порт из кеша на месте', cacheDepartment().frontendPort, 8095)

// Коды заполнили — id совпали, и запись возобновляется: защита блокирует только
// потерю, а не синхронизацию вообще.
mode = { kind: 'ok', status: 200, body: webDocument('gidvantus/vahta') }
await app.tick()
status = await app.status()
check('id совпали — синхронизация снова удачна', status.registrySync.ok, true)
check('lost очищен', status.registrySync.lost, [])
check('проект снова из веба', cacheDepartment().repo, 'gidvantus/vahta')

console.log('\n=== флаг работы отдела: пришёл из веба и локальным не стал ===')
// С #65 флаг живёт в базе веба (`departments.enabled`): документ API приносит его и
// перекрывает файл, а в `localKeys` записи про `enabled` быть не должно — иначе
// человек решил бы, что флаг по-прежнему правится в файле руками.
const withEnabled = localDocument()
withEnabled.projects[0].departments[0].enabled = true
fs.writeFileSync(projectsFile, JSON.stringify(withEnabled, null, 2))
mode = {
  kind: 'ok',
  status: 200,
  body: {
    version: 2,
    projects: [
      {
        id: 'vahta',
        title: 'Вахта из веба',
        departments: [
          {
            kind: 'development',
            repo: 'gidvantus/vahta',
            base: 'main',
            workspace: WORKSPACE,
            windows: [{ start: '13:00', stop: '04:00' }],
            enabled: false,
          },
        ],
      },
    ],
  },
}
await app.tick()
status = await app.status()
check('выключение из веба доехало в кеш', cacheDepartment().enabled, false)
check(
  'про `enabled` в локальных ключах не говорят',
  status.registrySync.localKeys.some((key) => key.endsWith('.enabled')),
  false,
)
check('проект остался в кеше', readCache().projects[0].title, 'Вахта из веба')
check('локальные ключи всё ещё названы', cacheDepartment().frontendPort, 8095)
// Выключенный отдел диспетчер не обслуживает: проект уходит из `serving`, кеш при этом
// цел. Смена на прошлом кеше не продолжается — флаг доехал до отбора проектов.
check('выключенный проект не обслуживается', status.registry.serving, [])
check('и назван выключенным', status.registry.disabled, ['vahta'])
// Возврат в норму: включённый отдел снова обслуживается, и снова по документу веба.
mode = {
  kind: 'ok',
  status: 200,
  body: {
    version: 2,
    projects: [
      {
        id: 'vahta',
        title: 'Вахта из веба',
        departments: [
          {
            kind: 'development',
            repo: 'gidvantus/vahta',
            base: 'main',
            workspace: WORKSPACE,
            windows: [{ start: '13:00', stop: '04:00' }],
            enabled: true,
          },
        ],
      },
    ],
  },
}
await app.tick()
status = await app.status()
check('включили — проект снова обслуживается', status.registry.serving, ['vahta'])
check('и выключенных нет', status.registry.disabled, [])
check('флаг в кеше — из веба', cacheDepartment().enabled, true)

console.log('\n=== 401: кеш не тронут ===')
mode = { kind: 'status', status: 401 }
const beforeDenied = fs.readFileSync(projectsFile, 'utf8')
await app.tick()
status = await app.status()
check('ответ сервера назван 401', /токен реестра не принят/.test(status.registrySync.error || ''), true)
check('успех снят', status.registrySync.ok, false)
check('файл байт в байт прежний', fs.readFileSync(projectsFile, 'utf8') === beforeDenied, true)
check('и ревизия прошлой удачи не забыта', /^[0-9a-f]{12}$/.test(status.registrySync.revision), true)

console.log('\n=== 404: реестр ещё не собран ===')
mode = { kind: 'status', status: 404 }
await app.tick()
status = await app.status()
includes('404 назван словами', status.registrySync.error, 'реестр ещё не собран')
check('файл прежний', fs.readFileSync(projectsFile, 'utf8') === beforeDenied, true)

console.log('\n=== битый JSON: кеш не тронут ===')
mode = { kind: 'broken' }
await app.tick()
status = await app.status()
includes('битый ответ назван', status.registrySync.error, 'ответ не JSON')
check('файл прежний', fs.readFileSync(projectsFile, 'utf8') === beforeDenied, true)

console.log('\n=== чужой формат: документ веба не v2 ===')
mode = { kind: 'ok', status: 200, body: { version: 1, projects: { vahta: {} } } }
await app.tick()
status = await app.status()
includes('версия названа и указан конвертер', status.registrySync.error, 'registry-v1-to-v2.mjs')
check('файл прежний', fs.readFileSync(projectsFile, 'utf8') === beforeDenied, true)

console.log('\n=== сервер мёртв: смена продолжается на прошлом кеше ===')
await new Promise((resolve) => server.close(resolve))
await app.tick()
status = await app.status()
includes('причина названа', status.registrySync.error, 'реестр из веба')
check('успех снят', status.registrySync.ok, false)
check('файл прежний', fs.readFileSync(projectsFile, 'utf8') === beforeDenied, true)
check('кеш всё равно обслуживается', status.registry.serving, ['vahta'])

console.log('\n=== нет блока registry в общих настройках: синхронизации нет вовсе ===')
writeConfig(null)
const beforeNoSync = fs.readFileSync(projectsFile, 'utf8')
app = await boot()
await app.tick()
status = await app.status()
check('адреса нет', status.registrySync.url, null)
check('синхронизация не удалась', status.registrySync.ok, false)
check('и файл никто не трогал', fs.readFileSync(projectsFile, 'utf8') === beforeNoSync, true)
check('проект всё равно обслуживается из файла', status.registry.serving, ['vahta'])

fs.rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
process.exit(failures === 0 ? 0 : 1)
