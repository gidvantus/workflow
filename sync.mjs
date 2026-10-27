#!/usr/bin/env node
// Синхронизация кастомной надстройки DSH между каталогом установки и репозиторием.
//
//   node sync.mjs collect   из ~/.dsh в репозиторий (режим по умолчанию)
//   node sync.mjs apply     из репозитория в ~/.dsh
//   node sync.mjs status    сравнить и показать расхождения
//
// Установка — не этот скрипт. Надстройка ставится одним bundle-пакетом
// (`dsh plugin add github:gidvantus/workflow#<commit>`): хост-плагины приезжают
// строками его cordis.patch.yml, роли — его каталогом agent-presets/. Поэтому
// apply и status, увидев в профиле установленный пакет, говорят об этом и
// раскладку хост-плоскости не предлагают: вторая копия в каталоге установки
// подняла бы второй диспетчер. За sync остались файлы, путь которых в установке
// не совпадает с путём в репозитории (config/dev-department.json), и collect —
// сбор правок из установки обратно в репозиторий.
//
// Каталог установки: $DSH_HOME, иначе ~/.dsh; переопределяется ключом --dsh-home.
// Корень репозитория: каталог самого скрипта; переопределяется ключом --repo или
// полем repo в sync.local.json. Скрипт лежит в корне репозитория и переезжает
// вместе с ним: отдельного «пути к папке» внутри кода нет, поэтому переезд
// каталога не ломает синхронизацию.
// Черновики (*.bak-*), логи, артефакты тестов и секреты не синхронизируются.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUNDLE_PACKAGE, DEFAULT_PROFILE, bundlePackageDir } from './tools/plugin-paths.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

// ── аргументы ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const mode = argv.find((a) => !a.startsWith('--')) || 'collect'
if (!['collect', 'apply', 'status'].includes(mode)) {
  console.error('режим должен быть collect, apply или status')
  process.exit(2)
}
const homeFlag = argv.indexOf('--dsh-home')
const dshHome = homeFlag === -1
  ? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  : argv[homeFlag + 1]
if (!fs.existsSync(dshHome)) {
  console.error('каталог установки не найден: ' + dshHome + ' (задай --dsh-home)')
  process.exit(2)
}

// Локальные переопределения: файл пишут руками, и в git он не попадает.
const localConfig = path.join(scriptDir, 'sync.local.json')
let local = {}
if (fs.existsSync(localConfig)) {
  // Редакторы Windows любят BOM: JSON.parse на нём падает.
  const raw = fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, '')
  local = JSON.parse(raw)
}

const repoFlag = argv.indexOf('--repo')
const repo = repoFlag !== -1
  ? path.resolve(argv[repoFlag + 1])
  : (local.repo ? path.resolve(local.repo) : scriptDir)
if (!fs.existsSync(repo)) {
  console.error('каталог репозитория не найден: ' + repo + ' (задай --repo)')
  process.exit(2)
}

// ── что синхронизируем ──────────────────────────────────────────────────────

// Списки не ведутся руками: и роли, и хост-плоскость берутся из файловой системы
// репозитория. Раньше здесь лежали массивы PRESETS и HOST_FILES, и забытая строка
// в них означала роль, которая есть в репозитории, но никуда не раскладывается.
// Теперь новый пресет — это новый каталог `agent-presets/<id>/`, а новый
// хост-файл — новый файл в `profiles/<профиль>/`.

// Роли отдела: один каталог — один пресет.
function repoPresets() {
  const root = path.join(repo, 'agent-presets')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDE_PATH.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

// Хост-плоскость: путь внутри каталога установки совпадает с путём в репозитории.
function repoHostFiles() {
  return walk(path.join(repo, 'profiles'))
    .map((rel) => 'profiles/' + rel.split(path.sep).join('/'))
    .sort()
}

// Установленный bundle-пакет надстройки: `dsh plugin add` кладёт его зависимостью
// профиля, и тогда хост-плоскость и пресеты приезжают из пакета, а не из sync.
// Место то же, что читает патч бандла в корне репозитория, поэтому путь берётся у
// помощника раскладок, а не выводится здесь заново.
function installedBundles() {
  const root = path.join(dshHome, 'profiles')
  if (!fs.existsSync(root)) return []
  const found = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = bundlePackageDir({ dshHome, repoRoot: repo, profile: entry.name })
    if (dir !== null) found.push({ profile: entry.name, dir })
  }
  return found
}

