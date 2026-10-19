// Проверка инструментов код-ревьюера: сеть поддельная, реальный GitHub не трогаем.
// Главное здесь — gh_pr_comment (замечания пишутся в PR) и метка for-code-review
// в наборе меток конвейера.
// Запуск: node .code-review-tools-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const plugin = path.join(dshHome, '.agent-presets', 'code-review', 'github.mjs')
const home = path.join(process.cwd(), '.code-review-tools-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, 'github.token'), 'test-token\n')
// Инструменты определяют проект по рабочему каталогу сессии — берём текущий.
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  default: 'vahta',
  projects: { vahta: { repo: 'gidvantus/vahta', base: 'develop-m', workspace: process.cwd() } },
}, null, 2))
process.env.DSH_HOME = home

const calls = []
let status = 201
let response = { id: 5, html_url: 'https://github.com/gidvantus/vahta/issues/77#issuecomment-5' }
https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    calls.push({
      method: options.method,
      path: options.path,
      body: payload ? JSON.parse(payload) : null,
      auth: options.headers && options.headers.Authorization,
    })
    process.nextTick(() => {
      const body = JSON.stringify(response)
      const res = {
        statusCode: status,
        on(event, fn) {
          if (event === 'data') fn(body)
          if (event === 'end') process.nextTick(fn)
          return res
        },
      }
      callback(res)
    })
  },
})

const tools = []
const ctx = {
  get: (name) => {
    if (name === 'tools') return { register(tool) { tools.push(tool) } }
    // Проект определяется по рабочему каталогу вызывающей сессии.
    if (name === 'sessions') return { get: () => ({ header: { cwd: process.cwd() } }) }
    return undefined
  },
  effect(fn) { fn(); return () => {} },
}
const mod = await import('file:///' + plugin.replace(/\\/g, '/') + '?v=' + Date.now())
mod.default.apply(ctx)

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
const byName = (n) => tools.find((t) => t.name === n)

check('пресет зарегистрировал 9 инструментов', tools.map((t) => t.name).sort(), [
  'gh_issue', 'gh_issue_comment', 'gh_issue_labels', 'gh_issues',
  'gh_pr', 'gh_pr_comment', 'gh_pr_create', 'gh_prs', 'project_info',
])
check('gh_pr_comment есть', !!byName('gh_pr_comment'), true)

const posted = JSON.parse(await byName('gh_pr_comment').execute({ number: 77, body: 'FIX: 1\n\napp/api/x.py:42 — пустой список' }))
check('комментарий ушёл в обсуждение PR', [calls[0].method, calls[0].path], ['POST', '/repos/gidvantus/vahta/issues/77/comments'])
check('текст уехал как есть', calls[0].body.body.startsWith('FIX: 1'), true)
check('токен ушёл в заголовке', calls[0].auth, 'Bearer test-token')
check('ответ разобран', [posted.commentId, typeof posted.url], [5, 'string'])
check('токен не утёк в результат', JSON.stringify(posted).includes('test-token'), false)

calls.length = 0
status = 200
response = { number: 77, labels: [{ name: 'ready-for-test' }], state: 'open' }
await byName('gh_issue_labels').execute({ number: 77, add: ['ready-for-test'], remove: ['for-code-review'] })
check('метки: добавление и снятие', [calls[0].method, calls[0].path, calls[1].method], ['POST', '/repos/gidvantus/vahta/issues/77/labels', 'DELETE'])
check('снята именно for-code-review', calls[1].path, '/repos/gidvantus/vahta/issues/77/labels/for-code-review')

status = 200
response = {}
calls.length = 0
const info = JSON.parse(await byName('project_info').execute({}, { agent: { id: 'session-1' } }))
check('project_info отдаёт метку ревью', info.labels.review, 'for-code-review')
check('project_info отдаёт метку теста', info.labels.test, 'ready-for-test')
check('project_info отдаёт маршрут дизайнера', info.labels.design, 'ready-for-design')
check('project_info называет проект по рабочей области', info.resolvedFrom, 'рабочая область сессии')

status = 403
response = { message: 'Resource not accessible by personal access token' }
let error = null
try {
  await byName('gh_pr_comment').execute({ number: 77, body: 'x' })
} catch (e) { error = e.message }
check('ошибка GitHub объясняется словами', /GitHub 403: Resource not accessible/.test(error || ''), true)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
