// Проверка инструмента правки тела PR у разработчиков: gh_pr_edit.
// Сеть поддельная, реальный GitHub не трогаем.
//
// Что здесь важно и почему именно это:
//   - PATCH уходит на путь pull request, а не issue и не labels;
//   - тело уезжает ровно тем, что передали: правка «по памяти» потеряла бы
//     разделы прочитанного тела, и ревьюер читал бы не то, что на самом деле;
//   - частичное обновление не стирает непереданное поле;
//   - пустой набор полей — отказ ДО сетевого запроса;
//   - ошибка GitHub объясняется словами, токен не утекает в результат.
// Запуск: node dev-edit-tools.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const plugin = path.join(dshHome, '.agent-presets', 'dev-fullstack', 'github.mjs')
const home = path.join(process.cwd(), '.dev-edit-tools-home')
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
let status = 200
let response = {
  number: 77,
  title: 'Отписка (#77)',
  body: 'Что сделано: кнопка отписки\n\nКак проверять: открыть письмо',
  html_url: 'https://github.com/gidvantus/vahta/pull/77',
}
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
  'gh_pr', 'gh_pr_create', 'gh_pr_edit', 'gh_prs', 'project_info',
])
check('gh_pr_edit есть', !!byName('gh_pr_edit'), true)
check('gh_pr_edit обязателен только number', byName('gh_pr_edit').parameters.required, ['number'])
check('gh_pr_edit не принимает лишних полей', byName('gh_pr_edit').parameters.additionalProperties, false)
check('gh_pr_edit знает только number, title, body', Object.keys(byName('gh_pr_edit').parameters.properties).sort(), ['body', 'number', 'title'])

// 1. Замена тела целиком: уходит ровно переданная строка.
const newBody = 'Что сделано: кнопка отписки и подтверждение\n\nКак проверять: открыть письмо, нажать «Отписаться»\n\nCloses #77'
const updated = JSON.parse(await byName('gh_pr_edit').execute({ number: 77, body: newBody }))
check('PATCH на путь pull request', [calls[0].method, calls[0].path], ['PATCH', '/repos/gidvantus/vahta/pulls/77'])
check('тело уехало ровно переданным', calls[0].body.body, newBody)
check('в PATCH только переданное поле', Object.keys(calls[0].body), ['body'])
check('ответ из четырёх полей', Object.keys(updated).sort(), ['body', 'number', 'title', 'url'])
check('номер и ссылка в ответе', [updated.number, typeof updated.url], [77, 'string'])
check('токен ушёл в заголовке', calls[0].auth, 'Bearer test-token')
check('токен не утёк в результат', JSON.stringify(updated).includes('test-token'), false)

// 2. Только заголовок: тело не передаётся и не стирается.
calls.length = 0
await byName('gh_pr_edit').execute({ number: 77, title: 'Отписка в письме (#77)' })
check('обновление только заголовка не шлёт body', calls[0].body, { title: 'Отписка в письме (#77)' })
check('путь тот же', [calls[0].method, calls[0].path], ['PATCH', '/repos/gidvantus/vahta/pulls/77'])

// 3. Только тело: заголовок не передаётся.
calls.length = 0
await byName('gh_pr_edit').execute({ number: 77, body: 'только тело' })
check('обновление только тела не шлёт title', calls[0].body, { body: 'только тело' })

// 4. Оба поля сразу — оба и уходят.
calls.length = 0
await byName('gh_pr_edit').execute({ number: 77, title: 'Заголовок', body: 'Тело' })
check('оба поля уходят вместе', calls[0].body, { title: 'Заголовок', body: 'Тело' })

// 5. Ни одного поля — ошибка до сетевого запроса.
calls.length = 0
let error = null
try {
  await byName('gh_pr_edit').execute({ number: 77 })
} catch (e) { error = e.message }
check('пустой вызов объяснён словами', /title и\/или body/.test(error || ''), true)
check('пустой вызов не дошёл до сети', calls.length, 0)

// 6. Пустая строка — это переданное поле: очистка тела разрешена.
calls.length = 0
await byName('gh_pr_edit').execute({ number: 77, body: '' })
check('пустая строка уходит как значение', calls[0].body, { body: '' })

// 7. Ошибка GitHub объясняется словами, без повторов.
calls.length = 0
status = 403
response = { message: 'Resource not accessible by personal access token' }
error = null
try {
  await byName('gh_pr_edit').execute({ number: 77, body: 'x' })
} catch (e) { error = e.message }
check('ошибка GitHub объясняется словами', /GitHub 403: Resource not accessible/.test(error || ''), true)
check('на ошибке был ровно один запрос', calls.length, 1)
check('токен не утёк в текст ошибки', (error || '').includes('test-token'), false)

// 8. Чужой репозиторий и чужой номер: путь собирается из проекта и номера.
status = 200
response = { number: 5, title: 'X', body: 'Y', html_url: 'u' }
calls.length = 0
await byName('gh_pr_edit').execute({ number: 5, title: 'X' })
check('номер из аргумента, репозиторий из проекта', calls[0].path, '/repos/gidvantus/vahta/pulls/5')

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
