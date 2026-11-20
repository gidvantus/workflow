// Реестр проектов версии 2: разбор документа, склейка с локальными ключами,
// запись кеша и конвертер из версии 1.
//
// Набор проверяет модуль, а не диспетчер: у формы документа один владелец
// (`plugins/registry.mjs`), и расхождение его правил с ожиданиями диспетчера,
// моста Telegram и инструментов ловится здесь, до дорогих интеграционных наборов.
// Запуск: node plugins/tools/tests/registry.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as pluginPaths from '../plugin-paths.mjs'

const registry = await pluginPaths.registryModule()
const repoRoot = pluginPaths.REPO_ROOT

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

// Песочница — во временном каталоге: здесь проверяются записи файлов, и ни один
// прогон не должен трогать настоящий реестр человека.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'))

const good = () => ({
  version: 2,
  default: 'vahta',
  projects: [
    {
      id: 'vahta',
      title: 'Вахта',
      departments: [
        {
          kind: 'development',
          repo: 'gidvantus/vahta',
          base: 'develop-m',
          workspace: 'D:\\Agents\\Vahta',
          humanClone: 'D:\\Development\\VideCoding\\Vahta',
          frontendPort: 8095,
          apiPort: 8096,
          telegram: { token: 't', chatId: 1 },
          windows: [{ start: '13:00', stop: '04:00' }],
        },
        { kind: 'marketing', title: 'Маркетинг' },
      ],
    },
    { id: 'brain', title: 'Brain', departments: [{ kind: 'marketing' }] },
  ],
})

console.log('=== разбор документа версии 2 ===')
const parsed = registry.parseRegistry(good())
check('годный документ без проблем', [parsed.problems, parsed.fatal], [[], null])
check('проекты на месте', registry.projectsOf(parsed.document).map((p) => p.id), ['vahta', 'brain'])
check('title по умолчанию равен id', registry.parseRegistry({ version: 2, projects: [{ id: 'x', departments: [{ kind: 'development' }] }] }).document.projects[0].title, 'x')
check('отдел разработки найден', registry.developmentOf(parsed.document.projects[0]).department.repo, 'gidvantus/vahta')
check('проект без отдела разработки — не наша забота и без проблемы', registry.developmentOf(parsed.document.projects[1]), { department: null, problem: null })

console.log('\n=== что документ отвергает ===')
includes('не объект', registry.parseRegistry([]).fatal, 'в файле не объект')
includes('версия 1 названа и указан конвертер', registry.parseRegistry({ version: 1, projects: {} }).fatal, 'переведите файл конвертером plugins/tools/registry-v1-to-v2.mjs')
includes('версия без числа', registry.parseRegistry({ projects: [] }).fatal, 'версия реестра не указана')
includes('пустой projects', registry.parseRegistry({ version: 2, projects: [] }).fatal, 'реестр пуст')
includes('нет ни одного годного проекта', registry.parseRegistry({ version: 2, projects: [{ id: '' }] }).fatal, 'нет ни одного годного проекта')
const noId = registry.parseRegistry({ version: 2, projects: [{ id: '', departments: [{ kind: 'development' }] }] })
includes('проект без id назван', noId.problems[0], 'не задан id')
const dupId = registry.parseRegistry({
  version: 2,
  projects: [{ id: 'a', departments: [{ kind: 'development' }] }, { id: 'a', departments: [{ kind: 'development' }] }],
})
includes('повтор id назван', dupId.problems[0], 'id повторяется')
const noDepartments = registry.parseRegistry({ version: 2, projects: [{ id: 'a' }] })
includes('проект без отделов назван', noDepartments.problems[0], 'не задано ни одного отдела')
const noKind = registry.parseRegistry({ version: 2, projects: [{ id: 'a', departments: [{ repo: 'o/a' }, { kind: 'development' }] }] })
includes('отдел без kind назван', noKind.problems[0], 'не задан вид отдела')
check('и остальные отделы проекта уцелели', noKind.document.projects[0].departments.map((d) => d.kind), ['development'])
const dupDev = registry.parseRegistry({
  version: 2,
  projects: [{ id: 'a', departments: [{ kind: 'development' }, { kind: 'development' }] }],
})
check('два отдела разработки — проект пропущен', registry.developmentOf(dupDev.document.projects[0]).department, null)
includes('и причина названа', registry.developmentOf(dupDev.document.projects[0]).problem, 'больше одного')
const unknownDefault = registry.parseRegistry({ version: 2, default: 'nope', projects: [{ id: 'a', departments: [{ kind: 'development' }] }] })
includes('default на неизвестный проект назван', unknownDefault.problems[0], 'default указывает на неизвестный проект')
check('но документ остаётся годным', unknownDefault.fatal, null)

