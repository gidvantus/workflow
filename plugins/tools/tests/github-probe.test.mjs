// Проверка пробы прав на правку комментария (tools/github-probe.mjs, сценарий 3).
// Сеть поддельная, реальный GitHub не трогаем.
//
// Что здесь важно и почему именно это:
//   - проба ПИШЕТ, поэтому её цель — самый ДАВНИЙ свой комментарий: самый свежий
//     в живом репозитории это вердикт ревьюера или чеклист, по которому
//     диспетчер строит маршрут доработок;
//   - в свой комментарий уходит обратно ровно его прежнее тело, и проба обязана
//     увидеть его вернувшимся тем же: на этом стоит `tick` — подмена только
//     маркера `- [ ]` → `- [x]`, при которой вложения и текст автора не теряются;
//   - чужой по автору комментарий не правится ВООБЩЕ: `PATCH {}` в GitHub
//     отвечает 422, а не 403, поэтому права по нему не видно, а цена ошибки —
//     переписанный чужой текст;
//   - «одна учётка у ролей» не выводится из пустоты: пустой список и непрочитанный
//     список не доказывают схему галочек, и отчёт не должен звучать как приговор;
//   - нечитаемый реестр проектов — отказ, а не запасной список репозиториев:
//     проба, которая пишет, не выбирает себе цель сама;
//   - токен в результат пробы не попадает.
// Запуск: node github-probe.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

// Модуль пробы импортируется в обход CLI: main() под `invokedDirectly` и живой
// GitHub отсюда не дёргается.
const mod = await import('file:///' + fileURLToPath(new URL('../github-probe.mjs', import.meta.url)).replace(/\\/g, '/') + '?v=' + Date.now())

const calls = []
let statuses = {}
let bodies = {}
function fake() {
  https.request = (options, callback) => ({
    on() { return this },
    setTimeout() { return this },
    destroy() { return this },
    end(payload) {
      calls.push({ method: options.method, path: options.path, body: payload ? JSON.parse(payload) : null, auth: options.headers && options.headers.Authorization })
      const key = options.method + ' ' + options.path.split('?')[0]
      const status = statuses[key] === undefined ? 200 : statuses[key]
      const value = bodies[key] === undefined ? {} : bodies[key]
      process.nextTick(() => {
        const text = JSON.stringify(typeof value === 'function' ? value(payload ? JSON.parse(payload) : null) : value)
        const res = {
          statusCode: status,
          on(event, fn) {
            if (event === 'data') fn(text)
            if (event === 'end') process.nextTick(fn)
            return res
          },
        }
        callback(res)
      })
    },
  })
}

const original = https.request
fake()

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}

// Тело своего комментария — с чеклистом и вложением, как у ревьюера: проба
// обязана увидеть его вернувшимся байт в байт.
const oldBody = '**Роль:** код-ревьюер · вердикт FIX: 1\nFIX: 1\n\n### Бэкенд\n- [ ] Б1 · `backend/api/x.py:42` — пустой список\n\n![Скриншот](https://github.com/gidvantus/vahta/assets/1.png)'
const newestBody = '**Роль:** тестировщик · вердикт RED\n\n### Бэкенд\n- [x] Б1 · закрыто'
const foreignBody = '**Роль:** тестировщик · вердикт RED\n\n### Фронтенд\n- [ ] Ф1 · `frontend/src/pages/Vacancy.tsx:41` — пусто'

const USER = 'GET /user'
const LIST = 'GET /repos/gidvantus/vahta/issues/comments'
const REPO = 'GET /repos/gidvantus/vahta'
const oldPatch = 'PATCH /repos/gidvantus/vahta/issues/comments/901'
const foreignPatch = 'PATCH /repos/gidvantus/vahta/issues/comments/902'

function reset(nextStatuses, nextBodies) {
  calls.length = 0
  statuses = nextStatuses || {}
  bodies = nextBodies || {}
}

const call = (method, path, payload) => mod.apiCall('test-token', method, path, payload)

