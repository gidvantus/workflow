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
import * as pluginPaths from './plugin-paths.mjs'

// Корень репозитория берём у помощника раскладок, каталог установки — из окружения.
const repoRoot = pluginPaths.REPO_ROOT
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
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

// Проверяем один каталог профиля: и репозиторий, и установку — по одному правилу.
function auditProfile(label, profileDir) {
  const entries = pluginEntries(path.join(profileDir, 'cordis.patch.yml'))
  const relative = entries.filter((entry) => entry.name.startsWith('./') || entry.name.startsWith('../'))
  console.log('\n=== ' + label + ': относительных подключений ' + relative.length + ' из ' + entries.length + ' ===')
  for (const entry of relative) {
    const modulePath = path.resolve(profileDir, entry.name)
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

const profiles = fs.readdirSync(path.join(repoRoot, 'profiles'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

for (const name of profiles) {
  auditProfile('репозиторий/' + name, path.join(repoRoot, 'profiles', name))
}

for (const name of profiles) {
  const installed = path.join(dshHome, 'profiles', name)
  if (!fs.existsSync(installed)) {
    console.log('\n=== установка/' + name + ': профиля нет, проверка пропущена ===')
    continue
  }
  auditProfile('установка/' + name, installed)
}

// ── установленный bundle-пакет ──────────────────────────────────────────────
// В раскладке пакета ближайший манифест над плагинами — манифест самого пакета
// (dsh plugin add кладёт его зависимостью профиля), поэтому name и version
// обязаны быть и у него: иначе инвентарь падает ровно так же, как на профильном
// манифесте без версии. Пакета на машине может ещё не быть — тогда пропуск.
const bundleDir = pluginPaths.bundlePackageDir({ dshHome })
if (bundleDir === null) {
  console.log('\n=== пакет ' + pluginPaths.BUNDLE_PACKAGE + ' не установлен: проверка пропущена ===')
} else {
  const manifest = path.join(bundleDir, 'package.json')
  if (!fs.existsSync(manifest)) {
    failures += 1
    console.log('ФЕЙЛ  пакет: манифест на месте → нет ' + manifest)
  } else {
    const identity = identityOf(manifest)
    const ok = identity.error === undefined && identity.name === pluginPaths.BUNDLE_PACKAGE
    if (!ok) failures += 1
    console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + 'пакет: name и version → ' + (identity.error === undefined ? identity.name + '@' + identity.version : identity.error))
  }
  const bundlePatch = path.join(bundleDir, 'cordis.patch.yml')
  const patchOk = fs.existsSync(bundlePatch)
  if (!patchOk) failures += 1
  console.log((patchOk ? 'ok    ' : 'ФЕЙЛ  ') + 'пакет: патч бандла на месте → ' + (patchOk ? 'есть cordis.patch.yml' : 'нет ' + bundlePatch))
}

console.log('')
if (failures > 0) {
  console.log('ПРОВАЛЕНО ПРОВЕРОК: ' + failures)
  process.exit(1)
}
console.log('ВСЕ ПРОВЕРКИ ПРОШЛИ')
