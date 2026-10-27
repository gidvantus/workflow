// Один помощник для наборов `tools/tests`: где лежат боевые модули отдела.
//
// Надстройка живёт в трёх раскладках, и набор не должен знать, какая из них
// сейчас на машине:
//
//   1. рабочая копия репозитория — `profiles/<профиль>/plugins/…`,
//      `agent-presets/<роль>/…`;
//   2. установленный bundle-пакет — `dsh plugin add` кладёт его зависимостью
//      профиля, то есть в `<DSH_HOME>/profiles/<профиль>/node_modules/
//      dsh-dev-department/…`; адресация строк в патче бандла — спецификатор
//      пакета, а не относительный путь;
//   3. старая раскладка `node sync.mjs apply` — `<DSH_HOME>/profiles/<профиль>/
//      plugins/…` и `<DSH_HOME>/.agent-presets/<роль>/…`.
//
// Порядок поиска: репозиторий, бандл, старая раскладка. Репозиторий первым не
// случайно: набор проверяет исходник, который лежит рядом с ним, и остаётся
// рабочим на машине, где отдел ещё не установлен как пакет. Боевой ~/.dsh при
// этом только читается: помощник ничего не создаёт и не удаляет.
//
// Ни один путь не выводится из окружения на глаз: и каталог установки, и корень
// репозитория, и имя профиля можно передать явно (`{ dshHome, repoRoot,
// profile }`) — наборы передают их, когда строят песочную раскладку.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Корень репозитория: помощник лежит в `tools/tests/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Имя bundle-пакета надстройки: то же, что в `package.json` в корне репозитория. */
export const BUNDLE_PACKAGE = 'dsh-dev-department'

/** Профиль, в который ставится надстройка: `desktop` — стенд человека. */
export const DEFAULT_PROFILE = 'desktop'

function settings(options = {}) {
  return {
    repoRoot: options.repoRoot ?? REPO_ROOT,
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    profile: options.profile ?? DEFAULT_PROFILE,
  }
}

const slashed = (rel) => String(rel).split(/[\\/]/).filter((part) => part !== '' && part !== '.')

/**
 * Все места, где боевой файл может лежать, в порядке поиска. Список отдаётся
 * целиком, чтобы сообщение об ошибке называло не «файла нет», а что именно
 * искали: иначе непонятно, сломан набор или раскладка.
 */
export function candidates(rel, options = {}) {
  const o = settings(options)
  const parts = slashed(rel)
  const bundle = path.join(o.dshHome, 'profiles', o.profile, 'node_modules', BUNDLE_PACKAGE, ...parts)
  // Пресеты в старой раскладке лежат не по своему пути: ~/.dsh/.agent-presets/<роль>.
  const legacy = parts[0] === 'agent-presets'
    ? path.join(o.dshHome, '.agent-presets', ...parts.slice(1))
    : path.join(o.dshHome, ...parts)
  return [
    { layout: 'рабочая копия', file: path.join(o.repoRoot, ...parts) },
    { layout: 'пакет', file: bundle },
    { layout: 'старая раскладка', file: legacy },
  ]
}

/** Первое найденное место или `null`; раскладка возвращается вместе с путём. */
export function findHostFile(rel, options = {}) {
  return candidates(rel, options).find((candidate) => fs.existsSync(candidate.file)) ?? null
}

/**
 * Путь боевого файла в любой раскладке.
 * @throws когда файла нет ни в одной — с перечнем того, что искали.
 */
export function hostFile(rel, options = {}) {
  const found = findHostFile(rel, options)
  if (found !== null) return found.file
  const tried = candidates(rel, options).map((candidate) => '  ' + candidate.layout + ': ' + candidate.file).join('\n')
  throw new Error('не найден ' + rel + ' ни в одной раскладке. Искал:\n' + tried)
}

/** Модуль хост-плагина профиля: `dev-department` → `profiles/desktop/plugins/dev-department.mjs`. */
export function pluginFile(name, options = {}) {
  const profile = options.profile ?? DEFAULT_PROFILE
  const file = String(name).endsWith('.mjs') ? String(name) : String(name) + '.mjs'
  return hostFile('profiles/' + profile + '/plugins/' + file, options)
}

/** Каталог пресета роли: `analyst` → `agent-presets/analyst` в любой раскладке. */
export function presetDir(role, options = {}) {
  return hostFile('agent-presets/' + role, options)
}

/** Файл внутри пресета роли, например `preset.yml` или `skills/…/SKILL.md`. */
export function presetFile(role, rel, options = {}) {
  return hostFile('agent-presets/' + role + '/' + rel, options)
}

/**
 * Каталог установленного пакета надстройки или `null`. Это же место читает
 * патч бандла: `createRequire(baseUrl).resolve('dsh-dev-department/package.json')`.
 */
export function bundlePackageDir(options = {}) {
  const o = settings(options)
  const dir = path.join(o.dshHome, 'profiles', o.profile, 'node_modules', BUNDLE_PACKAGE)
  return fs.existsSync(dir) ? dir : null
}

/** Патч бандла — из репозитория, если он там уже есть, иначе из установленного пакета. */
export function bundlePatchFile(options = {}) {
  const o = settings(options)
  const inRepo = path.join(o.repoRoot, 'cordis.patch.yml')
  if (fs.existsSync(inRepo)) return inRepo
  const inBundle = bundlePackageDir(o)
  if (inBundle === null) return null
  const file = path.join(inBundle, 'cordis.patch.yml')
  return fs.existsSync(file) ? file : null
}

/** Путь для печати: от корня репозитория, если он внутри него, иначе как есть. */
export function shortPath(file) {
  const relative = path.relative(REPO_ROOT, file)
  return relative.startsWith('..') ? file : relative.split(path.sep).join('/')
}