// Подключён ли пакет в манифесте профиля: каталог в node_modules без строки в
// `dsh.profile.bundles` — это «пакет лежит», а не «пакет работает». null —
// манифест не прочитан (профиля нет или он битый).
function bundleRegistered(profile) {
  const file = path.join(dshHome, 'profiles', profile, 'package.json')
  if (!fs.existsSync(file)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return (manifest?.dsh?.profile?.bundles ?? []).includes(BUNDLE_PACKAGE)
  } catch {
    return null
  }
}

// Файлы, у которых путь в каталоге установки не совпадает с путём в репозитории.
// Расписание смен и лимиты диспетчер читает из ~/.dsh/dev-department.json, а в
// репозитории они лежат в config/ рядом с образцом реестра проектов.
const HOME_FILES = [
  { repo: 'config/dev-department.json', home: 'dev-department.json' },
]

// Файлы профиля раскладываются только в СУЩЕСТВУЮЩИЙ профиль. Каталог
// profiles/<имя> — это профиль DSH с манифестом package.json; изготовить его
// наполовину (только патч и плагины) значит получить профиль без манифеста,
// который DSH покажет недоступным, а `dsh <имя>` — не запустит. Пока профиля
// нет, раскладывать его файлы некуда: сам профиль создаёт DSH.
function profileOf(rel) {
  const m = /^profiles[\\/]([^\\/]+)[\\/]/.exec(rel)
  return m ? m[1] : null
}

function hasProfile(rel) {
  const name = profileOf(rel)
  if (!name) return true
  return fs.existsSync(path.join(dshHome, 'profiles', name))
}

// docs/ и tools/ живут только в репозитории: это документация процесса и
// инструменты проверки, а не надстройка каталога установки. В ~/.dsh они не
// кладутся и обратно не раскладываются. Раньше их источник задавался полем
// toolsSource в sync.local.json и указывал на рабочую область человека; теперь
// источник у них один — этот каталог, поэтому поле больше не нужно.

// Что не синхронизируется никогда: черновики, логи, артефакты прогонов.
const EXCLUDE = /\.bak(-|\.|$)|\.log(-|\.|$)|^\.coverage$|^coverage-|\.tmp$/
// Архив прежних наборов скиллов роли — кладбище, а не рабочий файл: в репозиторий
// он не едет, иначе каждый пресет тянет за собой сотни чужих страниц.
const EXCLUDE_PATH = /(^|[\\/])_skills-archive([\\/]|$)/

function walk(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (!EXCLUDE.test(entry.name)) {
        const rel = path.relative(root, full)
        if (!EXCLUDE_PATH.test(rel)) out.push(rel)
      }
    }
  }
  return out
}

// Обход всех файлов каталога без исключений: по нему уборка понимает, что в
// репозитории лишнее.
function walkAll(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else out.push(path.relative(root, full))
    }
  }
  return out
}

function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    pruneEmptyDirs(full)
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
  }
}

// Каталоги пресетов зеркалятся целиком, поэтому collect ещё и убирает из
// репозитория файлы, которых в каталоге установки нет: без этого удалённые
// скиллы и переименованные роли остаются в репозитории навсегда.
function mirrorRoots() {
  const roots = []
  for (const preset of repoPresets()) {
    const source = path.join(dshHome, '.agent-presets', preset)
    if (!fs.existsSync(source)) continue
    roots.push({
      source,
      target: path.join(repo, 'agent-presets', preset),
      keep: new Set(walk(source)),
    })
  }
  return roots
}

function prune(roots) {
  let removed = 0
  for (const root of roots) {
    if (!fs.existsSync(root.target)) continue
    for (const rel of walkAll(root.target)) {
      if (root.keep.has(rel)) continue
      fs.rmSync(path.join(root.target, rel))
      removed += 1
      console.log('  удалено   ' + short(path.join(root.target, rel)))
    }
    pruneEmptyDirs(root.target)
  }
  return removed
}

function pairs() {
  const list = []
  for (const rel of repoHostFiles()) {
    list.push({ from: path.join(dshHome, rel), to: path.join(repo, rel), rel, kind: 'host' })
  }
  for (const { repo: rel, home } of HOME_FILES) {
    list.push({ from: path.join(dshHome, home), to: path.join(repo, rel), rel, kind: 'home' })
  }
  for (const preset of repoPresets()) {
    const fromRoot = path.join(dshHome, '.agent-presets', preset)
    const toRoot = path.join(repo, 'agent-presets', preset)
    // Перечисляем ОБЕ стороны: на новой машине пресетов в каталоге установки
    // ещё нет, и файлы приезжают только со стороны репозитория. Раньше список
    // строился по одной стороне, и `apply` на чистой машине не создавал ни
    // одного агента отдела.
    const rels = new Set([...walk(fromRoot), ...walk(toRoot)])
    for (const rel of rels) {
      list.push({
        from: path.join(fromRoot, rel),
        to: path.join(toRoot, rel),
        rel: 'agent-presets/' + preset + '/' + rel.split(path.sep).join('/'),
        kind: 'preset',
      })
    }
  }
  return list
}

