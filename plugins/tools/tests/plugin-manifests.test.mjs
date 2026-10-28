// Проверка манифестов хост-плагинов: у каждого модуля, подключённого в
// cordis.patch.yml относительным путём, ближайший package.json обязан нести
// непустые name и version.
//
// Почему это отдельный тест. DSH перечисляет активные пакеты плагинов в КАЖДОМ
// запросе к модели (@deepseek-ai/dsh-plugin-package-inventory-deepseek): он ищет
// ближайший манифест над файлом плагина и падает, если в манифесте есть имя, но
// нет версии. Профильный манифест (~/.dsh/profiles/<имя>/package.json,
// "dsh-profile-desktop") версии не несёт, поэтому без
// profiles/<имя>/plugins/package.json каждый ход завершается
// "DeepSeek request extension preparation failed" / REQUEST_EXTENSION — при этом
// сами плагины загружаются нормально, и в журнале хоста нет ничего, кроме
// предупреждения. Проверка ловит такую установку до того, как она съест смену.
//
// Запуск: node plugin-manifests.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pluginPaths from '../plugin-paths.mjs'

// Корень репозитория берём у помощника раскладок, каталог установки — из окружения.
const repoRoot = pluginPaths.REPO_ROOT
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// Для проверок вида «условие выполнено»: второй аргумент — булево, третий —
// пояснение на случай провала.
function assertOk(name, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + (ok || detail === undefined ? '' : ' → ' + detail))
}

// ── правила DSH, повторённые дословно ───────────────────────────────────────

// Инвентарь берёт ближайший вверх по дереву package.json — как nearestManifest
// в dsh-plugin-package-inventory-deepseek.
function nearestManifest(modulePath) {
  let current = path.dirname(modulePath)
  const root = path.parse(current).root
  for (;;) {
    const manifest = path.join(current, 'package.json')
    if (fs.existsSync(manifest)) return manifest
    if (current === root) return undefined
    current = path.dirname(current)
  }
}

// Относительный модуль — «loose module»: имя в манифесте может отсутствовать, и
// тогда пакет просто не попадает в список. Но если имя есть, версия обязательна.
function identityOf(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.name === undefined) return { skipped: true, manifest: manifestPath }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0 ||
      typeof manifest.version !== 'string' || manifest.version.length === 0) {
    return { error: 'в ' + manifestPath + ' нужны непустые name и version', manifest: manifestPath }
  }
  return { name: manifest.name, version: manifest.version, manifest: manifestPath }
}

// Из патча берём только подключения плагинов: строки "- id: ..." и следующую за
// ними строку "name: ...". Прочие name: (например, serverName в config) не наши.
function pluginEntries(patchFile) {
  if (!fs.existsSync(patchFile)) return []
  const lines = fs.readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries = []
  let current = null
  for (const line of lines) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) { current = { id: idMatch[1], name: null }; entries.push(current); continue }
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && current && current.name === null) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return entries.filter((entry) => entry.name !== null)
}

// Проверяем один каталог профиля. Раскладка в репозитории — отдельный случай:
// хост-плагины там лежат плоско в plugins/, а патч профиля адресует их как
// ./plugins/<файл> (так их разложит sync.mjs). Поэтому для рабочей копии путь
// строки разрешается через пакет, а для установки — как обычно, от профиля.
function auditProfile(label, profileDir, resolveModule = (name) => path.resolve(profileDir, name)) {
  const entries = pluginEntries(path.join(profileDir, 'cordis.patch.yml'))
  const relative = entries.filter((entry) => entry.name.startsWith('./') || entry.name.startsWith('../'))
  console.log('\n=== ' + label + ': относительных подключений ' + relative.length + ' из ' + entries.length + ' ===')
  for (const entry of relative) {
    const modulePath = resolveModule(entry.name)
    if (!fs.existsSync(modulePath)) {
      check(label + ' ' + entry.id + ': файл плагина на месте', entry.name, 'файл есть')
      continue
    }
    const manifest = nearestManifest(modulePath)
    if (manifest === undefined) { check(label + ' ' + entry.id + ': ближайший манифест', 'нет манифеста', 'package.json с name+version'); continue }
    const identity = identityOf(manifest)
    const shown = identity.error !== undefined
      ? identity.error
      : (identity.skipped ? 'анонимный манифест (в список пакетов не идёт)' : identity.name + '@' + identity.version)
    const ok = identity.error === undefined
    if (!ok) failures += 1
    console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + label + ' ' + entry.id + ' → ' + shown + (ok ? '' : ' (нужны непустые name и version)'))
  }
}

