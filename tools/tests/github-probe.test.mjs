// Проверка пробы прав на правку комментария (tools/github-probe.mjs, сценарий 3).
// Сеть поддельная, реальный GitHub не трогаем.
//
// Что здесь важно и почему именно это:
//   - в СВОЙ комментарий уходит обратно ровно его прежнее тело, и проба обязана
//     увидеть его вернувшимся тем же: на этом стоит `tick` — подмена только
//     маркера `- [ ]` → `- [x]`, при которой вложения и текст автора не теряются;
//   - чужой по автору комментарий не правится ВООБЩЕ: `PATCH {}` в GitHub
//     отвечает 422, а не 403, поэтому права по нему не видно, а цена ошибки —
//     переписанный чужой текст. Проба называет автора и молчит;
//   - ответ «все комментарии одной учётки» — это и есть основание схемы
//     «галочки ставит разработчик»: все роли отдела ходят одним токеном;
//   - 403 на своём комментарии — «схему галочек надо переделывать», и это
//     должно называться словами, а не кодом;
//   - токен в результат пробы не попадает.
// Запуск: node github-probe.test.mjs
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
const ownBody = '**Роль:** код-ревьюер · вердикт FIX: 1\nFIX: 1\n\n### Бэкенд\n- [ ] Б1 · `backend/api/x.py:42` — пустой список\n\n![Скриншот](https://github.com/gidvantus/vahta/assets/1.png)'
const foreignBody = '**Роль:** тестировщик · вердикт RED\n\n### Фронтенд\n- [ ] Ф1 · `frontend/src/pages/Vacancy.tsx:41` — пусто'

const USER = 'GET /user'
const LIST = 'GET /repos/gidvantus/vahta/issues/comments'
const REPO = 'GET /repos/gidvantus/vahta'
const ownPatch = 'PATCH /repos/gidvantus/vahta/issues/comments/901'
const foreignPatch = 'PATCH /repos/gidvantus/vahta/issues/comments/902'

function reset(nextStatuses, nextBodies) {
  calls.length = 0
  statuses = nextStatuses || {}
  bodies = nextBodies || {}
}

const call = (method, path, payload) => mod.apiCall('test-token', method, path, payload)

// 1. Право есть: свой комментарий принимает PATCH, тело возвращается прежним.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = [
  { id: 901, user: { login: 'robot' }, body: ownBody },
  { id: 902, user: { login: 'gidvantus' }, body: foreignBody },
]
bodies[ownPatch] = (sent) => ({ id: 901, body: sent.body })
bodies[REPO] = { permissions: { admin: false, push: true, pull: true } }
const rights = await mod.probeCommentRights(call, 'gidvantus/vahta')

check('свой комментарий опознан по учётке', [rights.me, rights.own.id], ['robot', 901])
check('вердикт по своему комментарию назван словами', /право на правку комментария ЕСТЬ/.test(rights.own.verdict), true)
check('тело вернулось байт в байт', rights.own.byteExact, true)
check('в PATCH своего комментария ушло ровно его тело', calls.find((c) => c.path === '/repos/gidvantus/vahta/issues/comments/901').body, { body: ownBody })
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
bodies[LIST] = [{ id: 901, user: { login: 'robot' }, body: ownBody }]
bodies[ownPatch] = (sent) => ({ id: 901, body: String(sent.body).replace('![Скриншот](https://github.com/gidvantus/vahta/assets/1.png)', '') })
bodies[REPO] = { permissions: { push: true } }
const lossy = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('потерянный markdown виден как провал возврата', lossy.own.byteExact, false)
check('все комментарии одной учётки видны', lossy.sameAccount, true)
check('без чужих комментариев ограничение названо', /комментариев других авторов нет/.test(lossy.foreign.verdict), true)

// 4. 403 на своём комментарии — схему галочек надо переделывать до кода.
reset({ [ownPatch]: 403 })
bodies[USER] = { login: 'robot' }
bodies[LIST] = [{ id: 901, user: { login: 'robot' }, body: ownBody }]
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
check('и PATCH своего комментария не отправлялся', calls.filter((c) => c.method === 'PATCH').length, 0)

// 6. Нечитаемый список комментариев — это проблема, а не пустой успех.
reset()
bodies[USER] = { login: 'robot' }
bodies[LIST] = 'не массив'
const broken = await mod.probeCommentRights(call, 'gidvantus/vahta')
check('нечитаемый ответ назван проблемой', /список комментариев не прочитан/.test(broken.problem || ''), true)
check('и после проблемы сеть больше не дёргается', calls.length, 2)

// 7. Коды, которых проба не ждёт, остаются названными кодами.
check('404 — комментарий не найден', mod.commentRightVerdict(404), 'комментарий не найден (404) — право проверить не удалось')
check('500 назван кодом', /код 500/.test(mod.commentRightVerdict(500)), true)

// 8. Токен в результат пробы не попадает, а в запросы уходит заголовком.
check('токен не утёк', JSON.stringify(rights).includes('test-token'), false)
check('и в запросы уходил заголовком', calls.some((c) => c.auth === 'Bearer test-token'), true)

https.request = original
console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
process.exit(failures === 0 ? 0 : 1)
