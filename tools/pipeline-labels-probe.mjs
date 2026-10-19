// Какие метки конвейера реально существуют в репозиториях проекта.
// Запуск: node .github-labels-probe.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'github.token'), 'utf8').trim()
const registry = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'))

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com',
      path: url,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-probe',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')))
    req.on('error', reject)
    req.end()
  })
}

const wanted = ['ready-for-dev', 'in-progress', 'for-code-review', 'ready-for-test', 'tested', 'test-failed']
for (const [id, project] of Object.entries(registry.projects || {})) {
  if (!project.repo) { console.log(id + ': без GitHub'); continue }
  const res = await get('/repos/' + project.repo + '/labels?per_page=100')
  if (res.status !== 200) {
    console.log(id + ' (' + project.repo + ') → ' + res.status + ' ' + JSON.parse(res.body).message)
    continue
  }
  const names = JSON.parse(res.body).map((l) => l.name)
  const missing = wanted.filter((w) => names.indexOf(w) === -1)
  console.log(id + ' (' + project.repo + '): есть ' + wanted.filter((w) => names.indexOf(w) !== -1).join(', ') +
    (missing.length ? ' | НЕТ: ' + missing.join(', ') : ' | все метки конвейера на месте'))
}
