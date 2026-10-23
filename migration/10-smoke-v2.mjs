// Дымовой тест диспетчера v2: своя смена у каждого проекта.
// Поднимает плагин на заглушках ctx и вызывает dev_department_status.
// Сессии не создаются: dispatch не вызывается.

import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const target = pathToFileURL(path.join(HOME, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')).href
const mod = await import(target)

const registered = []

const ctx = {
  get: (name) => {
    switch (name) {
      case 'tools': return { register: (def) => { registered.push(def); return () => {} } }
      case 'timer': return { interval: () => () => {} }
      case 'sessions': return { get: () => undefined }
      case 'agents': return { create: async () => ({ agent: {} }), get: () => undefined }
      case 'agentPresets': return { mount: async () => ({ id: 'stub' }) }
      case 'workspaceRegistry': return {
        resolveByPath: async () => ({ path: 'stub', attachSession: async () => {} }),
        create: async (p) => ({ path: p, attachSession: async () => {} }),
      }
      case 'sessionController': return {
        list: async () => ({ items: [] }),
        inspect: async () => ({}),
        prompt: async () => {},
        cancel: async () => {},
      }
      case 'permissionPresets': return { set: () => {}, current: () => '' }
      case 'sessionTitle': return { rename: () => {} }
      default: return undefined
    }
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: () => () => {},
  on: () => () => {},
}

mod.default.apply(ctx)
console.log('инструменты: ' + registered.map((d) => d.name).join(', '))

const status = registered.filter((d) => d.name === 'dev_department_status')[0]
const report = JSON.parse(await status.execute({}))

console.log(JSON.stringify({
  sharedConfigProblem: report.sharedConfig.problem,
  sharedWindows: report.sharedConfig.values.windows,
  sharedLimits: {
    maxRework: report.sharedConfig.values.maxRework,
    maxAttempts: report.sharedConfig.values.maxAttempts,
    stuckAfterMinutes: report.sharedConfig.values.stuckAfterMinutes,
  },
  registryProblem: report.registry.problem,
  serving: report.registry.serving,
  disabled: report.registry.disabled,
  projects: report.projects.map((p) => ({
    id: p.id,
    repo: p.repo,
    base: p.base,
    department: p.department,
    shift: p.shift,
    nextStep: p.nextStep,
    activeIssue: p.activeIssue,
    githubError: p.github ? p.github.error : null,
  })),
  lastError: report.lastError,
}, null, 2))
