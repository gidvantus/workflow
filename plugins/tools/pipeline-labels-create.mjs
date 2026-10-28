// Приводит метки конвейера в порядок во всех проектах реестра: создаёт недостающие,
// убирает с тикетов и удаляет из репозитория метки выведенных маршрутов.
// Без метки, которой в репозитории нет, GitHub отвечает 422 на попытку её
// поставить, и шаг конвейера падает на первом же тикете.
// Запуск: node .github-labels-create.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { statePathsModule } from './plugin-paths.mjs'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const token = fs.readFileSync(path.join(home, 'mcp', 'github-mcp-server', 'token'), 'utf8').trim()
// Реестр проектов лежит в каталоге состояния отдела, а не в корне каталога
// установки: путь к нему собирает модуль состояния, а не этот скрипт.
const state = await statePathsModule({ dshHome: home })
const registry = JSON.parse(fs.readFileSync(state.readStateFile(state.STATE_FILES.projects), 'utf8'))

function call(method, url, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload)
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-label',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (data !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(data)
    }
    const req = https.request({ host: 'api.github.com', path: url, method, headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')))
    req.on('error', reject)
    if (data !== null) req.write(data)
    req.end()
  })
}

// Все метки, которые нужны конвейеру и могли не существовать в репозитории.
// Набор совпадает с PIPELINE_LABELS диспетчера: маршрут area:*, ступень макета,
// ступень фронтенда, ход тикета и терминальный merged.
const LABELS = [
  { name: 'ready-for-dev', color: '0E8A16', description: 'Человек взял тикет в работу' },
  { name: 'needs-mockup', color: 'D93F0B', description: 'Постановка требует макета: дизайнер рисует его до разработки' },
  { name: 'mockups-ready', color: 'C2E0C6', description: 'Макет постановки готов: можно брать задачу в работу' },
  { name: 'area:backend', color: '1D76DB', description: 'Маршрут: делает бэкенд-разработчик' },
  { name: 'area:frontend', color: '0E8A16', description: 'Маршрут: делает фронтенд-разработчик' },
  { name: 'area:fullstack', color: '5319E7', description: 'Маршрут: полный стек, сначала бэкенд, затем фронтенд' },
  { name: 'ready-for-frontend', color: 'FBCA04', description: 'Бэкенд-часть сдана, тикет ждёт фронтенд-разработчика' },
  { name: 'phase:frontend', color: 'BFDADC', description: 'Фронтенд-фаза полного стека уже начата' },
  { name: 'in-progress', color: 'FBCA04', description: 'Задача выдана исполнителю' },
  { name: 'for-code-review', color: '8250DF', description: 'Изменение готово к код-ревью' },
  { name: 'ready-for-test', color: '0E8A16', description: 'Код-ревьюер принял изменение' },
  { name: 'tested', color: '0E8A16', description: 'Тестировщик дал зелёный вердикт' },
  { name: 'test-failed', color: 'B60201', description: 'Тестировщик вернул с дефектом' },
  { name: 'merged', color: '0B615E', description: 'PR слит DevOps-инженером, задача закрыта' },
]

// Метки выведенных из процесса маршрутов: снимаются со всех тикетов и удаляются
// из репозитория, иначе копятся и путают разбор очереди.
const OBSOLETE = ['ready-for-design']

for (const [id, project] of Object.entries(registry.projects || {})) {
  if (!project.repo) continue
  const repo = project.repo

  for (const label of LABELS) {
    const res = await call('POST', '/repos/' + repo + '/labels', label)
    if (res.status === 201) console.log(id + ' (' + repo + '): ' + label.name + ' создана')
    else if (res.status === 422) console.log(id + ' (' + repo + '): ' + label.name + ' уже есть')
    else console.log(id + ' (' + repo + '): ' + label.name + ' → ' + res.status + ' ' + JSON.parse(res.body).message)
  }

  for (const name of OBSOLETE) {
    const listed = await call('GET', '/repos/' + repo + '/issues?state=all&per_page=100&labels=' + encodeURIComponent(name))
    if (listed.status === 200) {
      const rows = JSON.parse(listed.body)
      if (rows.length > 0) console.log(id + ': снимаю ' + name + ' с тикетов ' + rows.map((r) => '#' + r.number).join(', '))
      for (const issue of rows) {
        await call('DELETE', '/repos/' + repo + '/issues/' + issue.number + '/labels/' + encodeURIComponent(name))
      }
    }
    const deleted = await call('DELETE', '/repos/' + repo + '/labels/' + encodeURIComponent(name))
    if (deleted.status === 204) console.log(id + ': метка ' + name + ' удалена из репозитория')
    else if (deleted.status === 404) console.log(id + ': метки ' + name + ' нет — хорошо')
    else console.log(id + ': удаление ' + name + ' → ' + deleted.status + ' ' + deleted.body.slice(0, 120))
  }
}
