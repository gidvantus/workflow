// Какие метки конвейера реально существуют в репозиториях проекта.
// Запуск: node .github-labels-probe.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { statePathsModule, registryModule } from './plugin-paths.mjs'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'mcp', 'github-mcp-server', 'token'), 'utf8').trim()
// Реестр проектов лежит в каталоге состояния отдела, а не в корне каталога
// установки: путь к нему собирает модуль состояния, а не этот скрипт. Форму
// документа знает `registry.mjs`: repo живёт у отдела разработки проекта.
const state = await statePathsModule({ dshHome: home })
const registry = await registryModule({ dshHome: home })
const document = registry.readRegistryFile(state.readStateFile(state.STATE_FILES.projects)).document

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

// Весь набор меток конвейера: маршрут, ступень макета, ступень фронтенда и финал.
// Список должен совпадать с PIPELINE_LABELS диспетчера и с .github-labels-create.mjs.
const wanted = [
  'ready-for-dev',
  'needs-mockup',
  'mockups-ready',
  'area:backend',
  'area:frontend',
  'area:fullstack',
  'ready-for-frontend',
  'phase:frontend',
  'in-progress',
  'for-code-review',
  'ready-for-test',
  'tested',
  'test-failed',
  'merged',
]
for (const project of document.projects) {
  const id = project.id
  const repo = String((registry.developmentOf(project).department || {}).repo || '')
  if (!repo) { console.log(id + ': без GitHub'); continue }
  const res = await get('/repos/' + repo + '/labels?per_page=100')
  if (res.status !== 200) {
    console.log(id + ' (' + repo + ') → ' + res.status + ' ' + JSON.parse(res.body).message)
    continue
  }
  const names = JSON.parse(res.body).map((l) => l.name)
  const missing = wanted.filter((w) => names.indexOf(w) === -1)
  console.log(id + ' (' + repo + '): есть ' + wanted.filter((w) => names.indexOf(w) !== -1).join(', ') +
    (missing.length ? ' | НЕТ: ' + missing.join(', ') : ' | все метки конвейера на месте'))
}
