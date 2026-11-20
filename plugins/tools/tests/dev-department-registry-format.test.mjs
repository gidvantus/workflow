// Форма файла реестра не должна молча останавливать отдел (issue #58).
//
// 20.11.2026 файл реестра перевели в форму, которой установленный пакет не
// понимал. Отдел перестал обслуживать все проекты: `step()` возвращал
// `config-error`, `dev_department_status` показывал `registry.serving: []`, и
// заметить это можно было только ручным вызовом инструмента — отдел простоял
// около трёх часов. Проверяется ровно то, чего тогда не хватило:
//
//   • файл в форме, которую читает установленный пакет, обслуживает проекты как
//     раньше;
//   • файл в чужой форме называет причину словами (путь к файлу, найденная версия,
//     что делать) и даёт `registry.serving: []`;
//   • битый JSON по-прежнему даёт прежний текст отказа;
//   • ноль обслуживаемых проектов с названной причиной — один блок `🛑` в журнале
//     смены и одна отправка в Telegram, второй тик в пределах 30 минут не
//     повторяет ни журнал, ни отправку;
//   • у проекта по умолчанию нет бота — тревога остаётся в журнале, а
//     `registry.alarm.channel` говорит `log`;
//   • возврат в норму — одно `✅` и повторное включение обслуживания.
//
// Ни одна проверка не касается настоящего каталога состояния: поддельный
// `DSH_HOME` создаётся в каталоге набора. Боевой модуль ищется помощником
// `plugin-paths.mjs` ДО подмены `DSH_HOME` — иначе набор проверял бы не тот файл.
//
// Запуск: node plugins/tools/tests/dev-department-registry-format.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import * as pluginPaths from '../plugin-paths.mjs'

// Боевой модуль читается до подмены DSH_HOME: тестируется исходник рядом с набором.
const pluginFile = pluginPaths.pluginFile('dev-department')

const home = path.join(process.cwd(), '.dev-department-registry-format-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })

const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'dev-department.json'), JSON.stringify({
  windows: [{ start: '00:00', stop: '23:59' }],
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, null, 2))

const WORKSPACE = path.join(home, 'workspace')
fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true })

const PROJECTS_FILE = path.join(stateDir, 'projects.json')
const LOG_FILE = path.join(stateDir, 'dev-department.log')

// Бот проекта по умолчанию: он же — канал тревоги, когда реестр не читается.
const BOT = { token: 'token-registry-format', chatId: '777' }

// Форма, которую читает установленный пакет: документ v2 с отделом development.
function writeV2(options = {}) {
  const department = {
    kind: 'development',
    kind: options.kind || 'development',
    enabled: options.enabled !== false,
    repo: 'gidvantus/vahta',
    base: 'develop-m',
    workspace: options.workspace || WORKSPACE,
    composeProject: 'vahta-agent',
  }
  if (options.bot !== false) department.telegram = BOT
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    version: 2,
    default: 'vahta',
    projects: [{ id: 'vahta', title: 'Тест', departments: [department] }],
  }, null, 2))
}

// Чужая форма: документ v1, где поля отдела лежали в записи проекта. Такой файл
// установленный пакет не читает — и именно на нём отдел обязан заговорить.
function writeV1(options = {}) {
  const project = {
    title: 'Тест',
    repo: 'gidvantus/vahta',
    base: 'develop-m',
    workspace: WORKSPACE,
    composeProject: 'vahta-agent',
    department: { enabled: true, windows: [{ start: '00:00', stop: '23:59' }] },
  }
  if (options.bot !== false) project.telegram = BOT
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    version: 1,
    default: 'vahta',
    projects: { vahta: project },
  }, null, 2))
}

writeV2()
process.env.DSH_HOME = home

// ── поддельные часы: троттлинг тревоги проверяется сдвигом времени ──────────
const RealDate = Date
let clock = new RealDate('2026-11-20T13:05:00+03:00').getTime()
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(clock); else super(...args) }
  static now() { return clock }
}
globalThis.Date = FakeDate
const advance = (ms) => { clock += ms }
const MINUTE = 60 * 1000