console.log('\n=== поля проекта в прежней внутренней форме ===')
const fields = registry.projectFields(parsed.document.projects[0])
check('repo и base из отдела', [fields.repo, fields.base], ['gidvantus/vahta', 'develop-m'])
check('порты из отдела', [fields.frontendPort, fields.apiPort], [8095, 8096])
check('человеческие каталоги', [fields.workspace, fields.humanClone], ['D:\\Agents\\Vahta', 'D:\\Development\\VideCoding\\Vahta'])
check('бот собран', fields.telegram, { token: 't', chatId: 1 })
const bare = registry.projectFields({ id: 'x', departments: [{ kind: 'development' }] })
check('base и порты по умолчанию', [bare.base, bare.frontendPort, bare.apiPort], ['main', 8080, 8001])
check('composeProject по умолчанию равен id', bare.composeProject, 'x')
check('половина бота — бота нет', registry.projectFields({ id: 'x', departments: [{ kind: 'development', telegram: { token: 't', chatId: 0 } }] }).telegram, undefined)
check('корни проекта — рабочая копия и клон', registry.projectRoots(parsed.document.projects[0]), ['D:\\Agents\\Vahta', 'D:\\Development\\VideCoding\\Vahta'])

console.log('\n=== поиск проекта по рабочей области ===')
const nested = {
  version: 2,
  projects: [
    { id: 'root', departments: [{ kind: 'development', workspace: 'D:\\Agents' }] },
    { id: 'vahta', departments: [{ kind: 'development', workspace: 'D:\\Agents\\Vahta' }] },
    { id: 'human', departments: [{ kind: 'development', workspace: 'D:\\Agents\\Brain', humanClone: 'D:\\Development\\VideCoding\\Brain' }] },
  ],
}
// Поиск по корням — одна реализация на отдел: её же зовёт мост Telegram со своей
// формой проекта (`roots`), поэтому проверяем на документе и его корнях.
const find = (workspace) => {
  const project = registry.findProjectByRoots(registry.projectsOf(nested), registry.projectRoots, workspace)
  return project ? project.id : null
}
check('точное совпадение', find('D:\\Agents\\Vahta'), 'vahta')
check('другая раскладка слэшей и регистр', find('d:/agents/vahta/'), 'vahta')
check('вложенный путь принадлежит проекту', find('D:\\Agents\\Vahta\\backend'), 'vahta')
check('самая длинная подошедшая область', find('D:\\Agents\\VahtaX'), 'root')
check('клон человека — тот же проект', find('D:\\Development\\VideCoding\\Brain'), 'human')
check('чужой путь не находится', find('D:\\Other'), null)
check('пустой путь не находится', find(''), null)

