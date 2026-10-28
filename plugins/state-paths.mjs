// Где живёт изменяемое состояние отдела разработки (issue #26).
//
// ЕДИНСТВЕННОЕ МЕСТО, ГДЕ СОБРАН ЭТОТ ПУТЬ. Его спрашивают все: хост-плагины
// (`dev-department.mjs`, `usage-ledger.mjs`, `tg-bridge.mjs`, `role-permissions.mjs`,
// `role-sessions.mjs`) пишут через него, инструменты `plugins/tools/` читают через
// него. Если каждый модуль собирает `path.join(dshHome(), …)` сам, перенос каталога
// расходится у плагинов и у инструментов молча: один пишет в новое место, другой
// читает из старого и показывает пустоту.
//
// ПОЧЕМУ КАТАЛОГ ПРОФИЛЯ, А НЕ КАТАЛОГ ПАКЕТА. Соблазн положить состояние рядом с
// модулем (`node_modules`) выглядит логично, но `dsh plugin add` переустанавливает
// пакет, и файл исчезает вместе с прежней версией — а в `projects.json` лежат токены
// Telegram и рабочие области проектов. Каталог профиля pnpm не трогает, поэтому база
// для состояния — `profiles/<профиль>/`, а не корень установки: корень занят DSH
// (`mcp/`, `sessions/`, `storages/`, `.agent-presets`), и отдел не должен его
// засорять.
//
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/projects.json            — реестр проектов
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department.json      — общие настройки
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department-dialogs.json
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department-usage.json
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department.log
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/dev-department-mcp.log
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/role-sessions.log
//   <DSH_HOME>/profiles/desktop/dsh-dev-department/role-permissions.log
//
// Имена файлов не меняются — меняется только каталог. Формат `projects.json` и
// `dev-department.json` тоже не меняется: перенос — это путь, а не новая схема.
//
// ПЕРЕНОС СО СТАРОГО МЕСТА. До #26 файлы лежали в корне `<DSH_HOME>`. Первый
// `stateFile()` переносит легаси-файл `renameSync` — один раз; повторный вызов
// ничего не делает. Если rename упал (`EXDEV` — другой диск, `EPERM` — чужое
// право), файл копируется, старое НЕ удаляется, а в журнал отдела пишется строка:
// данные важнее чистоты каталога. `readStateFile()` умеет читать старое место
// навсегда: ручной возврат файла в корень не оставляет отдел без реестра.
//
// `DSH_HOME` читается В МОМЕНТ ВЫЗОВА, а не на импорте модуля: отчёт
// `plugins/tools/issue-tokens.mjs` указывает другой каталог установки, и путь
// обязан последовать за ним.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Профиль, в котором живёт отдел: тот же, что `DEFAULT_PROFILE` в `plugin-paths.mjs`. */
export const STATE_PROFILE = 'desktop'

/**
 * Восемь имён состояния отдела. Ключ — для кода, значение — имя файла на диске:
 * имена знают и плагины, и инструменты, поэтому переименование здесь — смена
 * контракта, а не косметика.
 */
export const STATE_FILES = {
  projects: 'projects.json',
  config: 'dev-department.json',
  dialogs: 'dev-department-dialogs.json',
  usage: 'dev-department-usage.json',
  shiftLog: 'dev-department.log',
  mcpLog: 'dev-department-mcp.log',
  roleSessions: 'role-sessions.log',
  rolePermissions: 'role-permissions.log',
}

/**
 * Каталог установки DSH: `$DSH_HOME`, иначе `~/.dsh`. Читается на каждый вызов —
 * плагин живёт дольше одного окружения, а наборы подменяют каталог между проверками.
 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Каталог состояния отдела: `<DSH_HOME>/profiles/desktop/dsh-dev-department`. */
export function stateDir() {
  return path.join(dshHome(), 'profiles', STATE_PROFILE, 'dsh-dev-department')
}

/** Где файл лежал до #26: корень каталога установки. */
export function legacyFile(name) {
  return path.join(dshHome(), name)
}

/**
 * Путь для ЗАПИСИ: создаёт каталог состояния и переносит легаси-файл, если он ещё
 * в корне. Сам файл не создаёт — «файла нет» остаётся прежним состоянием, и
 * решает плагин.
 */
export function stateFile(name) {
  const target = path.join(stateDir(), name)
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
  } catch (error) {
    // Каталог не создался — возвращаем новый путь: запись сама сообщит о проблеме.
    return target
  }
  migrate(name, target)
  return target
}

/**
 * Путь для ЧТЕНИЯ: новый, если файл там есть; иначе старый, если он ещё в корне
 * установки; иначе новый (поведение «файла нет» прежнее). Ничего не переносит:
 * чтение не должно менять диск.
 */
export function readStateFile(name) {
  const target = path.join(stateDir(), name)
  if (fs.existsSync(target)) return target
  const legacy = legacyFile(name)
  if (fs.existsSync(legacy)) return legacy
  return target
}

/**
 * Однократный перенос легаси-файла. Четыре сценария контракта:
 *   • новый файл уже есть   → ничего не делать (и чтение идёт с нового места);
 *   • старого файла нет      → ничего не делать;
 *   • иначе                  → `renameSync(old, new)`;
 *   • rename упал            → `copyFileSync` + строка в журнал, старое остаётся.
 * Ни один сценарий не бросает: перенос — удобство, а не условие работы отдела.
 */
function migrate(name, target) {
  try {
    if (fs.existsSync(target)) return
    const legacy = legacyFile(name)
    if (!fs.existsSync(legacy)) return
    try {
      fs.renameSync(legacy, target)
    } catch (error) {
      try {
        fs.copyFileSync(legacy, target)
        logLine('миграция: скопировано, старое оставлено (' +
          (error && error.code ? error.code : String(error && error.message ? error.message : error)) +
          '): ' + legacy)
      } catch (copyError) {
        logLine('миграция не удалась: ' + legacy + ' → ' + target + ': ' +
          (copyError && copyError.message ? copyError.message : String(copyError)))
      }
    }
  } catch (error) {
    // Проверка существования упала — считаем, что переносить нечего.
  }
}

// Журнал переноса — в тот же журнал отдела, что пишут плагины. Пишется напрямую,
// без `stateFile`, иначе строка о неудаче переноса вызывала бы новый перенос.
function logLine(text) {
  try {
    fs.appendFileSync(path.join(stateDir(), STATE_FILES.shiftLog),
      '\n===== ' + new Date().toISOString() + ' =====\n' + text + '\n')
  } catch (error) {
    // журнал не должен мешать переносу
  }
}
