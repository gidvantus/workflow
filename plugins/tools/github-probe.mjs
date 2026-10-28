// Точечная проверка операций, на которых падал отдел. Две первые пробы ничего
// не меняют; третья правит комментарий — и правит заведомо безопасный.
//
// 1) DELETE метки, которой на issue нет → 404 значит «право есть, метки нет»,
//    403 значит «права нет». Ничего не удаляется.
// 2) POST PR с пустым телом → 422 значит «право есть, запрос неполный»,
//    403 значит «права нет». PR не создаётся.
// 3) PATCH комментария → право, которым разработчик закрывает галочки в чужом
//    по роли комментарии ревьюера или тестировщика (issue #10). Проверяется:
//      а) свой комментарий принимает PATCH и возвращается тем же телом, которое
//         ушло, — на этом стоит `tick` (подмена только маркера `- [ ]` → `- [x]`);
//      б) сколько разных авторов у комментариев репозитория и есть ли у токена
//         push: все роли отдела ходят ОДНИМ токеном, поэтому комментарии ролей
//         пишет один аккаунт, и `PATCH` всегда адресован своему комментарию.
//         Чужой по автору комментарий проба не правит вообще: `PATCH {}` в
//         GitHub отвечает 422 (поле body обязательно), а не 403, и права по
//         такому ответу не видно, зато видно цену ошибки — чужой текст.
//
// Проба ПИШЕТ, поэтому целью выбирается самый ДАВНИЙ свой комментарий, а не самый
// свежий: свежий в живом репозитории — это вердикт ревьюера или тестировщика, а
// часто и чеклист `- [ ]`, по которому диспетчер строит маршрут доработок. Тело
// уходит прочитанным раньше, и правка свежего пункта молча вернула бы его в
// состояние «не закрыт».
//
// Цена пробы: PATCH повторяет тело уже лежащего комментария, и GitHub может
// ОДИН раз нормализовать его при первой записи (наблюдалось +1 кодовая точка в
// одном комментарии из пяти; повторная запись идёт байт в байт, текст при этом
// не меняется визуально). Поэтому пробу гоняют по нужному репозиторию, а не в
// цикле «на всякий случай», и `побайтовый возврат: нет` в отчёте — повод
// посмотреть на комментарий, а не приговор схеме.
//
// Запуск: node tools/github-probe.mjs [owner/repo …]
// Без аргументов репозитории берутся из реестра проектов — путь к нему собирает
// модуль путей состояния (каталог профиля, а не корень каталога установки).
// Нечитаемый реестр — отказ с кодом 2: проба, которая пишет, не выбирает себе
// цель по захардкоженному списку.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { statePathsModule } from './plugin-paths.mjs'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readToken() {
  const file = path.join(dshHome(), 'mcp', 'github-mcp-server', 'token')
  return fs.readFileSync(file, 'utf8').trim()
}

export function apiCall(token, method, url, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload)
    const req = https.request({
      host: 'api.github.com',
      path: url,
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-probe',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')))
    req.on('error', reject)
    req.end(data === null ? undefined : data)
  })
}

