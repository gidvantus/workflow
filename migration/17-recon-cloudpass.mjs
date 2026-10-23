// Разведка перед добавлением проекта CloudPass: что можно узнать, а не угадать.
//   - существует ли репозиторий и какая в нём базовая ветка;
//   - какие файлы compose в нём лежат;
//   - существуют ли локальные каталоги (клон отдела и клон человека);
//   - как устроен стенд отдела в vahta: откуда взялись порты 8080/8001.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

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

console.log('=== репозиторий gidvantus/cloudpass ===')
try {
  const repo = await api('/repos/gidvantus/cloudpass')
  console.log('  существует       : да')
  console.log('  private          : ' + repo.private)
  console.log('  default_branch   : ' + repo.default_branch)
  console.log('  пустой (size=0)  : ' + (repo.size === 0 ? 'ДА' : 'нет (size ' + repo.size + ' КБ)'))
  console.log('  pushed_at        : ' + repo.pushed_at)
} catch (error) {
  console.log('  ОШИБКА: ' + error.message)
}

console.log('')
console.log('=== ветки cloudpass ===')
try {
  const branches = await api('/repos/gidvantus/cloudpass/branches?per_page=100')
  for (const b of branches) console.log('  ' + b.name)
} catch (error) {
  console.log('  не прочитались: ' + error.message)
}

console.log('')
console.log('=== корень cloudpass ===')
try {
  const items = await api('/repos/gidvantus/cloudpass/contents/')
  for (const it of items) console.log('  ' + it.type.padEnd(4) + ' ' + it.name)
} catch (error) {
  console.log('  не прочитался: ' + error.message)
}

console.log('')
console.log('=== локальные каталоги ===')
for (const p of ['D:\\Agents\\CloudPass', 'D:\\Development\\VideCoding\\CloudPass', 'D:\\Agents\\vahta', 'D:\\Development\\VideCoding\\Vahta']) {
  let info = 'нет'
  try {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const entries = fs.readdirSync(p)
      info = 'есть, элементов ' + entries.length + (entries.includes('.git') ? ', это git-репозиторий' : ', .git нет')
    }
  } catch (e) { /* нет */ }
  console.log('  ' + p.padEnd(40) + ' ' + info)
}

console.log('')
console.log('=== как устроен стенд отдела в vahta ===')
for (const dir of ['D:\\Agents\\vahta', 'D:\\Development\\VideCoding\\Vahta']) {
  console.log('  ' + dir)
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^docker-compose.*\.ya?ml$/i.test(f)) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8')
        const ports = text.split(/\r?\n/).filter((l) => /^\s*-\s*["']?\d+:\d+/.test(l)).map((l) => l.trim())
        console.log('    ' + f.padEnd(34) + ' портов в файле: ' + ports.length + (ports.length ? ' → ' + ports.join(' ') : ''))
      }
    }
  } catch (e) {
    console.log('    каталог недоступен')
  }
}
