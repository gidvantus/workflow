// Тест проекта без репозитория (Brain).
//
// Проверяет, что пресет на проекте без repo:
//   - отдаёт project_info с repo: null;
//   - отказывает в инструментах GitHub с внятной причиной, а не строит
//     путь /repos//issues/…;
//   - при этом на проекте с repo работает как обычно.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REAL_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const WORK = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration', 'tmp-home')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'profiles', 'desktop', 'plugins'), { recursive: true })

const PLAIN = path.join(WORK, 'ws', 'plain')
const REPO = path.join(WORK, 'ws', 'withrepo')
fs.mkdirSync(PLAIN, { recursive: true })

fs.writeFileSync(path.join(WORK, 'projects.json'), JSON.stringify({
  default: 'plain',
  projects: {
    plain: { title: 'Brain', workspace: PLAIN, department: { enabled: false } },
    withrepo: { title: 'Other', repo: 'acme/other', base: 'main', workspace: REPO, department: { enabled: false } },
  },
}, null, 2))

fs.copyFileSync(
  path.join(REAL_HOME, '.agent-presets', 'dev', 'github.mjs'),
  path.join(WORK, 'profiles', 'desktop', 'plugins', 'github.mjs'),
)

process.env.DSH_HOME = WORK
const mod = await import(pathToFileURL(path.join(WORK, 'profiles', 'desktop', 'plugins', 'github.mjs')).href)

const registered = []
let cwd = PLAIN
const ctx = {
  get: (name) => {
    if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
    if (name === 'sessions') return { get: () => ({ header: { cwd } }) }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}

mod.default.apply(ctx)
console.log('инструменты: ' + registered.map((d) => d.name).join(', '))

const byName = (n) => registered.filter((d) => d.name === n)[0]
const exec = { agent: { id: 'sess-1' } }

async function tryTool(name, args) {
  try {
    return { ok: true, value: JSON.parse(await byName(name).execute(args, exec)) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

console.log('')
console.log('=== проект без repo (brain) ===')
const info = await tryTool('project_info', {})
console.log('  project_info → ok=' + info.ok + ', id=' + info.value.id + ', repo=' + JSON.stringify(info.value.repo) +
  ', humanClone=' + JSON.stringify(info.value.humanClone))
const issue = await tryTool('gh_issue', { number: 1 })
console.log('  gh_issue     → ok=' + issue.ok)
console.log('  причина      : ' + issue.error)
const labels = await tryTool('gh_issue_labels', { number: 1, add: ['in-progress'] })
console.log('  gh_issue_labels → ok=' + labels.ok)

console.log('')
console.log('=== проект с repo (other) ===')
cwd = REPO
const info2 = await tryTool('project_info', {})
console.log('  project_info → id=' + info2.value.id + ', repo=' + JSON.stringify(info2.value.repo))
const issue2 = await tryTool('gh_issue', { number: 1 })
console.log('  gh_issue     → ok=' + issue2.ok + (issue2.ok ? ' (ушёл в сеть, поэтому ждём ошибку сети)' : ''))
console.log('  результат    : ' + (issue2.ok ? 'получен ответ' : issue2.error.slice(0, 90)))