// 1. Право есть: правится самый ДАВНИЙ свой комментарий, а не самый свежий.
//    Порядок в списке — как отдаёт GitHub: `sort=updated`, от свежих к давним.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = [
  { id: 905, user: { login: 'robot' }, body: newestBody },
  { id: 902, user: { login: 'gidvantus' }, body: foreignBody },
  { id: 901, user: { login: 'robot' }, body: oldBody },
]
bodies[oldPatch] = (sent) => ({ id: 901, body: sent.body })
bodies[REPO] = { permissions: { admin: false, push: true, pull: true } }
const rights = await mod.probeCommentRights(call, 'gidvantus/vahta')

check('цель — давний свой комментарий', [rights.me, rights.own.id], ['robot', 901])
check('свежий свой комментарий не патчился', calls.filter((c) => c.path === '/repos/gidvantus/vahta/issues/comments/905').length, 0)
check('вердикт по своему комментарию назван словами', /право на правку комментария ЕСТЬ/.test(rights.own.verdict), true)
check('тело вернулось байт в байт', rights.own.byteExact, true)
check('в PATCH ушло ровно его тело', calls.find((c) => c.path === '/repos/gidvantus/vahta/issues/comments/901').body, { body: oldBody })
check('авторы комментариев перечислены', rights.authors, ['robot', 'gidvantus'])
check('разные учётки видны', rights.sameAccount, false)
check('автор чужого комментария назван', [rights.foreign.id, rights.foreign.author], [902, 'gidvantus'])
check('чужой комментарий назван неприкосновенным', /текст автора неприкосновенен/.test(rights.foreign.verdict), true)
check('права токена прочитаны', rights.permissions, { admin: false, push: true, pull: true })

// 2. Чужой текст не правится: на его путь не уходит НИ ОДНОГО запроса.
check('чужой комментарий не патчился', calls.filter((c) => c.path === '/repos/gidvantus/vahta/issues/comments/902').length, 0)
check('тело чужого автора не покидало пробу', calls.some((c) => JSON.stringify(c.body || {}).includes('frontend/src/pages/Vacancy.tsx')), false)

// 3. Расхождение тела — это провал, а не «почти нормально»: иначе `tick` молча
//    терял бы вложения тестировщика.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = [{ id: 901, user: { login: 'robot' }, body: oldBody }]
bodies[oldPatch] = (sent) => ({ id: 901, body: String(sent.body).replace('![Скриншот](https://github.com/gidvantus/vahta/assets/1.png)', '') })
bodies[REPO] = { permissions: { push: true } }
const lossy = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('потерянный markdown виден как провал возврата', lossy.own.byteExact, false)
check('единственный автор и он же учётка токена — «одна учётка: да»', lossy.sameAccount, true)
check('без чужих комментариев ограничение названо', /комментариев других авторов нет/.test(lossy.foreign.verdict), true)

// 4. 403 на своём комментарии — схему галочек надо переделывать до кода.
reset({ [oldPatch]: 403 })
bodies[USER] = { login: 'robot' }
bodies[LIST] = [{ id: 901, user: { login: 'robot' }, body: oldBody }]
bodies[REPO] = { permissions: { pull: true } }
const denied = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('403 на своём назван отказом', /права НЕТ \(403\)/.test(denied.own.verdict), true)
check('и побайтовый возврат не выдан за успех', denied.own.byteExact, false)

// 5. Своего комментария нет — проба честно говорит, что возврат не проверен.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = [{ id: 902, user: { login: 'gidvantus' }, body: foreignBody }]
bodies[REPO] = { permissions: { push: true } }
const noOwn = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('без своего комментария возврат не проверен', /побайтовый возврат не проверен/.test(noOwn.own.verdict), true)
check('и PATCH не отправлялся', calls.filter((c) => c.method === 'PATCH').length, 0)
check('единственный автор — чужой: «одна учётка» не доказана', noOwn.sameAccount, false)