console.log('\n=== склейка: локальные ключи не пропадают ===')
// API отдаёт проект и отдел без ключей, которых в базе нет; локальный файл их
// держит. Из веба удалён проект `gone` — склеить его ключи некуда, и об этом
// надо сказать, а не молча выбросить.
const fromApi = {
  version: 2,
  projects: [
    {
      id: 'vahta',
      title: 'Вахта',
      departments: [
        {
          kind: 'development',
          repo: 'gidvantus/vahta',
          base: 'main',
          workspace: 'D:\\Agents\\Vahta',
          windows: [{ start: '13:00', stop: '04:00' }],
        },
      ],
    },
  ],
}
const local = {
  version: 2,
  default: 'vahta',
  projects: [
    {
      id: 'vahta',
      title: 'Вахта',
      note: 'человеческая пометка',
      departments: [
        {
          kind: 'development',
          repo: 'gidvantus/vahta',
          base: 'develop-m',
          frontendPort: 8095,
          apiPort: 8096,
          areas: { backend: ['backend/'], frontend: ['frontend/'] },
          labels: { dev: 'ready-for-dev' },
          telegram: { token: 't', chatId: 1 },
          windows: [{ start: '07:00', stop: '09:00' }],
        },
      ],
    },
    { id: 'gone', departments: [{ kind: 'development', telegram: { token: 'old', chatId: 2 } }] },
  ],
}
const merged = registry.overlay(fromApi, local)
check('default из файла сохранён', merged.document.default, 'vahta')
check('порт, areas, labels и telegram сохранены', [
  merged.document.projects[0].departments[0].frontendPort,
  merged.document.projects[0].departments[0].apiPort,
  merged.document.projects[0].departments[0].areas,
  merged.document.projects[0].departments[0].labels,
  merged.document.projects[0].departments[0].telegram,
], [8095, 8096, { backend: ['backend/'], frontend: ['frontend/'] }, { dev: 'ready-for-dev' }, { token: 't', chatId: 1 }])
check('поле проекта, которого нет в вебе, сохранено', merged.document.projects[0].note, 'человеческая пометка')
check('поле, которое API отдал, взято из веба (base)', merged.document.projects[0].departments[0].base, 'main')
check('расписание тоже из веба', merged.document.projects[0].departments[0].windows, [{ start: '13:00', stop: '04:00' }])
check('удалённый в вебе проект не воскрес', registry.projectsOf(merged.document).map((p) => p.id), ['vahta'])
check('и назван потерянным', merged.droppedProjects, ['gone'])
check('локальные ключи перечислены', merged.localKeys.slice().sort(), [
  'default',
  'vahta.departments[development].apiPort',
  'vahta.departments[development].areas',
  'vahta.departments[development].frontendPort',
  'vahta.departments[development].labels',
  'vahta.departments[development].telegram',
  'vahta.note',
].sort())
check('документ API не испорчен склейкой', fromApi.projects[0].departments[0].frontendPort, undefined)
check('файла нет — склеивать не с чем', registry.overlay(fromApi, null).localKeys, [])

console.log('\n=== запись кеша ===')
const cacheFile = path.join(sandbox, 'state', 'projects.json')
const first = registry.writeRegistryFile(cacheFile, fromApi)
check('первая запись сделана', first.changed, true)
check('бэкапа ещё нет', fs.existsSync(cacheFile + '.bak'), false)
const second = registry.writeRegistryFile(cacheFile, fromApi)
check('то же содержимое не переписывается', second.changed, false)
const third = registry.writeRegistryFile(cacheFile, merged.document)
check('изменённое содержимое переписано', third.changed, true)
check('в бэкапе ровно прошлая версия', JSON.parse(fs.readFileSync(cacheFile + '.bak', 'utf8')).projects[0].departments[0].frontendPort, undefined)
check('временных файлов не осталось', fs.readdirSync(path.dirname(cacheFile)).sort(), ['projects.json', 'projects.json.bak'])
check('прочитанный файл — это записанный документ', registry.readRegistryFile(cacheFile).document.projects[0].departments[0].apiPort, 8096)

