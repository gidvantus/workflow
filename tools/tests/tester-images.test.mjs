// Проверка вложений в комментарий тестировщика: сеть поддельная.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const plugin = path.join(dshHome, '.agent-presets', 'tester', 'github.mjs')
const home = path.join(process.cwd(), '.tester-images-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, 'github.token'), 'test-token\n')
// Инструменты определяют проект по рабочему каталогу сессии — берём текущий.
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  default: 'vahta',
  projects: { vahta: { repo: 'gidvantus/vahta', base: 'develop-m', workspace: process.cwd() } },
}, null, 2))
process.env.DSH_HOME = home

// Картинка для проверки: содержимое не важно, важны расширение и байты.
const png = Buffer.alloc(4096, 7)
fs.writeFileSync(path.join(process.cwd(), '.probe-a.png'), png)
fs.writeFileSync(path.join(process.cwd(), '.probe-b.png'), png)
fs.writeFileSync(path.join(process.cwd(), '.probe.txt'), 'это не картинка')

const calls = []
let uploadCounter = 0
https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    const isUpload = options.host === 'uploads.github.com'
    const record = {
      host: options.host,
      method: options.method,
      path: options.path,
      auth: options.headers && options.headers.Authorization,
      contentType: options.headers && options.headers['Content-Type'],
      body: isUpload ? null : (payload ? JSON.parse(payload) : null),
      bytes: isUpload ? payload.length : null,
    }
    calls.push(record)
    let status = 200
    let answer = {}
    if (isUpload) {
      uploadCounter += 1
      status = 201
      answer = { url: 'https://github.com/user-attachments/assets/probe-' + uploadCounter }
    } else if (/\/repos\/[^/]+\/[^/]+$/.test(options.path)) {
      answer = { id: 424242 }
    } else if (/\/comments$/.test(options.path)) {
      status = 201
      answer = { id: 555, html_url: 'https://github.com/gidvantus/vahta/issues/77#issuecomment-555' }
    }
    process.nextTick(() => {
      const body = JSON.stringify(answer)
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
const comment = tools.find((t) => t.name === 'gh_issue_comment')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// ── две картинки: адреса вставляются в текст ───────────────────────────────
calls.length = 0
const first = JSON.parse(await comment.execute({ number: 77, body: 'Вердикт: GREEN', images: ['.probe-a.png', '.probe-b.png'] }))
const uploads = calls.filter((c) => c.host === 'uploads.github.com')
const idReads = calls.filter((c) => /\/repos\/[^/]+\/[^/]+$/.test(c.path) && c.method === 'GET')
const posted = calls.filter((c) => /\/comments$/.test(c.path))[0]
check('обе картинки загружены', uploads.length, 2)
check('id репозитория прочитан один раз', idReads.length, 1)
check('метод и путь загрузки', [uploads[0].method, uploads[0].path.split('?')[0]], ['POST', '/user-attachments/assets'])
check('имя, тип и id репозитория в запросе',
  [uploads[0].path.includes('name=.probe-a.png'), uploads[0].path.includes('content_type=image%2Fpng'), uploads[0].path.includes('repository_id=424242')],
  [true, true, true])
check('Content-Type картинки обязателен', uploads[0].contentType, 'image/png')
check('токен ушёл в заголовке, тело — только байты', [uploads[0].auth, uploads[0].body, uploads[0].bytes], ['Bearer test-token', null, png.length])
check('ссылки вставлены в комментарий',
  [posted.body.body.includes('probe-1'), posted.body.body.includes('probe-2')], [true, true])
check('результат вернул вложения', first.attached.length, 2)

// ── ссылка на файл в тексте подменяется адресом GitHub ────────────────────
calls.length = 0
await comment.execute({
  number: 77,
  body: 'Смотри ![до](.probe-a.png) и всё',
  images: ['.probe-a.png'],
})
const mdPosted = calls.filter((c) => /\/comments$/.test(c.path))[0]
check('локальный путь заменён, а не продублирован',
  [mdPosted.body.body.includes('![до](https://github.com/user-attachments/assets/probe-'), mdPosted.body.body.includes('.probe-a.png')],
  [true, false])
check('вложение ушло ровно одно', calls.filter((c) => c.host === 'uploads.github.com').length, 1)

// ── не-картинка не съедает вердикт ────────────────────────────────────────
calls.length = 0
const withBad = JSON.parse(await comment.execute({ number: 77, body: 'Вердикт: RED', images: ['.probe.txt'] }))
const postedBad = calls.filter((c) => /\/comments$/.test(c.path))[0]
check('комментарий отправлен, несмотря на мусор', !!postedBad, true)
check('в тексте отмечено, что не приложилось',
  [withBad.failed.length, /Не приложилось/.test(postedBad.body.body)], [1, true])
check('на не-картинку не было запроса в uploads', calls.filter((c) => c.host === 'uploads.github.com').length, 0)

// ── без картинок поведение прежнее ────────────────────────────────────────
calls.length = 0
await comment.execute({ number: 77, body: 'Просто текст' })
check('без images нет ни одного запроса в uploads', calls.filter((c) => c.host === 'uploads.github.com').length, 0)
check('текст ушёл как есть', calls.filter((c) => /\/comments$/.test(c.path))[0].body.body, 'Просто текст')

// ── защита от ведра картинок ──────────────────────────────────────────────
try {
  await comment.execute({ number: 77, body: 'x', images: new Array(7).fill('.probe-a.png') })
} catch (error) {
  check('семь картинок отвергаются', /максимум 6/.test(error.message), true)
}

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(path.join(process.cwd(), '.probe-a.png'), { force: true })
fs.rmSync(path.join(process.cwd(), '.probe-b.png'), { force: true })
fs.rmSync(path.join(process.cwd(), '.probe.txt'), { force: true })
process.exit(failures === 0 ? 0 : 1)