// ── поддельная сеть: единственный внешний канал тревоги — Telegram ──────────
const telegram = []
https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    process.nextTick(() => {
      let answer
      if (options.host === 'api.telegram.org') {
        telegram.push(JSON.parse(payload).text)
        answer = { statusCode: 200, body: '{"ok":true}' }
      } else {
        answer = { statusCode: 500, body: '{"message":"неожиданный HTTP: тревога ходит только в Telegram"}' }
      }
      const res = {
        statusCode: answer.statusCode,
        on(event, fn) {
          if (event === 'data') fn(answer.body)
          if (event === 'end') process.nextTick(fn)
          return res
        },
      }
      callback(res)
    })
  },
})

// ── поддельный MCP-сервер GitHub ────────────────────────────────────────────
// Диспетчер ходит в GitHub только по MCP. Заглушка нужна, чтобы `status` не
// поднимал настоящий сервер: сценарии про форму реестра GitHub не касаются, и
// пустой список задач — честный ответ «в конвейере ничего нет».
const { createRequire, syncBuiltinESMExports } = await import('node:module')
const requireCjs = createRequire(import.meta.url)
const childProcess = requireCjs('node:child_process')
childProcess.spawn = () => {
  const stdoutHandlers = []
  const child = {
    stdout: {
      setEncoding() {},
      on(event, fn) { if (event === 'data') stdoutHandlers.push(fn) },
    },
    stderr: { setEncoding() {}, on() {} },
    stdin: {
      writable: true,
      write(line) {
        let message
        try { message = JSON.parse(line) } catch (error) { return }
        setImmediate(() => {
          let answer
          if (message.method === 'initialize') {
            answer = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-github-mcp', version: '0.0.0' } } }
          } else if (message.method === 'tools/call') {
            const name = message.params.name
            const payload = name === 'list_issues'
              ? { issues: [], totalCount: 0, pageInfo: { hasNextPage: false } }
              : {}
            answer = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } }
          } else {
            return
          }
          for (const handler of stdoutHandlers) handler(JSON.stringify(answer) + '\n')
        })
        return true
      },
    },
    on() { return child },
    kill() {},
  }
  return child
}
syncBuiltinESMExports()

// ── поддельные сервисы DSH: модулю нужны они, а не работа конвейера ─────────
const services = {
  timer: {},
  tools: { register() {} },
  agents: { async create() {}, get: () => undefined },
  sessions: { get: () => undefined },
  agentPresets: { async mount() {} },
  workspaceRegistry: {
    async resolveByPath() { return undefined },
    async create(p) { return { path: p, title: 'Тест — отдел' } },
  },
  sessionController: {
    async list() { return { items: [] } },
    async inspect() { throw new Error('session/not-found') },
    async prompt() { return { accepted: true } },
    async cancel() { return { accepted: true } },
    follow() { return (async function* empty() {})() },
  },
  permissionPresets: { set() {}, current: () => 'workspace-write' },
  sessionTitle: { rename() {} },
}

async function boot() {
  const mod = await import('file:///' + pluginFile.replace(/\\/g, '/') + '?registry-format')
  const localTools = []
  const localCtx = {
    get: (n) => (n === 'tools' ? { register(t) { localTools.push(t) } } : services[n]),
    effect(fn) { fn(); return () => {} },
    interval() { return () => {} },
  }
  mod.default.apply(localCtx)
  return {
    tick: async () => JSON.parse(await localTools.find((t) => t.name === 'dev_department_tick').execute({})),
    status: async () => JSON.parse(await localTools.find((t) => t.name === 'dev_department_status').execute({})),
  }
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
// Блоки тревоги в журнале смены: заголовок тревоги встречается один раз на блок.
const alarmBlocks = () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '').split('🛑 Отдел разработки: не обслуживается ни один проект').length - 1
const logText = () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '')
// Последний блок тревоги: по нему видно, какую подсказку получил человек.
const lastAlarmBlock = () => {
  const text = logText()
  const at = text.lastIndexOf('🛑 Отдел разработки: не обслуживается ни один проект')
  return at < 0 ? '' : text.slice(at)
}

