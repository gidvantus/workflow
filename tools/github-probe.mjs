// Точечная проверка операций, на которых падал отдел. Ничего не создаёт и не
// портит: каждый запрос либо заведомо неполный (GitHub отвечает 422), либо
// адресован тому, чего нет (404), либо повторяет уже лежащий текст.
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
// Запуск: node tools/github-probe.mjs [owner/repo …]
// Без аргументов репозитории берутся из реестра проектов (~/.dsh/projects.json).
//
// Цена пробы: PATCH повторяет тело уже лежащего комментария, и GitHub может
// ОДИН раз нормализовать его при первой записи (наблюдалось +1 кодовая точка в
// одном комментарии из пяти; повторная запись идёт байт в байт, текст при этом
// не меняется визуально). Поэтому пробу гоняют по нужному репозиторию, а не в
// цикле «на всякий случай», и `побайтовый возврат: нет` в отчёте — повод
// посмотреть на комментарий, а не приговор схеме.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readToken() {
  const file = path.join(dshHome(), 'github.token')
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
// обёртка над apiCall: тест подставляет поддельную сеть и проверяет, что чужой
// комментарий не правится вовсе.
export async function probeCommentRights(call, repo) {
  const meRow = parsed((await call('GET', '/user', undefined)).body) || {}
  const me = meRow.login || ''
  const list = await call('GET', '/repos/' + repo + '/issues/comments?per_page=100&sort=updated', undefined)
  const rows = parsed(list.body)
  const out = { repo, me, own: null, foreign: null, authors: [], sameAccount: false, permissions: null }
  if (!Array.isArray(rows)) {
    out.problem = 'список комментариев не прочитан: статус ' + list.status
    return out
  }
  const flat = rows.map((c) => ({
    id: c.id,
    author: (c.user && c.user.login) || '',
    body: String(c.body == null ? '' : c.body),
  }))
  out.authors = [...new Set(flat.map((c) => c.author).filter((a) => a !== ''))]
  out.sameAccount = out.authors.length <= 1 && (out.authors.length === 0 || out.authors[0] === me)

  const own = flat.find((c) => c.author !== '' && c.author === me)
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

export function reposFromRegistry() {
  const file = path.join(dshHome(), 'projects.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const ids = Object.keys((raw && raw.projects) || {})
    const repos = ids.map((id) => String((raw.projects[id] || {}).repo || '')).filter((r) => r !== '')
    return [...new Set(repos)]
  } catch (error) {
    return []
  }
}

async function main() {
  const token = readToken()
  const call = (method, url, payload) => apiCall(token, method, url, payload)
  const fromArgs = process.argv.slice(2).filter((a) => a.indexOf('/') !== -1)
  // Реестр — источник истины, но проба должна работать и на машине без него:
  // список ниже — ровно те репозитории, которые здесь были до появления
  // реестра, чтобы запуск без аргументов не начал молча ничего не делать.
  const known = ['gidvantus/vahta', 'gidvantus/cloudpass']
  const repos = fromArgs.length > 0 ? fromArgs : (reposFromRegistry().length > 0 ? reposFromRegistry() : known)
  if (repos.length === 0) {
    console.error('не нашлось ни одного репозитория: передайте owner/repo или заведите projects.json')
    process.exit(2)
  }
  for (const repo of repos) {
    const list = await call('GET', '/repos/' + repo + '/issues?state=all&per_page=30', undefined)
    const issues = parsed(list.body)
    const issue = Array.isArray(issues) ? issues.find((i) => !i.pull_request) : null
    const number = issue ? issue.number : 1

    const del = await call('DELETE', '/repos/' + repo + '/issues/' + number + '/labels/probe-label-that-does-not-exist', undefined)
    const delVerdict = del.status === 404
      ? 'право на удаление меток ЕСТЬ (404 — метки нет)'
      : (del.status === 403 ? 'права НЕТ (403)' : 'код ' + del.status)
    console.log(repo + ': DELETE метки → ' + del.status + '  ' + delVerdict)

    const pr = await call('POST', '/repos/' + repo + '/pulls', {})
    const prVerdict = pr.status === 422
      ? 'право на PR ЕСТЬ (422 — запрос неполный)'
      : (pr.status === 403 ? 'права НЕТ (403)' : 'код ' + pr.status)
    console.log(repo + ': POST pull request → ' + pr.status + '  ' + prVerdict)

    const rights = await probeCommentRights(call, repo)
    console.log(repo + ': PATCH своего комментария #' + rights.own.id + ' → ' + rights.own.status +
      '  ' + rights.own.verdict + ', побайтовый возврат тела: ' + (rights.own.byteExact ? 'да' : 'нет'))
    console.log(repo + ': авторов комментариев ' + rights.authors.length + ' (' + rights.authors.join(', ') +
      '), одна учётка у ролей: ' + (rights.sameAccount ? 'да' : 'нет') + '; push: ' +
      (rights.permissions ? String(!!rights.permissions.push) : 'нет данных'))
    if (rights.foreign.id) {
      console.log(repo + ': чужой комментарий #' + rights.foreign.id + ' (автор ' + rights.foreign.author + ') — ' +
        rights.foreign.verdict)
    }
    if (rights.problem) console.log(repo + ': ' + rights.problem)
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) await main()
