// Проверка помощника `tools/tests/plugin-paths.mjs`: он отвечает за то, чтобы
// наборы находили боевые модули в любой из трёх раскладок (рабочая копия,
// установленный пакет, старая раскладка sync.mjs) и не молчали, когда нет ни одной.
//
// Живёт в песочном каталоге внутри $TEMP: боевой ~/.dsh не читается и не пишется,
// каталог установки передаётся помощнику ключом dshHome.
// Запуск: node tools/tests/plugin-paths.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as pluginPaths from './plugin-paths.mjs'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
function checkText(name, haystack, needle) {
  const ok = String(haystack).includes(needle)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + (ok ? 'есть «' + needle + '»' : 'НЕТ «' + needle + '», текст: ' + String(haystack).slice(0, 400)))
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-paths-'))
const repoRoot = path.join(sandbox, 'repo')
const dshHome = path.join(sandbox, 'home')
const options = { repoRoot, dshHome, profile: 'desktop' }

const write = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '// песочный модуль\n')
}

const repoPlugin = path.join(repoRoot, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const bundlePlugin = path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department', 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const legacyPlugin = path.join(dshHome, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const repoPreset = path.join(repoRoot, 'agent-presets', 'analyst', 'preset.yml')
const legacyPreset = path.join(dshHome, '.agent-presets', 'analyst', 'preset.yml')

console.log('=== рабочий каталог: ' + sandbox + ' ===')
check('пока пусто: модуля нет', pluginPaths.findHostFile('profiles/desktop/plugins/dev-department.mjs', options), null)

// ── 1. рабочая копия ────────────────────────────────────────────────────────
write(repoPlugin)
check('рабочая копия: модуль профиля найден', pluginPaths.pluginFile('dev-department', options), repoPlugin)
check('рабочая копия: имя без .mjs дополняется', pluginPaths.pluginFile('dev-department.mjs', options), repoPlugin)
write(repoPreset)
check('рабочая копия: каталог пресета найден', pluginPaths.presetDir('analyst', options), path.join(repoRoot, 'agent-presets', 'analyst'))
check('рабочая копия: файл внутри пресета найден', pluginPaths.presetFile('analyst', 'preset.yml', options), repoPreset)

// ── 2. старая раскладка sync.mjs при живой рабочей копии ────────────────────
write(legacyPlugin)
write(legacyPreset)
check('при обеих раскладках побеждает рабочая копия', pluginPaths.pluginFile('dev-department', options), repoPlugin)

// ── 3. установленный пакет ──────────────────────────────────────────────────
fs.rmSync(repoPlugin)
write(bundlePlugin)
check('пакет: модуль найден в node_modules профиля', pluginPaths.pluginFile('dev-department', options), bundlePlugin)
check('пакет: приоритетнее старой раскладки', pluginPaths.pluginFile('dev-department', options) !== legacyPlugin, true)
check('пакет: каталог пакета назван', pluginPaths.bundlePackageDir(options), path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department'))

// ── 4. патч бандла ─────────────────────────────────────────────────────────
const repoPatch = path.join(repoRoot, 'cordis.patch.yml')
write(repoPatch)
check('патч бандла: из репозитория, пока он там есть', pluginPaths.bundlePatchFile(options), repoPatch)
fs.rmSync(repoPatch)
write(path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department', 'cordis.patch.yml'))
check('патч бандла: из установленного пакета', pluginPaths.bundlePatchFile(options), path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department', 'cordis.patch.yml'))

// ── 5. старая раскладка как единственная ───────────────────────────────────
fs.rmSync(path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department'), { recursive: true, force: true })
check('старая раскладка: модуль профиля найден', pluginPaths.pluginFile('dev-department', options), legacyPlugin)
check('старая раскладка: каталог пакета не выдуман', pluginPaths.bundlePackageDir(options), null)

// ── 6. пресеты старой раскладки лежат по другому пути ──────────────────────
fs.rmSync(path.join(repoRoot, 'agent-presets'), { recursive: true, force: true })
check('старая раскладка: пресет берётся из ~/.dsh/.agent-presets', pluginPaths.presetDir('analyst', options), path.join(dshHome, '.agent-presets', 'analyst'))

// ── 7. отказной сценарий: файла нет нигде ──────────────────────────────────
let error = null
try {
  pluginPaths.hostFile('profiles/desktop/plugins/tg-bridge.mjs', options)
} catch (caught) {
  error = caught.message
}
checkText('нет файла: ошибка называет искомый путь', error, 'profiles/desktop/plugins/tg-bridge.mjs')
checkText('нет файла: ошибка перечисляет рабочую копию', error, 'рабочая копия: ' + path.join(repoRoot, 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs'))
checkText('нет файла: ошибка перечисляет пакет', error, 'пакет: ' + path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-dev-department', 'profiles', 'desktop', 'plugins', 'tg-bridge.mjs'))
checkText('нет файла: ошибка перечисляет старую раскладку', error, 'старая раскладка: ' + legacyPlugin.replace('dev-department', 'tg-bridge'))

// ── 8. DSH_HOME из окружения не подменяет явный каталог ─────────────────────
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = path.join(sandbox, 'чужой-каталог-установки')
check('явный dshHome сильнее DSH_HOME окружения', pluginPaths.pluginFile('dev-department', options), legacyPlugin)
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

console.log('')
console.log(failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : 'ПРОВАЛОВ: ' + failures)
fs.rmSync(sandbox, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
