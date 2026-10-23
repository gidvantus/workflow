// Точечная проверка операций, на которых падал отдел.
// 1) DELETE метки, которой на issue нет → 404 значит «право есть, метки нет»,
//    403 значит «права нет». Ничего не удаляется.
// 2) POST PR с пустым телом → 422 значит «право есть, запрос неполный»,
//    403 значит «права нет». PR не создаётся.
// Запуск: node .github-probe.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'github.token'), 'utf8').trim()

function call(method, url, payload) {
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
    if (data) req.write(data)
    req.end()
  })
}

for (const repo of ['gidvantus/vahta', 'gidvantus/cloudpass']) {
  const list = await call('GET', '/repos/' + repo + '/issues?state=all&per_page=30')
  const issue = JSON.parse(list.body).find((i) => !i.pull_request)
  const number = issue ? issue.number : 1

  const del = await call('DELETE', '/repos/' + repo + '/issues/' + number + '/labels/probe-label-that-does-not-exist')
  const delVerdict = del.status === 404
    ? 'право на удаление меток ЕСТЬ (404 — метки нет)'
    : (del.status === 403 ? 'права НЕТ (403)' : 'код ' + del.status)
  console.log(repo + ': DELETE метки → ' + del.status + '  ' + delVerdict)

  const pr = await call('POST', '/repos/' + repo + '/pulls', {})
  const prVerdict = pr.status === 422
    ? 'право на PR ЕСТЬ (422 — запрос неполный)'
    : (pr.status === 403 ? 'права НЕТ (403)' : 'код ' + pr.status)
  console.log(repo + ': POST pull request → ' + pr.status + '  ' + prVerdict)
}
