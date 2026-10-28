// Role Sessions — стационарный плагин DSH (профиль desktop).
//
// Даёт агенту инструменты:
//   open_role_session(preset, firstMessage?, workspacePath?) — поднять НОВУЮ
//     сессию на выбранном пресете (dev / tester / …) в рабочей области
//     вызывающего агента;
//   list_agent_presets — какие пресеты вообще есть.
//
// Рецепт создания сессии вычислен на живом рантайме этого деплоя:
//   1) agents.create({ meta: { agentPreset } }) создаёт и сохраняет сессию, но
//      НЕ «зачитывает» её в рабочую область — в списке сессий она не появится;
//   2) зачёт делает workspace.attachSession(id) — метод самого объекта
//      Workspace. У workspaceController подходящего метода нет: его
//      insertSessionBefore отказывает с «the session is not accounted»;
//   3) список сессий перечисляет только НЕпустые сессии: sessionController.list()
//      отдаёт флаг blank, и сессия без сообщений остаётся blank: true даже с
//      заголовком (переименование флаг не снимает — проверено). Поэтому после
//      создания отправляется первое сообщение.
//
// ПОЧЕМУ ЗДЕСЬ ЯВНЫЙ inject — это не украшение, а суть.
// Записи из cordis.patch.yml применяются РАНЬШЕ, чем бандлы поднимают свои
// сервисы. Диагностика первого запуска показала:
//     apply entered
//     services: tools=false agents=false sessions=false agentPresets=false
//               workspaceRegistry=false sessionController=false
// то есть без inject плагин стартует в пустом окружении и молча ничего не
// делает — ровно так же «умер» tg-bridge, у которого объявлен только timer.
// Объявленные зависимости заставляют Cordis отложить apply до появления ВСЕХ
// перечисленных сервисов.
//
// ВАЖНО ПРО ДИАГНОСТИКУ: вывод console.* из плагинов НЕ попадает в логи
// приложения, поэтому плагин ведёт собственный журнал —
// `<DSH_HOME>/profiles/desktop/dsh-dev-department/role-sessions.log`, рядом с
// dev-department.log и role-permissions.log. Каталог и перенос со старого места
// называет `./state-paths.mjs`. Рядом с модулем журнал держать нельзя: в раскладке
// пакета модуль стоит в node_modules профиля, и файл исчезал бы при следующем
// `dsh plugin add`.

import fs from 'node:fs'
import { STATE_FILES, stateFile } from './state-paths.mjs'

function logPath() {
  return stateFile(STATE_FILES.roleSessions)
}

function trace(line) {
  try {
    fs.appendFileSync(logPath(), new Date().toISOString() + ' [role-sessions] ' + line + '\n')
  } catch (error) {
    // журналирование не должно ломать плагин
  }
}

trace('module evaluated')

const DEFAULT_FIRST_MESSAGE =
  'Представься коротко: кто ты, что входит в твою роль и какую часть работы ты не делаешь.'

function newSessionId() {
  const rnd = (n) => {
    let s = ''
    for (let i = 0; i < n; i += 1) s += Math.floor(Math.random() * 16).toString(16)
    return s
  }
  return 'session-' + rnd(8) + '-' + rnd(4) + '-4' + rnd(3) + '-a' + rnd(3) + '-' + rnd(12)
}

