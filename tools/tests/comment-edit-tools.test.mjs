// Проверка галочек в чужом по роли комментарии: инструмент gh_comment_edit и
// `id` комментария в обсуждении (gh_pr/gh_issue с comments: true).
// Сеть поддельная, реальный GitHub не трогаем.
//
// Что здесь важно и почему именно это:
//   - tick меняет ОДИН символ маркера, а тело уходит в PATCH байт в байт:
//     постановка #10 обещает «вложения-картинки тестировщика не теряются», а
//     PATCH заменяет тело целиком — любая пересборка строки их бы съела;
//   - повторный tick по уже закрытому пункту — не ошибка: разработчик отмечает
//     весь свой список, и второй прогон не должен падать;
//   - неизвестный номер и `body` вместе с `tick` — отказ ДО сетевого запроса:
//     иначе PATCH переписал бы тело впустую или снял не тот пункт;
//   - чужой комментарий не правится: автор сверяется с учёткой токена, иначе
//     промах на соседнюю строку в списке молча переписывал бы реплику человека;
//   - шаблон пункта один у инструмента и у диспетчера (`dev-department.mjs`,
//     `checklistPart`): отклонение `-[ ] Б1` без пробела после дефиса обязано
//     остаться пунктом — иначе закрыть его нечем, а маршрут по нему идёт;
//   - `id` приходит из прочитанного обсуждения, а не выдумывается: два разных
//     ответа сети дают два разных id.
// Четыре копии пресетов (dev-backend, dev-frontend, dev-fullstack, code-review)
// проверяются одним и тем же сценарием: расхождение копий — это два разных
// шаблона пункта у двух половин отдела, а dev-backend и dev-frontend по
// постановке обязаны совпадать.
// Запуск: node comment-edit-tools.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Каталог установки читаем ДО подмены DSH_HOME ниже: тестируем боевой модуль.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const home = path.join(process.cwd(), '.comment-edit-tools-home')
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, 'github.token'), 'test-token\n')
// Инструменты определяют проект по рабочему каталогу сессии — берём текущий.
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  default: 'vahta',
  projects: { vahta: { repo: 'gidvantus/vahta', base: 'develop-m', workspace: process.cwd() } },
}, null, 2))
process.env.DSH_HOME = home

// Комментарий ревьюера в формате постановки: заголовок роли, две секции,
// вложение-скриншот и хвост «не проверено». Скриншот здесь не украшение: если
// реализация пересоберёт строки, он и есть первая потеря.
const BODY = [
  '**Роль:** код-ревьюер · вердикт FIX: 3',
  'FIX: 3',
  '',
  '**Что делает изменение.** Правит инструменты отдела.',
  '',
  '### Бэкенд',
  '- [ ] Б1 · `tools/a.mjs:12` — пустой список даёт 500 · Случай: ... · Правка: ... · Если не править: ...',
  '- [ ] Б2 · `tools/b.mjs:7` — не читается реестр · Случай: ...',
  '### Фронтенд',
  '- [ ] Ф1 · `agent-presets/x.mjs:3` — нет id у комментария',
  '',
  '![Скриншот](https://user-images.githubusercontent.com/1/shot.png)',
  '',
  '**Не проверено.** Прогон на стенде.',
].join('\n')