const app = await boot()

console.log('=== сценарий 1: файл в форме установленного пакета обслуживает проекты ===')
let status = await app.status()
check('проект обслуживается', status.registry.serving, ['vahta'])
check('причины нет', status.registry.problem, null)
check('тревоги нет', status.registry.alarm, { active: false, since: null, lastSentAt: null, channel: null })
check('журнал тревог пуст', alarmBlocks(), 0)
check('Telegram молчит', telegram.length, 0)

console.log('\n=== сценарий 2: файл в чужой форме называет причину и будит человека ===')
writeV1()
advance(MINUTE)
let step = await app.tick()
check('тик вернул config-error', step.result.action, 'config-error')
check('причина названа в отчёте тика', String(step.result.note).includes(PROJECTS_FILE), true)
check('тревога попала в отчёт тика', String(step.result.alarm || '').startsWith('🛑 Отдел разработки: не обслуживается ни один проект'), true)
check('в журнале один блок тревоги', alarmBlocks(), 1)
check('в блоке названа найденная версия', logText().includes('версия реестра 1'), true)
check('в блоке сказано, что поддерживается', logText().includes('поддерживается только 2'), true)
check('в блоке абсолютный путь к файлу', logText().includes('Причина: ' + PROJECTS_FILE), true)
check('в блоке сказано, чем помочь', logText().includes('projects.json в каталоге состояния отдела'), true)
check('в блоке сказано про .bak', logText().includes('projects.json.bak'), true)
check('подсказка про форму — в блоке последней тревоги', lastAlarmBlock().includes('projects.json.bak'), true)
check('одна отправка в Telegram', telegram.length, 1)
check('отправлено то же, что в журнале', telegram[0].includes('Причина: ' + PROJECTS_FILE), true)

status = await app.status()
check('serving пуст', status.registry.serving, [])
check('problem назван', String(status.registry.problem).includes('версия реестра 1'), true)
check('тревога активна', status.registry.alarm.active, true)
check('канал тревоги — Telegram', status.registry.alarm.channel, 'telegram')
check('since записан', typeof status.registry.alarm.since, 'string')
check('lastSentAt записан', typeof status.registry.alarm.lastSentAt, 'string')
check('status не повторил ни журнал, ни отправку', [alarmBlocks(), telegram.length], [1, 1])

console.log('\n=== сценарий 3: второй тик в пределах 30 минут молчит ===')
advance(5 * MINUTE)
step = await app.tick()
check('тик всё ещё config-error', step.result.action, 'config-error')
check('повторной тревоги в отчёте нет', step.result.alarm, null)
check('журнал не вырос', alarmBlocks(), 1)
check('Telegram не вырос', telegram.length, 1)

console.log('\n=== сценарий 4: через 30 минут тревога повторяется ===')
advance(31 * MINUTE)
step = await app.tick()
check('тик всё ещё config-error', step.result.action, 'config-error')
check('в журнале второй блок', alarmBlocks(), 2)
check('вторая отправка', telegram.length, 2)

console.log('\n=== сценарий 5: битый JSON — прежний текст отказа ===')
fs.writeFileSync(PROJECTS_FILE, '{\n  "version": 2,\n')
advance(MINUTE)
step = await app.tick()
check('тик вернул config-error', step.result.action, 'config-error')
check('прежний текст отказа', String(step.result.note).includes('не читается реестр проектов'), true)
check('в тексте путь к файлу', String(step.result.note).includes(PROJECTS_FILE), true)
check('в журнале сказано про нечитаемый файл', logText().includes('не читается реестр проектов'), true)
check('смена причины — сразу новый блок в журнале', alarmBlocks(), 3)
// Файл не разобран — значит не разобран и бот проекта по умолчанию: сказать в
// Telegram некого, и тревога честно остаётся в журнале.
check('в Telegram не ушло', telegram.length, 2)
status = await app.status()
check('канал тревоги — журнал', status.registry.alarm.channel, 'log')

