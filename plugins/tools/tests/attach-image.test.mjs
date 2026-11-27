// Проверка инструмента attach_image: `plugins/attach-image.mjs`.
//
// Задача инструмента — заменить в комментариях роли путь к скриншоту на картинку
// GitHub. Поэтому набор проверяет три вещи, каждая из которых ломает работу молча:
//
//   1. Локальные отказы происходят ДО сети и до чтения токена. Нет файла, это
//      каталог, не картинка, больше 8 МиБ — ни одного запроса, иначе роль ждёт
//      сеть ради ошибки, которую видно на диске.
//   2. Ответ GitHub разбирается буквально: `201` → markdown ровно с `url` из
//      ответа; `422`/`404` → исключение с кодом. Придуманный адрес картинки хуже
//      честной строки «картинка не приложилась».
//   3. Проект и `repo` берутся из реестра по cwd вызывающей сессии, а не из
//      аргумента: иначе снимок роли уедет в соседний проект. Повторная загрузка в
//      тот же репозиторий не делает второй `GET /repos`.
//
// Сеть и токен подменяются: настоящий GitHub не трогается, token-файл не читается.
// Запуск: node attach-image.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import * as pluginPaths from '../plugin-paths.mjs'

// ── песочница ───────────────────────────────────────────────────────────────

const sandbox = path.join(process.cwd(), '.attach-image-home')
const originalCwd = process.cwd()
fs.rmSync(sandbox, { recursive: true, force: true })
fs.mkdirSync(sandbox, { recursive: true })
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox

const WORK_DIR = path.join(sandbox, 'work')
fs.mkdirSync(WORK_DIR, { recursive: true })
process.chdir(WORK_DIR)

// Модуль ищется помощником раскладок, как и остальные наборы: проверяется тот
// файл, который в этой раскладке работает.
const moduleFile = pluginPaths.pluginFile('attach-image', { dshHome: sandbox })
const mod = await import('file:///' + moduleFile.replace(/\\/g, '/'))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

function checkThrows(name, fn, pattern) {
  try {
    fn()
    failures += 1
    console.log('ФЕЙЛ  ' + name + ' → исключения не было')
  } catch (error) {
    const text = error && error.message ? error.message : String(error)
    const ok = pattern.test(text)
    if (!ok) failures += 1
    console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + text)
  }
}

async function checkRejects(name, fn, pattern) {
  try {
    await fn()
    failures += 1
    console.log('ФЕЙЛ  ' + name + ' → исключения не было')
  } catch (error) {
    const text = error && error.message ? error.message : String(error)
    const ok = pattern.test(text)
    if (!ok) failures += 1
    console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + text)
  }
}

// ── mime по расширению и адрес загрузки ─────────────────────────────────────

console.log('=== mime и адрес ===')
check('.png → image/png', mod.mimeForFile('shot.png'), 'image/png')
check('.JPG не важен регистр', mod.mimeForFile('SHOT.JPG'), 'image/jpeg')
check('.jpeg → image/jpeg', mod.mimeForFile('shot.jpeg'), 'image/jpeg')
check('.webp не принимается', mod.mimeForFile('shot.webp'), null)
check('.txt не принимается', mod.mimeForFile('notes.txt'), null)
check('без расширения — null', mod.mimeForFile('shot'), null)

const url = mod.userAttachmentsUrl('shot 1.png', 'image/png', 777)
check('адрес загрузки: хост и путь',
  url.startsWith('https://uploads.github.com/user-attachments/assets?'), true)
check('адрес загрузки: имя закодировано', url.includes('name=shot%201.png'), true)
check('адрес загрузки: mime', url.includes('content_type=image%2Fpng'), true)
check('адрес загрузки: repository_id', url.includes('repository_id=777'), true)
check('markdown ровно одна строка', mod.markdownFor('макет', 'https://github.com/user-attachments/assets/x'),
  '![макет](https://github.com/user-attachments/assets/x)')
check('alt по умолчанию — имя без расширения', mod.defaultAlt('C:\\tmp\\mockup-1440.png'), 'mockup-1440')

// ── локальные отказы без сети ───────────────────────────────────────────────

console.log('\n=== локальные отказы без сети ===')
const pngFile = path.join(WORK_DIR, 'shot.png')
fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const inspected = mod.inspectImageFile(pngFile)
check('обычный файл принят', [inspected.mime, inspected.name, inspected.size], ['image/png', 'shot.png', 4])