export default {
  // Жёсткие зависимости: без них плагин применяется до готовности хоста.
  inject: [
    'tools',
    'agents',
    'sessions',
    'agentPresets',
    'workspaceRegistry',
    'sessionController',
  ],

  apply(ctx) {
    trace('apply entered')
    try {
      const tools = ctx.get('tools')
      const agents = ctx.get('agents')
      const sessions = ctx.get('sessions')
      const agentPresets = ctx.get('agentPresets')
      const workspaceRegistry = ctx.get('workspaceRegistry')
      const sessionController = ctx.get('sessionController')

      trace('services: tools=' + String(!!tools) + ' agents=' + String(!!agents) +
        ' sessions=' + String(!!sessions) + ' agentPresets=' + String(!!agentPresets) +
        ' workspaceRegistry=' + String(!!workspaceRegistry) +
        ' sessionController=' + String(!!sessionController))

      if (!tools || !agents || !agentPresets || !workspaceRegistry || !sessionController || !sessions) {
        trace('ABORT: one or more required services are unavailable despite inject')
        return
      }

      function outputText() {
        return {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: String(value) }]
          },
        }
      }

      // Рабочая область: явный путь, иначе cwd вызывающей сессии.
      async function resolveWorkspace(exec, explicitPath) {
        const explicit = typeof explicitPath === 'string' ? explicitPath.trim() : ''
        let path = explicit
        if (!path) {
          const caller = exec && exec.agent
          if (caller) {
            const me = sessions.get(caller.id)
            if (me && me.header && me.header.cwd) path = me.header.cwd
          }
        }
        if (!path) {
          throw new Error('не удалось определить рабочую область: у вызывающей сессии нет cwd, и workspacePath не задан')
        }
        const known = await workspaceRegistry.resolveByPath(path)
        if (known) return known
        // Явный путь — осознанный выбор вызывающего: заводим рабочую область,
        // а не отказываем. create() бросит, если такого каталога нет.
        return workspaceRegistry.create(path, path.split(/[\\/]/).filter(Boolean).pop() || path)
        return workspace
      }

      const openTool = {
        name: 'open_role_session',
        description: [
          'Открыть НОВУЮ сессию на выбранном ролевом пресете (например dev или tester) в рабочей области вызывающего агента.',
          'Сессия создаётся, привязывается к рабочей области и получает первое сообщение, после чего видна в списке сессий.',
          'Возвращает id созданной сессии.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            preset: {
              type: 'string',
              description: 'Id пресета, например dev, tester или analyst. Полный список даёт list_agent_presets.',
            },
            firstMessage: {
              type: 'string',
              description: 'Необязательное первое сообщение. Если не задано, уходит короткая просьба представиться.',
            },
            workspacePath: {
              type: 'string',
              description: 'Необязательный абсолютный путь рабочей области. По умолчанию — cwd вызывающей сессии.',
            },
          },
          required: ['preset'],
          additionalProperties: false,
        },
        output: outputText(),
        async execute(args, exec) {
          try {
            const presetId = typeof args.preset === 'string' ? args.preset.trim() : ''
            if (!presetId) throw new Error('preset обязателен')
            trace('open_role_session: preset=' + presetId)

            // resolve() бросает, если такого пресета нет ни в одном корне.
            const preset = await agentPresets.resolve(presetId)
            const workspace = await resolveWorkspace(exec, args.workspacePath)
            trace('open_role_session: workspace=' + workspace.path)

            const sessionId = newSessionId()
            await agents.create({
              sessionId,
              meta: { cwd: workspace.path, agentPreset: preset.id },
              setup: async (agentCtx) => {
                await agentPresets.mount(agentCtx, preset.id)
              },
            })
            trace('open_role_session: created ' + sessionId)

            // Зачёт в рабочей области — без него сессия не попадает в список.
            await workspace.attachSession(sessionId)

            const explicit = typeof args.firstMessage === 'string' ? args.firstMessage.trim() : ''
            const firstMessage = explicit || DEFAULT_FIRST_MESSAGE
            const receipt = await sessionController.prompt(
              {
                requestId: 'role-session-' + sessionId,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: firstMessage }],
              },
              new AbortController().signal,
            )
            trace('open_role_session: prompted ' + sessionId)

            return JSON.stringify({
              ok: true,
              sessionId,
              preset: preset.id,
              workspace: workspace.path,
              firstMessage,
              accepted: !!(receipt && receipt.accepted),
            }, null, 2)
          } catch (error) {
            trace('open_role_session FAILED: ' + (error && error.stack ? error.stack : String(error)))
            throw error
          }
        },
      }

      const listTool = {
        name: 'list_agent_presets',
        description: 'Перечислить доступные ролевые пресеты агента: id, отображаемое имя, описание и источник.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: outputText(),
        async execute() {
          const rows = await agentPresets.list()
          return JSON.stringify(rows.map((p) => ({
            id: p.id,
            name: p.name,
            trust: p.trust,
            description: p.description,
          })), null, 2)
        },
      }

      ctx.effect(() => tools.register(openTool), 'role-sessions:open_role_session')
      ctx.effect(() => tools.register(listTool), 'role-sessions:list_agent_presets')
      trace('registrations issued')
    } catch (error) {
      trace('apply threw: ' + (error && error.stack ? error.stack : String(error)))
      throw error
    }
  },
}
