// Разведка перед добавлением проекта CRM Dormitory.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const REPO = 'gidvantus/factory-dormitory-management'
const HUMAN = 'D:\\Development\\VideCoding\\CRM Dormitory'
const AGENTS = 'D:\\Agents\\CRM Dormitory'

function api(apiPath) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(path.join(HOME, 'github.token'), 'utf8').trim()
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'User-Agent': 'dsh-recon',
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : null } catch (e) { parsed = null }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed)
        else reject(new Error('HTTP ' + res.statusCode + ': ' + ((parsed && parsed.message) || data.slice(0, 200))))
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

console.log('=== репозиторий ' + REPO + ' ===')
let repo
try {
  repo = await api('/repos/' + REPO)
  console.log('  существует     : да')
  console.log('  видимость      : ' + (repo.private ? 'private' : 'PUBLIC'))
  console.log('  default_branch : ' + repo.default_branch)
  console.log('  пустой         : ' + (repo.size === 0 ? 'ДА (size 0)' : 'нет (size ' + repo.size + ' КБ)'))
  console.log('  pushed_at      : ' + repo.pushed_at)
  console.log('  clone (ssh)    : ' + repo.ssh_url)
} catch (error) {
  console.log('  ОШИБКА: ' + error.message)
}

if (repo) {
  try {
    const branches = await api('/repos/' + REPO + '/branches?per_page=100')
    console.log('  ветки          : ' + (branches.length ? branches.map((b) => b.name).join(', ') : '(нет)'))
  } catch (error) {
    console.log('  ветки          : не прочитались — ' + error.message)
  }
  try {
    const items = await api('/repos/' + REPO + '/contents/')
    console.log('  файлов в корне : ' + items.length)
    for (const it of items.slice(0, 25)) console.log('    ' + it.type.padEnd(4) + ' ' + it.name)
    if (items.length > 25) console.log('    … ещё ' + (items.length - 25))
  } catch (error) {
    console.log('  корень         : ' + error.message)
  }
}

console.log('')
console.log('=== локальные каталоги ===')
for (const p of [HUMAN, AGENTS]) {
  let info = 'нет'
  try {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const entries = fs.readdirSync(p)
      const isGit = entries.includes('.git')
      info = 'есть, элементов ' + entries.length + (isGit ? ', git-репозиторий' : ', НЕ git')
      if (isGit) {
        try {
          const branch = execFileSync('git', ['-C', p, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
          const remote = execFileSync('git', ['-C', p, 'remote', '-v'], { encoding: 'utf8' }).trim().split('\n')[0] || '(нет)'
          const count = execFileSync('git', ['-C', p, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
          info += '\n      ветка: ' + (branch || '(detached)') + ', коммитов: ' + count + '\n      remote: ' + remote
        } catch (e) {
          info += '\n      git не ответил: ' + String(e.message).split('\n')[0]
        }
      }
    }
  } catch (e) { /* нет */ }
  console.log('  ' + p)
  console.log('      ' + info)
}

console.log('')
console.log('=== git доступен? ===')
try {
  console.log('  ' + execFileSync('git', ['--version'], { encoding: 'utf8' }).trim())
} catch (e) {
  console.log('  git не найден: ' + e.message)
}