checkThrows('несуществующий путь', () => mod.inspectImageFile(path.join(WORK_DIR, 'нет.png')), /файла нет/)
checkThrows('каталог вместо файла', () => {
  const dir = path.join(WORK_DIR, 'folder.png')
  fs.mkdirSync(dir, { recursive: true })
  return mod.inspectImageFile(dir)
}, /каталог/)
const webpFile = path.join(WORK_DIR, 'shot.webp')
fs.writeFileSync(webpFile, Buffer.from([1, 2, 3]))
checkThrows('.webp', () => mod.inspectImageFile(webpFile), /не картинка/)
const hugeFile = path.join(WORK_DIR, 'huge.png')
fs.writeFileSync(hugeFile, Buffer.alloc(mod.MAX_IMAGE_BYTES + 1))
checkThrows('больше 8 МиБ', () => mod.inspectImageFile(hugeFile), /больше 8 МиБ/)

check('относительный путь считается от cwd', mod.resolveImagePath('shot.png', WORK_DIR), pngFile)
check('абсолютный путь не склеивается', mod.resolveImagePath(pngFile, 'C:\\чужое'), path.normalize(pngFile))
checkThrows('пустой путь', () => mod.resolveImagePath('', WORK_DIR), /не задан путь/)

// ── реестр: проект и repo по рабочей области ────────────────────────────────

console.log('\n=== проект и repo по cwd ===')
const registry = {
  version: 2,
  default: 'workflow',
  projects: [
    {
      id: 'workflow',
      title: 'Workflow',
      departments: [{
        kind: 'development',
        repo: 'gidvantus/workflow',
        workspace: WORK_DIR,
        humanClone: path.join(sandbox, 'human-workflow'),
      }],
    },
    {
      id: 'vahta',
      title: 'Вахта',
      departments: [{
        kind: 'development',
        repo: 'gidvantus/vahta',
        workspace: path.join(sandbox, 'vahta'),
      }],
    },
    {
      id: 'norepo',
      title: 'Без repo',
      departments: [{ kind: 'development', workspace: path.join(sandbox, 'norepo') }],
    },
  ],
}

// readProjectsDocument читает настоящий файл из каталога состояния — проверяется
// ниже, после того как реестр ляжет на диск. Здесь функции работают с документом.
check('repo проекта по рабочей области', mod.repoForWorkspace(WORK_DIR, registry), 'gidvantus/workflow')
check('repo другого проекта не подменяется',
  mod.repoForWorkspace(path.join(sandbox, 'vahta'), registry), 'gidvantus/vahta')
checkThrows('незнакомая рабочая область',
  () => mod.repoForWorkspace(path.join(sandbox, 'unknown'), registry), /не найдена в реестре/)
checkThrows('пустой repo у отдела',
  () => mod.repoForWorkspace(path.join(sandbox, 'norepo'), registry), /пустой repo/)

// ── оркестратор: сеть поддельная ────────────────────────────────────────────

console.log('\n=== загрузка с подменённой сетью ===')

function makeRequest(handlers) {
  const calls = []
  const request = async (spec) => {
    calls.push(spec)
    const key = spec.method + ' ' + String(spec.url).split('?')[0]
    const handler = handlers[key]
    if (handler === undefined) throw new Error('неожиданный запрос: ' + key)
    return typeof handler === 'function' ? handler(spec) : handler
  }
  return { calls, request }
}

const REPO_GET = 'GET https://api.github.com/repos/gidvantus/workflow'
const UPLOAD = 'POST https://uploads.github.com/user-attachments/assets'

const deps = (request, extra = {}) => ({
  cwd: WORK_DIR,
  request,
  token: 'test-token',
  readDocument: () => registry,
  cache: new Map(),
  ...extra,
})

// 1. 201 → markdown ровно с url из ответа.
let network = makeRequest({
  [REPO_GET]: { status: 200, body: JSON.stringify({ id: 777 }) },
  [UPLOAD]: { status: 201, body: JSON.stringify({ url: 'https://github.com/user-attachments/assets/uuid-1' }) },
})
let line = await mod.attachImage({ path: 'shot.png' }, deps(network.request))
check('201 → markdown ровно с url ответа', line, '![shot](https://github.com/user-attachments/assets/uuid-1)')
check('сначала GET id, потом POST файла', network.calls.map((c) => c.method), ['GET', 'POST'])
const post = network.calls[1]
check('в POST ушло имя файла и repository_id',
  [post.url.includes('name=shot.png'), post.url.includes('repository_id=777')], [true, true])
check('в POST mime заголовком и токен',
  [post.headers['Content-Type'], post.headers.Authorization], ['image/png', 'Bearer test-token'])