const legacyProfiles = path.join(repoRoot, 'plugins', 'profiles')
const profiles = fs.existsSync(legacyProfiles)
  ? fs.readdirSync(legacyProfiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  : []

for (const name of profiles) {
  auditProfile('репозиторий/' + name, path.join(legacyProfiles, name), (entryName) => {
    // В рабочей копии хост-плагины отдела лежат плоско в plugins/, а плагин со
    // своим каталогом (voice-input) — в plugins/profiles/<профиль>/plugins/.
    // Патч профиля адресует и те, и другие как ./plugins/…
    const rel = entryName.replace(/^\.\//, '')
    const flat = path.join(repoRoot, 'plugins', path.basename(rel))
    if (fs.existsSync(flat)) return flat
    return path.join(repoRoot, 'plugins', 'profiles', name, rel)
  })
}

for (const name of profiles) {
  const installed = path.join(dshHome, 'profiles', name)
  if (!fs.existsSync(installed)) {
    console.log('\n=== установка/' + name + ': профиля нет, проверка пропущена ===')
    continue
  }
  auditProfile('установка/' + name, installed)
}

// ── bundle-пакет ────────────────────────────────────────────────────────────
// Строки патча адресуются спецификатором пакета, поэтому проверяем не «файл рядом
// с патчем», а весь путь: манифест объявляет подпуть в exports, файл существует,
// ближайший над ним манифест несёт name и version. Одна и та же проверка идёт для
// рабочей копии (пакет = корень репозитория) и для установленного пакета.
function auditBundle(label, packageDir) {
  const manifestPath = path.join(packageDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    assertOk(label + ': манифест пакета на месте', false, manifestPath)
    return
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const identity = identityOf(manifestPath)
  assertOk(label + ': у пакета name+version', identity.error === undefined, identity.error)
  assertOk(label + ': имя пакета совпадает', identity.name === pluginPaths.BUNDLE_PACKAGE,
    String(identity.name) + ' (ждём ' + pluginPaths.BUNDLE_PACKAGE + ')')
  const declared = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
  assertOk(label + ': объявлен dsh.bundle.patch', typeof declared === 'string' && declared.length > 0, String(declared))
  if (typeof declared !== 'string') return
  const patchPath = path.resolve(packageDir, declared)
  assertOk(label + ': файл патча на месте', fs.existsSync(patchPath), declared)
  if (!fs.existsSync(patchPath)) return
  const exportsMap = manifest.exports || {}
  const entries = pluginEntries(patchPath)
  console.log('\n=== ' + label + ': строк в патче ' + entries.length + ' ===')
  for (const entry of entries) {
    const prefix = identity.name + '/'
    // Патч может трогать и чужие строки (например, конфиг agent-presets) — это не
    // наши подключения, и проверять их exports'ом пакета нельзя.
    if (!entry.name.startsWith(prefix)) continue
    const sub = './' + entry.name.slice(prefix.length)
    const target = exportsMap[sub]
    if (typeof target !== 'string') {
      assertOk(label + ' ' + entry.id + ': подпуть объявлен в exports', false, 'exports[' + sub + ']')
      continue
    }
    const modulePath = path.resolve(packageDir, target)
    assertOk(label + ' ' + entry.id + ': файл плагина на месте', fs.existsSync(modulePath), target)
    const near = nearestManifest(modulePath)
    const nearIdentity = near === undefined ? { error: 'нет манифеста над ' + target } : identityOf(near)
    assertOk(label + ' ' + entry.id + ': ближайший манифест с name+version',
      nearIdentity.error === undefined, nearIdentity.error)
  }
}

auditBundle('пакет/репозиторий', repoRoot)

// Пакета на машине может ещё не быть — тогда пропуск: проверять нечего.
const bundleDir = pluginPaths.bundlePackageDir({ dshHome })
if (bundleDir === null) {
  console.log('\n=== пакет ' + pluginPaths.BUNDLE_PACKAGE + ' не установлен: проверка пропущена ===')
} else {
  auditBundle('пакет/установка', bundleDir)
  assertOk('пакет: патч бандла найден помощником раскладок',
    pluginPaths.bundlePatchFile({ dshHome }) !== null, 'bundlePatchFile вернул null')
}

console.log('')
if (failures > 0) {
  console.log('ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
  process.exit(1)
}
console.log('ВСЕ ПРОВЕРКИ ПРОШЛИ')