const calls = []
let stored = BODY
let commentOwner = 'gidvantus'
// Ответы сети: пути те же, что у боевого GitHub, иначе тест проверял бы не тот
// код. Неизвестный путь — 404, как в жизни: так видно лишний запрос.
https.request = (options, callback) => ({
  on() { return this },
  setTimeout() { return this },
  destroy() { return this },
  end(payload) {
    const sent = payload ? JSON.parse(payload) : null
    calls.push({
      method: options.method,
      path: options.path,
      body: sent,
      auth: options.headers && options.headers.Authorization,
    })
    let status = 200
    let response = null
    if (options.method === 'GET' && /\/user$/.test(options.path)) {
      response = { login: 'gidvantus' }
    } else if (options.method === 'GET' && /\/issues\/comments\/\d+$/.test(options.path)) {
      response = { id: 555, body: stored, user: { login: commentOwner } }
    } else if (options.method === 'PATCH' && /\/issues\/comments\/\d+$/.test(options.path)) {
      stored = sent && sent.body
      response = {
        id: 555,
        body: stored,
        html_url: 'https://github.com/gidvantus/vahta/issues/1#issuecomment-555',
        user: { login: commentOwner },
      }
    } else if (options.method === 'GET' && /\/issues\/\d+\/comments/.test(options.path)) {
      // id зависит от номера issue: так проверяется, что инструмент отдаёт
      // прочитанный id, а не зашитый в код.
      const id = Number(/\/issues\/(\d+)\//.exec(options.path)[1]) * 100
      response = [{ id, user: { login: 'gidvantus' }, body: BODY, created_at: '2026-10-25T10:00:00Z' }]
    } else if (options.method === 'GET' && /\/issues\/\d+$/.test(options.path)) {
      response = {
        number: 10, title: 't', state: 'open', labels: [], assignees: [],
        comments: 1, updated_at: 'x', html_url: 'u', body: '',
      }
    } else if (options.method === 'GET' && /\/pulls\/\d+$/.test(options.path)) {
      response = { number: 12, title: 't', state: 'open', head: { ref: 'b' }, base: { ref: 'main' }, html_url: 'u', body: '' }
    } else {
      status = 404
      response = { message: 'Not Found' }
    }
    process.nextTick(() => {
      const text = JSON.stringify(response)
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

// Одна копия пресета = один набор инструментов: копии не смешиваются, иначе
// проверка «во всех четырёх» проверяла бы только первую.
const PRESETS = ['dev-backend', 'dev-frontend', 'dev-fullstack', 'code-review']
// Обсуждение issue с id — только у копий разработчиков: ревьюер замечания пишет
// в PR и чеклист тестировщика из issue не отмечает.
const devCopies = ['dev-backend', 'dev-frontend', 'dev-fullstack']
const copies = new Map()
for (const preset of PRESETS) {
  const presetTools = []
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register(tool) { presetTools.push(tool) } }
      if (name === 'sessions') return { get: () => ({ header: { cwd: process.cwd() } }) }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
  }
  const plugin = path.join(dshHome, '.agent-presets', preset, 'github.mjs')
  const mod = await import('file:///' + plugin.replace(/\\/g, '/') + '?v=' + Date.now())
  mod.default.apply(ctx)
  copies.set(preset, presetTools)
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'ok    ' : 'ФЕЙЛ  ') + name + ' → ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'))
}
const byName = (preset, name) => copies.get(preset).find((t) => t.name === name)
// «Так во всех четырёх копиях» — одной строкой на свойство, а не двенадцатью.
const four = (value) => PRESETS.map(() => value)
const three = (value) => devCopies.map(() => value)
const patches = () => calls.filter((c) => c.method === 'PATCH')
async function run(preset, name, args) {
  try {
    return { value: JSON.parse(await byName(preset, name).execute(args, { agent: { id: 1 } })) }
  } catch (error) {
    return { error: error.message }
  }
}
const edit = (preset, args) => run(preset, 'gh_comment_edit', args)
// Прогон свойства через все четыре копии: каждая начинает с чистого тела и
// чистого журнала запросов.
async function everyCopy(scenario, presets) {
  const out = []
  for (const preset of presets || PRESETS) {
    stored = BODY
    calls.length = 0
    commentOwner = 'gidvantus'
    out.push(await scenario(preset))
  }
  stored = BODY
  commentOwner = 'gidvantus'
  calls.length = 0
  return out
}

// ── инвентарь: инструмент есть в каждой копии и описан как надо ─────────────
check('gh_comment_edit зарегистрирован во всех четырёх копиях',
  PRESETS.map((p) => !!byName(p, 'gh_comment_edit')), four(true))
check('в каждой копии по десять инструментов',
  PRESETS.map((p) => copies.get(p).length), four(10))
check('gh_comment_edit обязателен только comment_id',
  PRESETS.map((p) => byName(p, 'gh_comment_edit').parameters.required), four(['comment_id']))
check('gh_comment_edit знает только comment_id, body, tick',
  PRESETS.map((p) => Object.keys(byName(p, 'gh_comment_edit').parameters.properties).sort()),
  four(['body', 'comment_id', 'tick']))
check('лишних полей gh_comment_edit не принимает',
  PRESETS.map((p) => byName(p, 'gh_comment_edit').parameters.additionalProperties), four(false))
check('gh_issue умеет comments во всех копиях разработчиков',
  ['dev-backend', 'dev-frontend', 'dev-fullstack'].map((p) => !!byName(p, 'gh_issue').parameters.properties.comments),
  [true, true, true])

// ── 1. tick меняет только маркер, тело вокруг — байт в байт ─────────────────
const expectedTicked = BODY.replace('- [ ] Б1 ·', '- [x] Б1 ·')
const tickedOnce = await everyCopy(async (preset) => {
  const out = await edit(preset, { comment_id: 555, tick: ['Б1'] })
  return {
    ticked: out.value && out.value.ticked,
    missing: out.value && out.value.missing,
    url: out.value && out.value.url,
    body: stored,
    patch: patches().map((c) => [c.method, c.path, c.body && c.body.body === expectedTicked]),
    auth: calls[0] && calls[0].auth,
    value: JSON.stringify(out.value),
  }
})
check('tick вернул отмеченные номера', tickedOnce.map((r) => r.ticked), four(['Б1']))
check('tick не вернул отсутствующих', tickedOnce.map((r) => r.missing), four([]))
check('tick вернул ссылку на комментарий', tickedOnce.map((r) => r.url),
  four('https://github.com/gidvantus/vahta/issues/1#issuecomment-555'))
check('тело изменилось только в маркере Б1', tickedOnce.map((r) => r.body === expectedTicked), four(true))
check('длиннее или короче тело не стало', tickedOnce.map((r) => r.body.length), four(BODY.length))
check('вложения-картинки на месте и целы', tickedOnce.map((r) => r.body.includes('![Скриншот](https://user-images.githubusercontent.com/1/shot.png)')), four(true))
check('неотмеченный пункт Ф1 остался открытым', tickedOnce.map((r) => r.body.includes('- [ ] Ф1 ·')), four(true))
check('PATCH ушёл на путь комментария, тело — целиком отмеченное',
  tickedOnce.map((r) => r.patch), four([['PATCH', '/repos/gidvantus/vahta/issues/comments/555', true]]))
check('токен ушёл в заголовке', tickedOnce.map((r) => r.auth), four('Bearer test-token'))
check('токен не утёк в результат', tickedOnce.map((r) => r.value.includes('test-token')), four(false))

// ── 2. Повторный tick по закрытому пункту — не ошибка ───────────────────────
const tickedTwice = await everyCopy(async (preset) => {
  await edit(preset, { comment_id: 555, tick: ['Б1'] })
  stored = expectedTicked
  calls.length = 0
  const out = await edit(preset, { comment_id: 555, tick: ['Б1'] })
  return {
    ok: !!out.value,
    error: out.error || null,
    same: stored === expectedTicked,
    patch: patches().length,
  }
})
check('повторный tick по закрытому пункту не отказ', tickedTwice.map((r) => r.ok), four(true))
check('повторный tick ошибки не назвал', tickedTwice.map((r) => r.error), four(null))
check('повторный tick оставил тело тем же', tickedTwice.map((r) => r.same), four(true))
check('повторный tick всё равно переписал маркер', tickedTwice.map((r) => r.patch), four(1))

// ── 3. Два номера сразу — оба закрыты, соседи целы ─────────────────────────
const twoTicked = await everyCopy(async (preset) => {
  const out = await edit(preset, { comment_id: 555, tick: ['Б1', 'Ф1'] })
  return {
    ticked: out.value && out.value.ticked,
    body: stored,
    untouched: stored.includes('- [ ] Б2 ·'),
  }
})
check('два номера вернулись оба', twoTicked.map((r) => r.ticked), four(['Б1', 'Ф1']))
check('два номера закрыты, остальные строки целы', twoTicked.map((r) => r.body),
  four(BODY.replace('- [ ] Б1 ·', '- [x] Б1 ·').replace('- [ ] Ф1 ·', '- [x] Ф1 ·')))
check('пункт, которого не называли, остался открытым', twoTicked.map((r) => r.untouched), four(true))

// ── 4. Неизвестный номер — отказ ДО PATCH, тело не тронуто ─────────────────
const unknown = await everyCopy(async (preset) => {
  const out = await edit(preset, { comment_id: 555, tick: ['Б9'] })
  return {
    refused: !!out.error,
    names: /Б1, Б2, Ф1/.test(out.error || ''),
    patch: patches().length,
    body: stored,
  }
})
check('неизвестный номер — отказ', unknown.map((r) => r.refused), four(true))
check('в отказе перечислены номера, которые в теле есть', unknown.map((r) => r.names), four(true))
check('неизвестный номер не дошёл до PATCH', unknown.map((r) => r.patch), four(0))
check('на отказе тело не изменилось', unknown.map((r) => r.body === BODY), four(true))

// ── 5. Отказы аргументов: до сети, без единого запроса ─────────────────────
const refusals = await everyCopy(async (preset) => ({
  both: (await edit(preset, { comment_id: 555, body: 'новое тело', tick: ['Б1'] })).error || null,
  neither: (await edit(preset, { comment_id: 555 })).error || null,
  emptyBody: (await edit(preset, { comment_id: 555, body: '   ' })).error || null,
  emptyTick: (await edit(preset, { comment_id: 555, tick: [] })).error || null,
  zeroId: (await edit(preset, { comment_id: 0 })).error || null,
  requests: calls.length,
}))
check('body вместе с tick — отказ', refusals.map((r) => /что-то одно/.test(r.both || '')), four(true))
check('ни одного поля — отказ', refusals.map((r) => /передайте body/.test(r.neither || '')), four(true))
check('пустая строка вместо тела — отказ', refusals.map((r) => /передайте body/.test(r.emptyBody || '')), four(true))
check('пустой tick — отказ', refusals.map((r) => /tick пуст/.test(r.emptyTick || '')), four(true))
check('comment_id 0 — отказ', refusals.map((r) => /положительное целое/.test(r.zeroId || '')), four(true))
check('отказы аргументов не дошли до сети', refusals.map((r) => r.requests), four(0))

// ── 6. Режим body: тело целиком, ticked пуст ───────────────────────────────
const newBody = '**Роль:** код-ревьюер · дописан пункт\nFIX: 3\n\n### Бэкенд\n- [ ] Б3 · `tools/c.mjs:1` — новое замечание'
const bodyMode = await everyCopy(async (preset) => {
  const out = await edit(preset, { comment_id: 555, body: newBody })
  return {
    ticked: out.value && out.value.ticked,
    body: stored,
    patch: patches().map((c) => c.body && c.body.body),
  }
})
check('body вернул пустой ticked', bodyMode.map((r) => r.ticked), four([]))
check('body ушёл ровно переданным', bodyMode.map((r) => r.patch), four([newBody]))
check('body сохранён в комментарии целиком', bodyMode.map((r) => r.body), four(newBody))

// ── 7. Чужой комментарий не правится ни одним режимом ──────────────────────
const foreign = await everyCopy(async (preset) => {
  commentOwner = 'MiGSergaS'
  const byTick = await edit(preset, { comment_id: 555, tick: ['Б1'] })
  const afterTick = { patch: patches().length, body: stored }
  calls.length = 0
  const byBody = await edit(preset, { comment_id: 555, body: 'переписанное тело' })
  return {
    tickError: /не твоей учёткой/.test(byTick.error || ''),
    bodyError: /не твоей учёткой/.test(byBody.error || ''),
    patches: [afterTick.patch, patches().length],
    bodyUntouched: afterTick.body === BODY && stored === BODY,
  }
})
check('чужой комментарий: tick — отказ', foreign.map((r) => r.tickError), four(true))
check('чужой комментарий: body — отказ', foreign.map((r) => r.bodyError), four(true))
check('чужой комментарий: PATCH не отправлен ни разу', foreign.map((r) => r.patches), four([0, 0]))
check('чужой комментарий: тело не изменилось', foreign.map((r) => r.bodyUntouched), four(true))

// ── 8. Шов шаблона: `-[ ] Б1` без пробела — пункт и для инструмента ────────
// Тот же шаблон у диспетчера (`dev-department.mjs`): если разойдётся, маршрут
// увидит пункт, а галочка его не найдёт — и пункт вернётся в доработку навсегда.
const noSpace = '-[ ] Б1 · `tools/a.mjs:12` — отклонение от формата\n- [ ] Б2 · `tools/b.mjs:1` — обычный пункт'
const seam = await everyCopy(async (preset) => {
  stored = noSpace
  const out = await edit(preset, { comment_id: 555, tick: ['Б1'] })
  return { ticked: out.value && out.value.ticked, body: stored }
})
check('пункт без пробела после дефиса отмечается', seam.map((r) => r.body.startsWith('-[x] Б1')), four(true))
check('соседний пункт при этом не тронут', seam.map((r) => r.body.includes('- [ ] Б2 ·')), four(true))

// ── 9. CRLF-комментарий не превращается в LF-овый ──────────────────────────
const bodyLines = (BODY.match(/\n/g) || []).length
const crlfSeam = await everyCopy(async (preset) => {
  stored = BODY.split('\n').join('\r\n')
  await edit(preset, { comment_id: 555, tick: ['Б1'] })
  return {
    marker: stored.includes('- [x] Б1 ·'),
    crlf: (stored.match(/\r\n/g) || []).length,
    lf: (stored.match(/\n/g) || []).length - (stored.match(/\r\n/g) || []).length,
  }
})
check('CRLF: маркер отмечен', crlfSeam.map((r) => r.marker), four(true))
check('CRLF: окончания строк не переписаны', crlfSeam.map((r) => [r.crlf, r.lf]), four([bodyLines, 0]))

// ── 10. id комментария — из прочитанного обсуждения ────────────────────────
// Два разных номера issue дают два разных id: зашитый id эта проверка не пройдёт.
const issueIds = await everyCopy(async (preset) => {  const ten = await run(preset, 'gh_issue', { number: 10, comments: true })
  const twice = await run(preset, 'gh_issue', { number: 2, comments: true })
  return {
    first: ten.value.comments.map((c) => [c.id, c.author]),
    second: twice.value.comments.map((c) => c.id),
    count: ten.value.commentCount,
    keys: Object.keys(ten.value.comments[0]).sort(),
  }
}, devCopies)
check('gh_issue отдаёт список комментариев с id', issueIds.map((r) => r.first), three([[1000, 'gidvantus']]))
check('gh_issue отдаёт id, который прочитал, а не зашитый', issueIds.map((r) => r.second), three([200]))
check('gh_issue сохранил число комментариев', issueIds.map((r) => r.count), three(1))
check('комментарий issue — id, author, body, at', issueIds.map((r) => r.keys), three(['at', 'author', 'body', 'id']))

const prIds = await everyCopy(async (preset) => {
  const out = await run(preset, 'gh_pr', { number: 12, comments: true })
  return {
    ids: out.value && out.value.comments.map((c) => c.id),
    keys: out.value && Object.keys(out.value.comments[0]).sort(),
  }
})
check('gh_pr отдаёт id комментария', prIds.map((r) => r.ids), four([1200]))
check('комментарий PR — id, author, body, at', prIds.map((r) => r.keys), four(['at', 'author', 'body', 'id']))

// ── 11. Инструмент трогает только тело комментария ─────────────────────────
// Лишний запрос — признак того, что инструмент залез в метки или в PR: ни
// того, ни другого постановка не разрешает.
const paths = []
for (const preset of PRESETS) {
  stored = BODY
  calls.length = 0
  await edit(preset, { comment_id: 555, tick: ['Б1'] })
  paths.push(calls.map((c) => c.method + ' ' + c.path.split('?')[0]))
}
check('журнал запросов — чтение комментария, учётка, PATCH комментария',
  paths, four([
    'GET /repos/gidvantus/vahta/issues/comments/555',
    'GET /user',
    'PATCH /repos/gidvantus/vahta/issues/comments/555',
  ]))

console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : '\nПРОВАЛОВ: ' + failures)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