console.log('\n=== чтение файла ===')
const brokenFile = path.join(sandbox, 'broken.json')
fs.writeFileSync(brokenFile, '{ это не json')
try {
  registry.readRegistryFile(brokenFile)
  check('битый JSON отвергнут', false, true)
} catch (error) {
  includes('битый JSON назван с путём', error.message, 'не читается реестр проектов')
}
const oldFile = path.join(sandbox, 'old.json')
fs.writeFileSync(oldFile, JSON.stringify({ version: 1, default: 'a', projects: { a: {} } }))
try {
  registry.readRegistryFile(oldFile)
  check('файл версии 1 отвергнут', false, true)
} catch (error) {
  includes('и назван конвертер', error.message, 'registry-v1-to-v2.mjs')
}

console.log('\n=== перевод версии 1 в версию 2 ===')
const legacy = {
  version: 1,
  default: 'vahta',
  projects: {
    vahta: {
      title: 'Вахта',
      repo: 'gidvantus/vahta',
      base: 'develop-m',
      workspace: 'D:\\Agents\\Vahta',
      humanClone: 'D:\\Development\\VideCoding\\Vahta',
      composeProject: 'vahta-agent',
      areas: { backend: ['operator/backend'], frontend: ['operator/frontend'] },
      department: { enabled: true, windows: [{ start: '13:00', stop: '04:00' }], maxRework: 3 },
      telegram: { token: 't', chatId: 1 },
    },
  },
}
const converted = registry.convertLegacyDocument(legacy)
check('перевод без проблем', converted.problems, [])
check('проект стал массивом с одним отделом', converted.document.projects[0].departments.map((d) => d.kind), ['development'])
const department = converted.document.projects[0].departments[0]
check('адреса переехали в отдел', [department.repo, department.base, department.workspace, department.composeProject], ['gidvantus/vahta', 'develop-m', 'D:\\Agents\\Vahta', 'vahta-agent'])
check('enabled и расписание переехали из department', [department.enabled, department.windows, department.maxRework], [true, [{ start: '13:00', stop: '04:00' }], 3])
check('telegram переехал на отдел', department.telegram, { token: 't', chatId: 1 })
check('areas переехали на отдел', department.areas, { backend: ['operator/backend'], frontend: ['operator/frontend'] })
check('default сохранён', converted.document.default, 'vahta')
check('переведённый документ проходит разбор', registry.parseRegistry(converted.document).fatal, null)
check('перевод идемпотентен: версия 2 не переводится', registry.convertLegacyDocument(converted.document).alreadyV2, true)
const withJunk = registry.convertLegacyDocument({ version: 1, projects: { a: { repo: 'o/a', mystery: 1, department: { ghost: true } } } })
check('неизвестные поля названы, а не потеряны молча', withJunk.problems.length >= 2, true)

console.log('\n=== конвертер как команда ===')
const home = path.join(sandbox, 'home')
const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
const homeFile = path.join(stateDir, 'projects.json')
fs.writeFileSync(homeFile, JSON.stringify(legacy, null, 2))
const converter = path.join(repoRoot, 'plugins', 'tools', 'registry-v1-to-v2.mjs')
const run = (...args) => spawnSync(process.execPath, [converter, '--dsh-home', home, ...args], { encoding: 'utf8' })
const dry = run()
check('предпросмотр прошёл', dry.status, 0)
includes('и сказал, что файл не изменён', dry.stdout + dry.err, 'предпросмотр')
check('предпросмотр не тронул файл', JSON.parse(fs.readFileSync(homeFile, 'utf8')).version, 1)
check('токен в предпросмотр не попал', dry.stdout.includes('"token": "t"'), false)
const written = run('--write')
check('запись прошла', written.status, 0)
check('файл стал версией 2', JSON.parse(fs.readFileSync(homeFile, 'utf8')).version, 2)
check('бэкап рядом', JSON.parse(fs.readFileSync(homeFile + '.bak', 'utf8')).version, 1)
const again = run('--write')
check('повторный запуск — успех', again.status, 0)
includes('и «уже вторая версия»', again.stdout, 'уже вторая версия')

fs.rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : 'ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
process.exit(failures === 0 ? 0 : 1)
