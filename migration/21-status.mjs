// Сводка по реестру проектов: что настроено и что видит отдел.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const registry = JSON.parse(fs.readFileSync(path.join(HOME, 'projects.json'), 'utf8'))

let shared
try {
  shared = JSON.parse(fs.readFileSync(path.join(HOME, 'telegram.json'), 'utf8'))
} catch (error) {
  shared = undefined
}

console.log('проекты в реестре: ' + Object.keys(registry.projects).join(', '))
console.log('бот по умолчанию в telegram.json: ' + (shared && shared.token ? String(shared.token).split(':')[0] : '(нет)'))
console.log('')

for (const [id, p] of Object.entries(registry.projects)) {
  const d = p.department || {}
  const windows = Array.isArray(d.windows) ? d.windows.map((w) => w.start + '–' + w.stop).join(', ') : 'общее'
  const ownBot = p.telegram && p.telegram.token ? String(p.telegram.token).split(':')[0] : null
  console.log(id)
  console.log('  repo       : ' + (p.repo || '(нет — проект не связан с GitHub)'))
  console.log('  base       : ' + (p.base || 'main (по умолчанию)'))
  console.log('  workspace  : ' + (p.workspace || '(нет)'))
  console.log('  humanClone : ' + (p.humanClone || '(нет — рабочая область и есть каталог человека)'))
  console.log('  отдел      : ' + (d.enabled === false ? 'ВЫКЛЮЧЕН' : 'включён, ' + windows + ', доработок ' + (d.maxRework || 'общее')))
  console.log('  бот        : ' + (ownBot ? ownBot : 'нет — события остаются в GUI'))
  console.log('')
}