function parsed(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

export function commentRightVerdict(status) {
  if (status === 200) return 'право на правку комментария ЕСТЬ (200)'
  if (status === 403) return 'права НЕТ (403)'
  if (status === 404) return 'комментарий не найден (404) — право проверить не удалось'
  if (status === 0) return 'своего комментария в репозитории не нашлось — побайтовый возврат не проверен'
  return 'код ' + status + ' — право проверить не удалось'
}

// Проверка прав на правку комментария в одном репозитории. `call` — тонкая
// обёртка над apiCall: тест подставляет поддельную сеть и проверяет, что правится
// самый давний свой комментарий, а чужой не правится вовсе.
export async function probeCommentRights(call, repo) {
  const meRow = parsed((await call('GET', '/user', undefined)).body) || {}
  const me = meRow.login || ''
  const list = await call('GET', '/repos/' + repo + '/issues/comments?per_page=100&sort=updated', undefined)
  const rows = parsed(list.body)
  const out = { repo, me, own: null, foreign: null, authors: [], sameAccount: false, permissions: null }
  if (!Array.isArray(rows)) {
    // Список не прочитан — судить о схеме нечем: ни авторов, ни возврата тела.
    out.problem = 'список комментариев не прочитан: статус ' + list.status
    out.own = { id: 0, status: 0, verdict: commentRightVerdict(0), byteExact: false }
    out.foreign = { id: 0, author: '', verdict: 'чужие комментарии не читались: список не прочитан' }
    return out
  }
  const flat = rows.map((c) => ({
    id: c.id,
    author: (c.user && c.user.login) || '',
    body: String(c.body == null ? '' : c.body),
  }))
  out.authors = [...new Set(flat.map((c) => c.author).filter((a) => a !== ''))]
  // «Одна учётка у ролей» — утверждение о данных, а не о пустоте: при нуле
  // комментариев или при чужом авторе оно не доказано и должно быть false.
  out.sameAccount = out.authors.length === 1 && out.authors[0] === me

  // Список отсортирован по updated от свежих к давним, значит самый давний свой —
  // последний в отфильтрованном ряду. Свежий не трогаем: это живой вердикт.
  const own = flat.filter((c) => c.author !== '' && c.author === me).at(-1)
  if (own) {
    // Своё тело отправляем обратно целиком: это единственный способ увидеть,
    // что PATCH возвращает ровно то, что получил, а не переписывает markdown.
    const same = await call('PATCH', '/repos/' + repo + '/issues/comments/' + own.id, { body: own.body })
    const back = parsed(same.body) || {}
    out.own = {
      id: own.id,
      status: same.status,
      verdict: commentRightVerdict(same.status),
      byteExact: same.status === 200 && String(back.body) === own.body,
    }
  } else {
    out.own = { id: 0, status: 0, verdict: commentRightVerdict(0), byteExact: false }
  }

  const foreign = flat.find((c) => c.author !== '' && c.author !== me)
  out.foreign = foreign
    ? { id: foreign.id, author: foreign.author, verdict: 'чужой по автору комментарий проба не правит: текст автора неприкосновенен' }
    : { id: 0, author: '', verdict: 'комментариев других авторов нет — все комментарии одной учётки, как у ролей отдела' }

  // Права токена на репозиторий: push/admin объясняют, может ли аккаунт править
  // чужие комментарии вообще. Запрос только читает.
  const repoRow = parsed((await call('GET', '/repos/' + repo, undefined)).body) || {}
  out.permissions = repoRow.permissions || null
  return out
}

// Строки отчёта по одному репозиторию. Отдельной функцией — чтобы тест проверял
// не только сеть, но и сам ответ: при нечитанном списке в отчёт попадает ТОЛЬКО
// проблема, без «одна учётка: да/нет» из ничего.
export function reportLines(rights) {
  const repo = rights.repo
  if (rights.problem) {
    return [repo + ': ' + rights.problem + ' — о схеме галочек по этому репозиторию ничего не сказать']
  }
  if (rights.authors.length === 0) {
    return [repo + ': комментариев в репозитории нет — учётку ролей и побайтовый возврат проверить нечем']
  }
  const push = rights.permissions ? String(!!rights.permissions.push) : 'нет данных'
  const lines = [
    repo + ': PATCH своего комментария #' + rights.own.id + ' → ' + rights.own.status + '  ' +
      rights.own.verdict + ', побайтовый возврат тела: ' + (rights.own.byteExact ? 'да' : 'нет'),
    repo + ': авторов комментариев ' + rights.authors.length + ' (' + rights.authors.join(', ') +
      '), одна учётка у ролей: ' + (rights.sameAccount ? 'да' : 'нет') + '; push: ' + push,
  ]
  if (rights.foreign.id) {
    lines.push(repo + ': чужой комментарий #' + rights.foreign.id + ' (автор ' + rights.foreign.author + ') — ' +
      rights.foreign.verdict)
  }
  return lines
}

// Реестр проектов: «не прочитан» и «пуст» — разные ответы, и оба не повод
// подставлять репозитории, которых оператор не называл. Путь к реестру собирает
// модуль состояния: файл переехал из корня каталога установки в каталог профиля.
export async function reposFromRegistry() {
  const state = await statePathsModule()
  const file = state.readStateFile(state.STATE_FILES.projects)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    const why = error && error.message ? error.message : String(error)
    return { repos: [], problem: 'не читается реестр проектов ' + file + ': ' + why }
  }
  const ids = Object.keys((raw && raw.projects) || {})
  const repos = [...new Set(ids.map((id) => String((raw.projects[id] || {}).repo || '')).filter((r) => r !== ''))]
  if (repos.length === 0) return { repos: [], problem: 'в реестре ' + file + ' нет ни одного проекта с repo' }
  return { repos, problem: null }
}

async function probeRepo(call, repo) {
  const list = await call('GET', '/repos/' + repo + '/issues?state=all&per_page=30', undefined)
  const issues = parsed(list.body)
  const issue = Array.isArray(issues) ? issues.find((i) => !i.pull_request) : null
  const number = issue ? issue.number : 1

  const del = await call('DELETE', '/repos/' + repo + '/issues/' + number + '/labels/probe-label-that-does-not-exist', undefined)
  const delVerdict = del.status === 404
    ? 'право на удаление меток ЕСТЬ (404 — метки нет)'
    : (del.status === 403 ? 'права НЕТ (403)' : 'код ' + del.status)

  const pr = await call('POST', '/repos/' + repo + '/pulls', {})
  const prVerdict = pr.status === 422
    ? 'право на PR ЕСТЬ (422 — запрос неполный)'
    : (pr.status === 403 ? 'права НЕТ (403)' : 'код ' + pr.status)

  const rights = await probeCommentRights(call, repo)
  return [
    repo + ': DELETE метки → ' + del.status + '  ' + delVerdict,
    repo + ': POST pull request → ' + pr.status + '  ' + prVerdict,
    ...reportLines(rights),
  ]
}

async function main() {
  const token = readToken()
  const call = (method, url, payload) => apiCall(token, method, url, payload)
  const fromArgs = process.argv.slice(2).filter((a) => a.indexOf('/') !== -1)
  let repos = fromArgs
  if (repos.length === 0) {
    const registry = await reposFromRegistry()
    if (registry.problem) {
      console.error(registry.problem + '. Передайте owner/repo аргументом, если цель названа вручную')
      process.exit(2)
    }
    repos = registry.repos
  }
  for (const repo of repos) {
    // Сбой одного репозитория не должен прятать остальные: в отчёте должна быть
    // строка о том, что именно не проверено.
    try {
      for (const line of await probeRepo(call, repo)) console.log(line)
    } catch (error) {
      console.log(repo + ': проба не прошла: ' + (error && error.message ? error.message : String(error)))
    }
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) await main()
