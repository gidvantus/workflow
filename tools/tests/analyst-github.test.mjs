// Проверка инструментов аналитика: сеть поддельная, реальный GitHub не трогаем.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const plugin = path.join(dshHome, '.agent-presets', 'analyst', 'github.mjs')
const home = path.join(process.cwd(), '.analyst-github-home')
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
let response = {
  number: 123,
  title: 'Проба',
  state: 'open',
  labels: [{ name: 'ready-for-dev' }],
  assignees: [],
  comments: 0,
  updated_at: '2026-09-25T12:00:00Z',
  html_url: 'https://github.com/gidvantus/vahta/issues/123',
  body: 'тело',
}
https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    calls.push({ method: options.method, path: options.path, body: payload ? JSON.parse(payload) : null, auth: options.headers && options.headers.Authorization })
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
  get: (name) => (name === 'tools' ? { register(tool) { tools.push(tool) } } : undefined),
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
  'gh_issue', 'gh_issue_comment', 'gh_issue_create', 'gh_issue_mockup',
  'gh_issues', 'gh_pr', 'gh_pr_create', 'gh_prs', 'project_info',
])
check('общего редактора меток у аналитика нет', !!byName('gh_issue_labels'), false)
check('gh_issue_create есть', !!byName('gh_issue_create'), true)

const created = JSON.parse(await byName('gh_issue_create').execute({
  title: 'Отпуск: замещение на срок',
  body: '## Промт для разработчика\n…\n\n## План работы\n…',
}))
check('метод и путь запроса', [calls[0].method, calls[0].path], ['POST', '/repos/gidvantus/vahta/issues'])
check('заголовок уехал как есть', calls[0].body.title, 'Отпуск: замещение на срок')
check('постановка не ставит меток', 'labels' in calls[0].body, false)
check('тело содержит оба раздела', /## Промт для разработчика/.test(calls[0].body.body) && /## План работы/.test(calls[0].body.body), true)
check('токен ушёл в заголовке, а не в теле', [calls[0].auth, 'token' in calls[0].body], ['Bearer test-token', false])
check('ответ разобран', { number: created.number, url: created.url, labels: created.labels }, {
  number: 123, url: 'https://github.com/gidvantus/vahta/issues/123', labels: ['ready-for-dev'],
})
check('токен не утёк в результат инструмента', JSON.stringify(created).includes('test-token'), false)

calls.length = 0
await byName('gh_issue_mockup').execute({ number: 123, needed: true })
check('пометка «нужен макет» ставит needs-mockup', [calls[0].method, calls[0].path, calls[0].body.labels], ['POST', '/repos/gidvantus/vahta/issues/123/labels', ['needs-mockup']])
calls.length = 0
await byName('gh_issue_mockup').execute({ number: 123, needed: false })
check('пометка снимается отдельным вызовом', [calls[0].method, calls[0].path], ['DELETE', '/repos/gidvantus/vahta/issues/123/labels/needs-mockup'])

calls.length = 0
await byName('gh_issue_create').execute({ title: 'Без метки', body: 'тело' })
check('без меток поле labels не отправляется', 'labels' in calls[0].body, false)

calls.length = 0
status = 403
response = { message: 'Resource not accessible by personal access token' }
let error = null
try {
  await byName('gh_issue_create').execute({ title: 'X', body: 'Y', labels: ['ready-for-dev'] })
} catch (e) { error = e.message }
check('ошибка GitHub объясняется словами', /GitHub 403: Resource not accessible/.test(error || ''), true)

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