// 6. Пустой список комментариев — это не «одна учётка: да»: проверять нечего.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = []
bodies[REPO] = { permissions: { push: true } }
const empty = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('на пустом списке «одна учётка» не доказана', empty.sameAccount, false)
check('и сеть не дёргается на PATCH', calls.filter((c) => c.method === 'PATCH').length, 0)
check('отчёт про пустой список без приговора схеме', mod.reportLines(empty), [
  'gidvantus/vahta: комментариев в репозитории нет — учётку ролей и побайтовый возврат проверить нечем',
])

// 7. Нечитанный список — только проблема, без строк про авторов и про свой
//    комментарий: иначе читатель видит приговор схеме там, где данных не было.
reset({ [LIST]: 500 })
bodies[USER] = { login: 'robot' }
const broken = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('нечитаемый ответ назван проблемой', /список комментариев не прочитан: статус 500/.test(broken.problem || ''), true)
check('и после проблемы сеть больше не дёргается', calls.length, 2)
check('на нечитанном списке «одна учётка» не доказана', broken.sameAccount, false)
check('в отчёте одна строка — про проблему', mod.reportLines(broken).length, 1)
check('и в ней нет слов про учётку', /одна учётка/.test(mod.reportLines(broken)[0]), false)

// 8. Строки отчёта при нормальных данных: свой комментарий, авторы, чужой.
const full = mod.reportLines(rights)
check('строк отчёта три (свой, авторы, чужой)', full.length, 3)
check('в первой строке давний комментарий', full[0].includes('#901'), true)
check('во второй строке авторы и push', [full[1].includes('авторов комментариев 2'), full[1].includes('push: true')], [true, true])

// 9. Реестр проектов: «не прочитан» и «пуст» — разные ответы, и ни один не
//    подменяется захардкоженным списком. Путь к реестру собирает модуль состояния
//    отдела: файл лежит в каталоге профиля, а не в корне каталога установки.
const home = path.join(process.cwd(), '.github-probe-home')
const stateDir = path.join(home, 'profiles', 'desktop', 'dsh-dev-department')
const registryFile = path.join(stateDir, 'projects.json')
const prevHome = process.env.DSH_HOME
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(stateDir, { recursive: true })
process.env.DSH_HOME = home
fs.writeFileSync(registryFile, '{ это не json')
const registryBroken = await mod.reposFromRegistry()
check('нечитаемый реестр назван проблемой', /не читается реестр проектов/.test(registryBroken.problem || ''), true)
check('и репозиториев из него не берётся', registryBroken.repos, [])
fs.writeFileSync(registryFile, JSON.stringify({ default: 'a', projects: { a: { repo: '' } } }))
const registryEmpty = await mod.reposFromRegistry()
check('реестр без repo — отдельная проблема', /нет ни одного проекта с repo/.test(registryEmpty.problem || ''), true)
fs.writeFileSync(registryFile, JSON.stringify({
  default: 'a',
  projects: { a: { repo: 'o/a' }, b: { repo: 'o/b' }, c: { repo: 'o/a' } },
}))
const registryOk = await mod.reposFromRegistry()
check('репозитории из реестра без повторов', [registryOk.repos, registryOk.problem], [['o/a', 'o/b'], null])
fs.rmSync(home, { recursive: true, force: true })
if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome

// 10. Коды, которых проба не ждёт, остаются названными кодами.
check('404 — комментарий не найден', mod.commentRightVerdict(404), 'комментарий не найден (404) — право проверить не удалось')
check('500 назван кодом', /код 500/.test(mod.commentRightVerdict(500)), true)

// 11. Токен в результат пробы не попадает, а в запросы уходит заголовком.
check('токен не утёк', JSON.stringify(rights).includes('test-token'), false)
check('и в запросы уходил заголовком', calls.some((c) => c.auth === 'Bearer test-token'), true)

https.request = original
console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
process.exit(failures === 0 ? 0 : 1)
