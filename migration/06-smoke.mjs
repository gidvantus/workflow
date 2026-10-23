// Дымовой тест многопроектного диспетчера: поднимает плагин на заглушках ctx и
// вызывает инструмент dev_department_status. Проверяет, что реестр проектов
// читается, метки и рабочие области подставляются, а один упавший проект не
// роняет остальные. Сессии не создаются: dispatch не вызывается.

import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const target = pathToFileURL(path.join(HOME, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')).href
const mod = await import(target)

const registered = []
const created = []

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
        create: async (p) => { created.push(p); return { path: p, attachSession: async () => {} } },
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
if (!status) throw new Error('dev_department_status не зарегистрирован')

const report = JSON.parse(await status.execute({}))
console.log(JSON.stringify({
  shiftConfigProblem: report.shiftConfig.problem,
  window: report.window,
  inWindow: report.inWindow,
  projectsProblem: report.projectsRegistry.problem,
  serving: report.projectsRegistry.serving.map((p) => ({ id: p.id, repo: p.repo, base: p.base, workspace: p.workspace, compose: p.composeProject, labels: p.labels })),
  projects: report.projects.map((p) => ({
    id: p.id,
    nextStep: p.nextStep,
    githubError: p.github ? p.github.error : null,
    activeIssue: p.activeIssue,
    queued: p.queuedForDev ? p.queuedForDev.length : null,
  })),
  lastError: report.lastError,
  dialogs: report.dialogs,
  workspacesCreated: created,
}, null, 2))