console.log('\n=== сценарий 6: у проекта по умолчанию нет бота — тревога в журнале ===')
// Рабочей области нет: проект пропускается с названной причиной, обслуживать
// нечего, а бота в реестре нет — сказать в Telegram некого.
writeV2({ workspace: path.join(home, 'нет-такой-области'), bot: false })
advance(MINUTE)
step = await app.tick()
check('тик вернул config-error', step.result.action, 'config-error')
check('причина названа', String(step.result.note).includes('не существует'), true)
check('в журнале блок тревоги', alarmBlocks(), 4)
// Причина не про файл: совет искать `.bak` увёл бы человека восстанавливать
// реестр поверх целого — в таком блоке остаётся только нейтральная подсказка.
check('подсказка про .bak не приклеена к чужой причине', lastAlarmBlock().includes('projects.json.bak'), false)
check('нейтральная подсказка на месте', lastAlarmBlock().includes('Проверьте projects.json в каталоге состояния отдела.'), true)
check('в Telegram ничего не ушло', telegram.length, 2)
status = await app.status()
check('канал тревоги — журнал', status.registry.alarm.channel, 'log')
check('serving пуст', status.registry.serving, [])

console.log('\n=== сценарий 7: возврат в норму — одно ✅ и обслуживание снова ===')
writeV2()
advance(MINUTE)
step = await app.tick()
check('тик не config-error', step.result.action === 'config-error', false)
check('одно сообщение о возврате', telegram.length, 3)
check('текст возврата дословно', telegram[2], '✅ Отдел разработки снова обслуживает проекты: vahta')
status = await app.status()
check('проект снова обслуживается', status.registry.serving, ['vahta'])
check('причины нет', status.registry.problem, null)
check('тревога снята', status.registry.alarm.active, false)
check('since снят', status.registry.alarm.since, null)
// `lastSentAt` и `channel` — про тревогу, а не про `✅`: после возврата в статусе
// они снова пусты, иначе поле «момент последней отправки» показывало бы время
// снятой тревоги.
check('lastSentAt снят', status.registry.alarm.lastSentAt, null)
check('channel снят', status.registry.alarm.channel, null)
advance(MINUTE)
await app.tick()
await app.status()
check('повторного ✅ нет', telegram.length, 3)

console.log('\n=== сценарий 8: все отделы выключены — тревога с названной причиной ===')
// Отдел выключен в единственном проекте: `loadProjects` отдаёт `projects: []` без
// причины. Тревога всё равно должна сказать, что случилось, — иначе `active: true`
// без канала и без единого сообщения, а потом `✅` без предшествующего `🛑`.
// Вид отдела записан с хвостовым пробелом: форму и вид разбирает `registry.mjs`
// (он их обрезает), поэтому бот проекта по умолчанию обязан найтись, а канал —
// остаться `telegram`. Свой разбор формы в диспетчере этот пробел потерял бы.
writeV2({ kind: 'development ', enabled: false })
advance(MINUTE)
step = await app.tick()
check('тик вернул config-error', step.result.action, 'config-error')
check('причина названа словами', String(step.result.note).includes('нет ни одного проекта с включённым отделом'), true)
check('в журнале блок тревоги', alarmBlocks(), 5)
check('в блоке причина «отдел выключен»', lastAlarmBlock().includes('Причина: нет ни одного проекта с включённым отделом'), true)
check('подсказка про .bak не приклеена', lastAlarmBlock().includes('projects.json.bak'), false)
check('тревога ушла в Telegram', telegram.length, 4)
status = await app.status()
check('serving пуст', status.registry.serving, [])
check('причины у реестра нет', status.registry.problem, null)
check('тревога активна', status.registry.alarm.active, true)
check('канал — Telegram, хотя kind записан с пробелом', status.registry.alarm.channel, 'telegram')
check('отдел числится выключенным', status.registry.disabled, ['vahta'])

console.log('\n' + (failures === 0 ? 'ПРОВЕРКИ ПРОШЛИ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures))
process.exit(failures === 0 ? 0 : 1)
