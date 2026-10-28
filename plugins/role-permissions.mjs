// Role permissions — выдаёт сессиям ролей «разработчик», «дизайнер», «тестировщик»,
// «аналитик», «код-ревьюер» и «DevOps-инженер» пресет разрешений danger-full-access,
// чтобы работа не упиралась в запросы подтверждения, которые подтверждать некому.
//
// ПОЧЕМУ ЧЕРЕЗ СЕССИЮ, А НЕ ЧЕРЕЗ ПРЕСЕТ
// Строки `sandbox`, `approval` и `permission` живут в HOST-композиции: пресет не
// может ослабить собственное ограничение, и это намеренная граница. Здесь мы её
// не трогаем — мы выбираем сессионный пресет разрешений, то же самое, что
// пользователь делает руками в селекторе разрешений конкретной сессии.
//
// ЧТО ЭТО ЗНАЧИТ ПО ФАКТУ
// danger-full-access = sandbox `danger-full-access` + approval `never`.
// То есть агент роли пишет куда угодно и не спрашивает разрешения. Ограничение
// переносится на другие рубежи: PR-only, отсутствие автомержа и защита веток.
//
// ЖУРНАЛ: вывод console из плагинов в логи приложения не попадает, поэтому плагин
// пишет ~/.dsh/role-permissions.log — по нему видно, сработал ли слушатель и на
// каком событии.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROLES = ['dev-fullstack', 'dev-backend', 'dev-frontend', 'design', 'tester', 'analyst', 'code-review', 'devops-delivery']
const PERMISSION_PRESET = 'danger-full-access'

function logPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'role-permissions.log')
}

function trace(line) {
  try {
    fs.appendFileSync(logPath(), new Date().toISOString() + ' [role-permissions] ' + line + '\n')
  } catch (error) {
    // журналирование не должно ломать плагин
  }
}

export default {
  inject: ['permissionPresets', 'sessions'],

  apply(ctx) {
    const permissionPresets = ctx.get('permissionPresets')
    const sessions = ctx.get('sessions')
    if (!permissionPresets || !sessions) {
      throw new Error('role-permissions: нужны сервисы permissionPresets и sessions')
    }

    trace('плагин применён: роли=' + ROLES.join(',') + ', пресет=' + PERMISSION_PRESET)

    const handled = new Set()

    function applyFor(sessionId, source) {
      if (!sessionId || handled.has(sessionId)) return
      const session = sessions.get(sessionId)
      if (!session) {
        trace(source + ': сессия ' + sessionId + ' ещё не в хранилище')
        return
      }
      const preset = session.header ? session.header.agentPreset : undefined
      if (!preset || ROLES.indexOf(preset) === -1) return
      handled.add(sessionId)
      try {
        const before = permissionPresets.current(session)
        permissionPresets.set(session, PERMISSION_PRESET)
        const after = permissionPresets.current(session)
        trace(source + ': сессия ' + sessionId + ' (пресет ' + preset + ') разрешения ' + before + ' → ' + after)
      } catch (error) {
        handled.delete(sessionId)
        trace(source + ': ОШИБКА на ' + sessionId + ' — ' + (error && error.stack ? error.stack : String(error)))
      }
    }

    // Два разных события: одно привязано к агентской области видимости, второе —
    // нет. Ловим оба и пишем, какое сработало: так видно, какой из путей рабочий,
    // а повторная установка одного и того же пресета ничего не добавляет.
    ctx.on('agent/created', (payload) => {
      try {
        const agent = payload && payload.agent
        if (agent) applyFor(agent.id, 'agent/created')
      } catch (error) {
        trace('agent/created: исключение — ' + (error && error.message ? error.message : String(error)))
      }
    })

    ctx.on('api-session/added', (summary) => {
      try {
        const sessionId = summary && summary.sessionId
        if (sessionId) applyFor(sessionId, 'api-session/added')
      } catch (error) {
        trace('api-session/added: исключение — ' + (error && error.message ? error.message : String(error)))
      }
    })
  },
}
