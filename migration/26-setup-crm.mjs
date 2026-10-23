// Шаг 11: проект CRM Dormitory — конфиг + инициализация обоих пространств.
//
//   node 26-setup-crm.mjs --dry-run
//   node 26-setup-crm.mjs
//
// Репозиторий пуст, поэтому:
//   * каталог человека получает git init -b main и remote origin;
//   * пространство разработки — это clone того же remote (пустой клон: ветка
//     main ещё не рождена, коммитов нет — так и должно быть до первого push).
// Ничего не коммитится и не пушится: в каталоге человека пока нет файлов, а
// push в публичный репозиторий — решение человека.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DRY = process.argv.includes('--dry-run')

const ID = 'crm-dormitory'
const TITLE = 'CRM Dormitory'
const REPO = 'gidvantus/factory-dormitory-management'
const SSH_URL = 'git@github.com:' + REPO + '.git'
const HTTPS_URL = 'https://github.com/' + REPO + '.git'
const HUMAN = 'D:\\Development\\VideCoding\\CRM Dormitory'
const AGENTS = 'D:\\Agents\\CRM Dormitory'

const SCHEDULE = [
  { start: '13:00', stop: '04:00' },
  { start: '07:00', stop: '09:00' },
]

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitSafe(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd).trim() }
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    return { ok: false, out: (stderr || String(error.message)).split('\n')[0] }
  }
}

function hasGit(dir) {
  try { return fs.existsSync(path.join(dir, '.git')) } catch (e) { return false }
}

function isEmptyDir(dir) {
  try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0 } catch (e) { return false }
}

console.log('=== 1. конфигурация проекта ===')
{
  const file = path.join(HOME, 'projects.json')
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (registry.projects[ID]) {
    console.log('  [skip] проект ' + ID + ' уже есть в реестре')
  } else {
    registry.projects[ID] = {
      title: TITLE,
      repo: REPO,
      base: 'main',
      workspace: AGENTS,
      humanClone: HUMAN,
      composeProject: ID + '-agent',
      department: { enabled: true, windows: SCHEDULE, maxRework: 3 },
    }
    if (!DRY) {
      const bak = file + '.bak-crm'
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
      fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8')
    }
    console.log('  [ok]  проект ' + ID + ' добавлен (' + Object.keys(registry.projects).length + ' проекта)')
  }
}

console.log('')
console.log('=== 2. доступ к remote ===')
const sshCheck = gitSafe(['ls-remote', SSH_URL], process.cwd())
console.log('  ssh  : ' + (sshCheck.ok ? 'работает' : 'не работает — ' + sshCheck.out))
let remoteUrl = SSH_URL
if (!sshCheck.ok) {
  const httpsCheck = gitSafe(['ls-remote', HTTPS_URL], process.cwd())
  console.log('  https: ' + (httpsCheck.ok ? 'работает' : 'не работает — ' + httpsCheck.out))
  if (httpsCheck.ok) remoteUrl = HTTPS_URL
  else throw new Error('ни ssh, ни https не отвечают — инициализация невозможна')
}

console.log('')
console.log('=== 3. каталог человека ===')
console.log('  ' + HUMAN)
if (hasGit(HUMAN)) {
  console.log('    [skip] уже git-репозиторий')
} else if (!fs.existsSync(HUMAN)) {
  console.log('    [!] каталога нет — создаю')
  if (!DRY) fs.mkdirSync(HUMAN, { recursive: true })
} else if (!isEmptyDir(HUMAN)) {
  throw new Error('каталог человека не пуст и не является git-репозиторием: ' + HUMAN + ' — инициализацию не делаю')
}
if (!hasGit(HUMAN)) {
  if (!DRY) {
    git(['init', '-b', 'main'], HUMAN)
    git(['remote', 'add', 'origin', remoteUrl], HUMAN)
  }
  console.log('    [ok]  git init -b main, remote origin = ' + remoteUrl)
}

console.log('')
console.log('=== 4. пространство разработки ===')
console.log('  ' + AGENTS)
if (hasGit(AGENTS)) {
  console.log('    [skip] уже git-репозиторий')
} else if (!fs.existsSync(AGENTS)) {
  if (!DRY) fs.mkdirSync(AGENTS, { recursive: true })
  console.log('    каталог создан')
}
if (!hasGit(AGENTS)) {
  if (!isEmptyDir(AGENTS)) {
    throw new Error('каталог разработки не пуст и не является git-репозиторием: ' + AGENTS + ' — клонирование не делаю')
  }
  if (!DRY) {
    // Пустой remote: git создаст .git, настроит origin и оставит ветку main
    // нерождённой. Это ожидаемо до первого коммита.
    git(['clone', remoteUrl, AGENTS], os.homedir())
  }
  console.log('    [ok]  клон ' + remoteUrl + ' → ' + AGENTS)
}

console.log('')
console.log('=== 5. состояние ===')
for (const [label, dir] of [['человек', HUMAN], ['отдел', AGENTS]]) {
  console.log('  ' + label + ': ' + dir)
  if (!hasGit(dir)) { console.log('    НЕ git-репозиторий'); continue }
  const branch = gitSafe(['branch', '--show-current'], dir)
  const remote = gitSafe(['remote', 'get-url', 'origin'], dir)
  const count = gitSafe(['rev-list', '--count', 'HEAD'], dir)
  const status = gitSafe(['status', '--porcelain'], dir)
  const user = gitSafe(['config', 'user.email'], dir)
  console.log('    ветка    : ' + (branch.ok ? (branch.out || '(нерождённая)') : branch.out))
  console.log('    origin   : ' + (remote.ok ? remote.out : remote.out))
  console.log('    коммитов : ' + (count.ok ? count.out : 'нет (репозиторий пуст)'))
  console.log('    изменений: ' + (status.ok ? (status.out ? status.out.split('\n').length + ' шт.' : 'нет') : status.out))
  console.log('    user.email: ' + (user.ok && user.out ? user.out : '(не задан — коммит не пройдёт)'))
}

console.log(DRY ? '\n=== DRY RUN ===' : '\n=== ГОТОВО ===')