check('тело POST — байты файла', Buffer.isBuffer(post.body), true)

// 2. alt из аргумента.
network = makeRequest({
  [REPO_GET]: { status: 200, body: JSON.stringify({ id: 777 }) },
  [UPLOAD]: { status: 201, body: JSON.stringify({ url: 'https://github.com/user-attachments/assets/uuid-2' }) },
})
line = await mod.attachImage({ path: 'shot.png', alt: 'макет 1440' }, deps(network.request))
check('alt уходит в markdown', line, '![макет 1440](https://github.com/user-attachments/assets/uuid-2)')

// 3. 422 и 404 — исключение с кодом GitHub, без выдуманного адреса.
network = makeRequest({
  [REPO_GET]: { status: 200, body: JSON.stringify({ id: 777 }) },
  [UPLOAD]: { status: 422, body: '{"message":"Validation Failed"}' },
})
await checkRejects('422 назван отказом с кодом',
  () => mod.attachImage({ path: 'shot.png' }, deps(network.request)), /422/)

network = makeRequest({
  [REPO_GET]: { status: 200, body: JSON.stringify({ id: 777 }) },
  [UPLOAD]: { status: 404, body: '{"message":"Not Found"}' },
})
await checkRejects('404 назван отказом с кодом',
  () => mod.attachImage({ path: 'shot.png' }, deps(network.request)), /404/)

// 4. Локальные отказы не делают НИ ОДНОГО запроса.
network = makeRequest({})
await checkRejects('нет файла — сеть не трогается',
  () => mod.attachImage({ path: 'нет.png' }, deps(network.request)), /файла нет/)
await checkRejects('каталог — сеть не трогается',
  () => mod.attachImage({ path: 'folder.png' }, deps(network.request)), /каталог/)
await checkRejects('.webp — сеть не трогается',
  () => mod.attachImage({ path: 'shot.webp' }, deps(network.request)), /не картинка/)
await checkRejects('больше 8 МиБ — сеть не трогается',
  () => mod.attachImage({ path: 'huge.png' }, deps(network.request)), /больше 8 МиБ/)
await checkRejects('незнакомая рабочая область — сеть не трогается',
  () => mod.attachImage({ path: pngFile }, deps(network.request, { cwd: path.join(sandbox, 'unknown') })),
  /не найдена в реестре/)
check('после локальных отказов запросов ноль', network.calls.length, 0)

// 5. Кеш repository_id: второй вызов в том же процессе не повторяет GET /repos.
const cache = new Map()
const handlers = {
  [REPO_GET]: { status: 200, body: JSON.stringify({ id: 777 }) },
  [UPLOAD]: { status: 201, body: JSON.stringify({ url: 'https://github.com/user-attachments/assets/uuid-3' }) },
}
network = makeRequest(handlers)
await mod.attachImage({ path: 'shot.png' }, deps(network.request, { cache }))
await mod.attachImage({ path: 'shot.png' }, deps(network.request, { cache }))
check('второй вызов не повторяет GET /repos',
  network.calls.filter((c) => c.url === 'https://api.github.com/repos/gidvantus/workflow').length, 1)
check('но POST был оба раза',
  network.calls.filter((c) => c.method === 'POST').length, 2)

// 6. id репозитория не отдан — отказ, а не POST вслепую.
network = makeRequest({ [REPO_GET]: { status: 404, body: '{}' } })
await checkRejects('без id репозитория загрузки нет',
  () => mod.attachImage({ path: 'shot.png' }, deps(network.request)), /не отдал id репозитория/)
check('и POST не отправлялся', network.calls.filter((c) => c.method === 'POST').length, 0)

// ── чтение настоящего реестра из каталога состояния ─────────────────────────

console.log('\n=== реестр на диске ===')
const stateDir = path.join(sandbox, 'profiles', 'desktop', 'dsh-dev-department')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'projects.json'), JSON.stringify(registry))
const onDisk = mod.readProjectsDocument()
check('readProjectsDocument читает каталог профиля',
  mod.repoForWorkspace(WORK_DIR, onDisk), 'gidvantus/workflow')

fs.writeFileSync(path.join(stateDir, 'projects.json'), '{ это не json')
checkThrows('нечитаемый реестр — отказ с файлом',
  () => mod.readProjectsDocument(), /не читается реестр проектов/)

// ── уборка ──────────────────────────────────────────────────────────────────

if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome
process.chdir(originalCwd)
fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
process.exit(failures === 0 ? 0 : 1)
