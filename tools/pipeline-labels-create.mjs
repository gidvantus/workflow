// Создаёт метку for-code-review в репозиториях проектов: без неё GitHub отвечает
// 422 на попытку поставить метку, которой в репозитории нет.
// Запуск: node .github-labels-create.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'github.token'), 'utf8').trim()
const registry = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'))

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = https.request({
      host: 'api.github.com',
      path: url,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-label',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

for (const [id, project] of Object.entries(registry.projects || {})) {
  if (!project.repo) continue
  const res = await post('/repos/' + project.repo + '/labels', {
    name: 'for-code-review',
    color: '8250DF',
    description: 'Изменение готово к код-ревью',
  })
  if (res.status === 201) console.log(id + ' (' + project.repo + '): метка создана')
  else if (res.status === 422) console.log(id + ' (' + project.repo + '): уже существует')
  else console.log(id + ' (' + project.repo + '): ' + res.status + ' ' + JSON.parse(res.body).message)
}
