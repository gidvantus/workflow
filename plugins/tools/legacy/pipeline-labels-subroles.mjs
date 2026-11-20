// Создаёт метки ролей и финальной ступени конвейера: маршрут area:*,
// ступень ready-for-frontend, фазу phase:frontend и терминальную merged.
// Без них GitHub отвечает 422 на попытку поставить метку, которой в репозитории нет.
// Запуск: node .github-labels-subroles.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { developmentOf, projectsOf, readRegistryFile } from '../../registry.mjs'
import { STATE_FILES, readStateFile } from '../../state-paths.mjs'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'mcp', 'github-mcp-server', 'token'), 'utf8').trim()
// Форму реестра знает только `registry.mjs`: файл версии 2 читается им, а проект
// ищется отделом разработки. Старый путь `~/projects.json` брошен вместе с
// версией 1 — реестр живёт в каталоге состояния отдела.
const registry = readRegistryFile(readStateFile(STATE_FILES.projects)).document

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

const LABELS = [
  { name: 'area:backend', color: '1D76DB', description: 'Маршрут: делает бэкенд-разработчик' },
  { name: 'area:frontend', color: '0E8A16', description: 'Маршрут: делает фронтенд-разработчик' },
  { name: 'area:fullstack', color: '5319E7', description: 'Маршрут: полный стек, сначала бэкенд, затем фронтенд' },
  { name: 'ready-for-frontend', color: 'FBCA04', description: 'Бэкенд-часть сдана, тикет ждёт фронтенд-разработчика' },
  { name: 'phase:frontend', color: 'BFDADC', description: 'Фронтенд-фаза полного стека уже начата' },
  { name: 'merged', color: '0B615E', description: 'PR слит DevOps-инженером, задача закрыта' },
]

for (const project of projectsOf(registry)) {
  const repo = String((developmentOf(project).department || {}).repo || '')
  if (!repo) continue
  const id = project.id
  for (const label of LABELS) {
    const res = await post('/repos/' + repo + '/labels', label)
    if (res.status === 201) console.log(id + ' (' + repo + '): ' + label.name + ' создана')
    else if (res.status === 422) console.log(id + ' (' + repo + '): ' + label.name + ' уже есть')
    else console.log(id + ' (' + repo + '): ' + label.name + ' → ' + res.status + ' ' + JSON.parse(res.body).message)
  }
}