function hash(file) {
  if (!fs.existsSync(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function copyOne(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

const short = (full) => path.relative(repo, full).split(path.sep).join('/')

// ── проверка секретов ───────────────────────────────────────────────────────

function secrets() {
  const found = []
  // Токен GitHub лежит рядом с MCP-сервером (mcp/github-mcp-server/token): своего
  // клиента GitHub у диспетчера и ролей больше нет, ключ читает строка mcp-github.
  const secretFiles = ['telegram.json', 'typesafe.token', 'mcp/github-mcp-server/token']
  for (const name of secretFiles) {
    const file = path.join(dshHome, name)
    if (!fs.existsSync(file)) continue
    const value = fs.readFileSync(file, 'utf8').trim()
    if (value) found.push({ where: name, value })
  }
  const projects = path.join(dshHome, 'projects.json')
  if (fs.existsSync(projects)) {
    const data = JSON.parse(fs.readFileSync(projects, 'utf8'))
    for (const [id, project] of Object.entries(data.projects || {})) {
      const token = project.telegram && project.telegram.token
      if (token) found.push({ where: 'projects.json: ' + id, value: token })
    }
  }
  return found
}

// Скан только по текстовым файлам: бинарники (шрифты) читать незачем.
const TEXT = /\.(md|json|jsonl|ya?ml|mjs|cjs|js|ts|txt|csv|py|ps1|sh|html|css)$/i

function scanSecrets() {
  let hits = 0
  const known = secrets()
  for (const { where, value } of known) {
    for (const rel of walk(repo).filter((r) => TEXT.test(r) && !r.startsWith('.git' + path.sep))) {
      const full = path.join(repo, rel)
      if (fs.readFileSync(full, 'utf8').includes(value)) {
        hits += 1
        console.log('  СЕКРЕТ  ' + where + ' встречается в ' + short(full))
      }
    }
  }
  console.log(hits === 0 ? '  секретов в репозитории нет' : '  найдено совпадений: ' + hits)
  return hits
}

// ── режимы ──────────────────────────────────────────────────────────────────

console.log('каталог установки: ' + dshHome)
console.log('репозиторий:       ' + repo)
console.log('')

const bundles = installedBundles()
// Пакет может стоять в одном профиле и отсутствовать в другом, поэтому признак
// считается по профилю, а не по всему каталогу установки: иначе установка в
// probe (её делает тестировщик на новом профиле) молча выключала бы раскладку и
// для desktop, и для web — и никто бы об этом не узнал.
const bundleIn = new Set(bundles.map((bundle) => bundle.profile))
// Пресеты лежат в каталоге установки одни на машину (`~/.dsh/.agent-presets`), а не
// по профилю: их привозит пакет, поставленный в основной профиль отдела.
const presetsInBundle = bundleIn.has(DEFAULT_PROFILE)

for (const bundle of bundles) {
  const registered = bundleRegistered(bundle.profile)
  const state = registered === true
    ? 'подключён в dsh.profile.bundles'
    : registered === false
      ? 'НЕ перечислен в dsh.profile.bundles профиля — DSH его не применит'
      : 'манифест профиля не прочитан'
  console.log('пакет:             ' + BUNDLE_PACKAGE + ' установлен в профиль ' + bundle.profile +
    ' (' + path.relative(dshHome, bundle.dir).split(path.sep).join('/') + '), ' + state)
}

// Пара, которую уже везёт установленный пакет: раскладывать её в каталог
// установки и собирать из него нельзя — вторая копия подняла бы второй
// диспетчер, а `collect` вернул бы в репозиторий устаревший модуль.
function ownedByBundle(pair) {
  if (pair.kind === 'host') {
    const name = profileOf(pair.rel)
    return name !== null && bundleIn.has(name)
  }
  if (pair.kind === 'preset') return presetsInBundle
  return false
}

const list = pairs()
const synced = list.filter((pair) => !ownedByBundle(pair))
const fromBundle = synced.length !== list.length

if (fromBundle) {
  const profiles = [...bundleIn].sort().join(', ')
  console.log('')
  console.log('пакет везёт хост-плоскость ' + (bundleIn.size === 1 ? 'профиля ' : 'профилей ') + profiles +
    (presetsInBundle ? ' и пресеты ролей' : '') + ':')
  console.log('строки плагинов берутся из его cordis.patch.yml, роли — из его agent-presets/. Раскладывать')
  console.log('и собирать их через sync больше не нужно и нельзя: в каталоге установки появилась бы')
  console.log('вторая копия, а collect вернул бы в репозиторий устаревший модуль.')
  console.log('')
}

// Зеркальная уборка пресетов сравнивает репозиторий с `~/.dsh/.agent-presets`.
// Когда роли приезжают из пакета, этот каталог — остаток прежней раскладки (или
// пустой), и сверка с ним удаляла бы из репозитория новые файлы. Поэтому при
// пакете в основном профиле уборка не делается вовсе.
const mirrors = presetsInBundle ? [] : mirrorRoots()

if (mode === 'status') {
  let same = 0
  let diff = 0
  let missingRepo = 0
  let missingHome = 0
  let skipped = 0
  for (const pair of synced) {
    const inRepo = hash(pair.to)
    const inHome = hash(pair.from)
    if (!hasProfile(pair.rel)) {
      if (inRepo !== null) {
        skipped += 1
        console.log('  профиля нет  ' + pair.rel)
      }
      continue
    }
    if (inHome === null && inRepo === null) continue
    if (inRepo === null) {
      missingRepo += 1
      console.log('  нет в репо   ' + pair.rel)
    } else if (inHome === null) {
      missingHome += 1
      console.log('  не разложено ' + pair.rel)
    } else if (inHome !== inRepo) {
      diff += 1
      console.log('  различается  ' + pair.rel)
    } else same += 1
  }
  console.log('')
  let extra = 0
  for (const root of mirrors) {
    if (!fs.existsSync(root.target)) continue
    for (const rel of walkAll(root.target)) {
      if (root.keep.has(rel)) continue
      extra += 1
      console.log('  лишнее      ' + short(path.join(root.target, rel)))
    }
  }
  console.log('совпадает: ' + same + ', различается: ' + diff + ', нет в репозитории: ' + missingRepo +
    ', не разложено: ' + missingHome + ', профиля нет: ' + skipped + ', лишнего: ' + extra)
  if (fromBundle) {
    console.log('(файлы, которые везёт пакет, из счёта исключены)')
  }
}

if (mode === 'collect') {
  let copied = 0
  for (const pair of synced) {
    if (!hasProfile(pair.rel)) continue
    if (!fs.existsSync(pair.from)) {
      console.log('  пропуск (нет боевого файла): ' + pair.from)
      continue
    }
    if (hash(pair.from) !== hash(pair.to)) {
      copyOne(pair.from, pair.to)
      copied += 1
      console.log('  собрано   ' + short(pair.to))
    }
  }
  const removed = prune(mirrors)
  console.log('')
  console.log('обновлено файлов: ' + copied + ', удалено лишних: ' + removed)
  if (fromBundle) {
    console.log('')
    console.log('правки из старой раскладки не собираются: источник правды — пакет. Роли и плагины')
    console.log('правятся в репозитории; в профиль их привозит `dsh plugin add github:gidvantus/workflow#<commit>`.')
  }
  console.log('')
  console.log('проверка секретов:')
  scanSecrets()
}

if (mode === 'apply') {
  let copied = 0
  const noProfile = new Set()
  for (const pair of synced) {
    if (!hasProfile(pair.rel)) {
      const name = profileOf(pair.rel)
      if (name && !noProfile.has(name)) {
        noProfile.add(name)
        console.log('  пропуск (профиля ' + name + ' в каталоге установки нет — его создаёт сам DSH): ' +
          name + '/')
      }
      continue
    }
    if (!fs.existsSync(pair.to)) continue
    if (hash(pair.to) !== hash(pair.from)) {
      copyOne(pair.to, pair.from)
      copied += 1
      console.log('  разложено ' + path.relative(dshHome, pair.from).split(path.sep).join('/'))
    }
  }
  console.log('')
  if (fromBundle) {
    console.log('обновлено файлов: ' + copied + '. Хост-плоскость и роли едут из пакета: их обновляют')
    console.log('заново поставленным пакетом (`dsh plugin add`) и перезапуском DSH, а не `sync apply`.')
  } else {
    console.log('обновлено файлов: ' + copied + ' (перезапусти DSH, чтобы плагины хоста перечитались)')
  }
}
