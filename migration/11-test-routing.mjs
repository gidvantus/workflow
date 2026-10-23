// Тест роутинга отдела по проектам на изолированном реестре.
// Поднимает диспетчер с подменённым DSH_HOME, поэтому реальный реестр,
// токен и GitHub не затрагиваются: обращения к GitHub падают на отсутствии
// токена и корректно ловятся по каждому проекту.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WORK = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', 'tmp-home')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'profiles', 'desktop', 'plugins'), { recursive: true })

// Рабочие области: диспетчер требует существующий git-клон, поэтому заводим
// каталоги и пустой .git. gamma и epsilon намеренно делят одну область.
const WS = path.join(WORK, 'ws')
const ws = (id) => path.join(WS, id)
for (const id of ['alpha', 'gamma', 'beta']) fs.mkdirSync(path.join(ws(id), '.git'), { recursive: true })

fs.writeFileSync(path.join(WORK, 'projects.json'), JSON.stringify({
  default: 'alpha',
  projects: {
    alpha: {
      title: 'Alpha',
      repo: 'acme/alpha',
      base: 'develop',
      workspace: ws('alpha'),
      composeProject: 'alpha-agent',
      department: {
        enabled: true,
        windows: [{ start: '09:00', stop: '18:00' }],
        maxRework: 2,
        maxAttempts: 5,
        stuckAfterMinutes: 15,
      },
    },
    beta: { title: 'Beta', repo: 'acme/beta', base: 'main', workspace: ws('beta'), department: { enabled: false } },
    gamma: { title: 'Gamma', repo: 'acme/gamma', base: 'main', workspace: ws('gamma') },
    delta: { title: 'Delta', repo: '', base: 'main', workspace: ws('delta') },
    epsilon: { title: 'Epsilon', repo: 'acme/epsilon', base: 'main', workspace: ws('gamma') },
    zeta: { title: 'Zeta', repo: 'acme/zeta', base: 'main', workspace: ws('zeta') },
  },
}, null, 2))

fs.writeFileSync(path.join(WORK, 'dev-department.json'), JSON.stringify({
  windows: [{ start: '13:00', stop: '04:00' }],
  maxRework: 3,
  maxAttempts: 4,
  stuckAfterMinutes: 30,
}, null, 2))

const source = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', '08-dev-department-v2.mjs')
fs.copyFileSync(source, path.join(WORK, 'profiles', 'desktop', 'plugins', 'dev-department.mjs'))

// Важно: DSH_HOME выставляется ДО импорта — dshHome() читается лениво.
process.env.DSH_HOME = WORK
const mod = await import(pathToFileURL(path.join(WORK, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')).href)

const registered = []
const ctx = {
  get: (name) => {
    switch (name) {
      case 'tools': return { register: (def) => { registered.push(def); return () => {} } }
      case 'timer': return { interval: () => () => {} }
      case 'sessions': return { get: () => undefined }
      case 'agents': return { create: async () => ({ agent: {} }), get: () => undefined }
      case 'agentPresets': return { mount: async () => ({ id: 'stub' }) }
      case 'workspaceRegistry': return { resolveByPath: async () => undefined, create: async (p) => ({ path: p, attachSession: async () => {} }) }
      case 'sessionController': return { list: async () => ({ items: [] }), inspect: async () => ({}), prompt: async () => {}, cancel: async () => {} }
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
const status = registered.filter((d) => d.name === 'dev_department_status')[0]
const report = JSON.parse(await status.execute({}))

console.log('обслуживаются : ' + JSON.stringify(report.registry.serving))
console.log('выключены     : ' + JSON.stringify(report.registry.disabled))
console.log('проблемы      : ' + report.registry.problem)
console.log('')
for (const p of report.projects) {
  console.log([
    p.id.padEnd(8),
    'расписание=' + p.department.windows.padEnd(14),
    'источник=' + p.department.windowsSource.padEnd(6),
    'открыто=' + String(p.department.openNow).padEnd(5),
    'maxRework=' + p.department.maxRework,
    'maxAttempts=' + p.department.maxAttempts,
    'stuck=' + p.department.stuckAfterMinutes,
  ].join('  '))
}
