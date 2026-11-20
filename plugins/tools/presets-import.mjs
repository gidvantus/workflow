// Заливка пакетных пресетов ролей в веб-API (`PUT /api/presets/{code}`).
//
// Зачем инструмент. После переезда ролей в веб единственный способ завести их —
// отдать документы через API. Писать их руками в редакторе веба бессмысленно:
// тексты ролей живут в git и правятся там. Инструмент читает пакет, собирает
// документ роли (тот же формат, что отдаёт `GET /api/presets/{code}`) и шлёт его;
// повторный запуск на неизменённом пакете даёт `unchanged` и ничего не меняет.
//
// Запуск:
//   node plugins/tools/presets-import.mjs [--api <url>] [--token <token>]
//                                         [--source <каталог>] [--dry-run]
//
// `--api` — БАЗА API (`http://localhost:8096`), а не готовая ручка: путь `/api`
// принадлежит вебу, и держать его вторую копию здесь незачем.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseSkillMarkdown } from '../presets.mjs'
import { STATE_FILES, readStateFile } from '../state-paths.mjs'

// Каталог пакетных пресетов рядом с плагином. Флаг `--source` нужен тестам и
// разовой правке: гонять инструмент по временному каталогу иначе нечем.
const DEFAULT_SOURCE = fileURLToPath(new URL('../agent-presets/', import.meta.url))

// Таймаут одного `PUT`. Мёртвый веб не должен оставлять инструмент висеть.
const REQUEST_TIMEOUT_MS = 10000

// Ключи `preset.yml`, которые нас интересуют. Остальное — достояние человека.
function parsePresetYml(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
  const values = {}
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1]
    const rest = match[2]
    const block = /^([>|])[+-]?[ \t]*$/.exec(rest)
    if (!block) {
      values[key] = unquote(rest)
      continue
    }
    const collected = []
    let indent = null
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') {
        collected.push('')
        continue
      }
      if (indent === null) {
        const own = line.length - line.trimStart().length
        if (own === 0) break
        indent = own
      }
      if (line.length - line.trimStart().length < indent) break
      collected.push(line.slice(indent).trimEnd())
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
    values[key] = block[1] === '|' ? collected.join('\n') : collected.join(' ').replace(/ {2,}/g, ' ')
  }
  return values
}

function unquote(raw) {
  const value = String(raw == null ? '' : raw).trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

// Все `SKILL.md` под `skills/` роли. Код скилла — имя его каталога: раскладка
// пресета кладёт скилл ровно в `skills/<код>/SKILL.md`, и другой формы у неё нет.
function collectSkills(skillsDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(abs)
    }
  }
  if (skillsDir && fs.existsSync(skillsDir)) walk(skillsDir)
  return found.sort()
}

// Документ роли из каталога пакета. Нет `preset.yml` — роль всё равно уходит:
// имя роли в этом случае — код каталога, и веб это переживёт; терять скиллы из-за
// отсутствующего файла описания хуже.
function buildDocument(source, code) {
  const roleDir = path.join(source, code)
  const metaFile = path.join(roleDir, 'preset.yml')
  let meta = {}
  if (fs.existsSync(metaFile)) meta = parsePresetYml(fs.readFileSync(metaFile, 'utf8'))
  const skills = []
  const seen = new Set()
  for (const file of collectSkills(path.join(roleDir, 'skills'))) {
    const skillCode = path.basename(path.dirname(file))
    if (seen.has(skillCode)) {
      return { error: 'роль ' + code + ': скилл ' + skillCode + ' встречается дважды — код скилла должен быть уникальным' }
    }
    seen.add(skillCode)
    const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'))
    skills.push({
      code: skillCode,
      // Скилл без заголовка `#` — обычное дело в пакете; веб требует название,
      // поэтому пустое имя заменяется кодом, а не отказом заливки.
      title: parsed.title || skillCode,
      description: parsed.description,
      sections: parsed.sections,
    })
  }
  skills.sort((left, right) => left.code.localeCompare(right.code))
  return {
    document: {
      code,
      title: meta.name || code,
      description: meta.description || '',
      skills,
    },
  }
}

function roleCodes(source) {
  let entries
  try {
    entries = fs.readdirSync(source, { withFileTypes: true })
  } catch (error) {
    return null
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .sort()
}

// Настройки отдела: `registry.apiUrl` — это адрес ручки реестра
// (`…/api/registry`), а нам нужна база API. Путь отрезаем, чтобы у веба
// остался один адрес, а не два разных представления одного и того же.
function settingsFromConfig() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(readStateFile(STATE_FILES.config), 'utf8'))
  } catch (error) {
    return {}
  }
  const registry = raw && raw.registry && typeof raw.registry === 'object' ? raw.registry : {}
  const apiUrl = typeof registry.apiUrl === 'string' ? registry.apiUrl.trim() : ''
  return {
    apiUrl: apiUrl.replace(/\/api\/registry\/?$/, '').replace(/\/api\/?$/, '').replace(/\/+$/, ''),
    token: typeof registry.token === 'string' ? registry.token.trim() : '',
  }
}

async function putDocument(apiUrl, token, document) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (token) headers['X-Registry-Token'] = token
    const response = await fetch(apiUrl + '/api/presets/' + encodeURIComponent(document.code), {
      method: 'PUT',
      headers,
      body: JSON.stringify(document),
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.status === 401) return { error: 'токен реестра не принят' }
    if (response.status === 422) return { error: 'документ роли не принят: ' + detailOf(text) }
    if (response.status !== 200) {
      return { error: 'API ответил кодом ' + response.status + ': ' + detailOf(text) }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { error: 'ответ не JSON: ' + text.slice(0, 200) }
    }
    return { changed: parsed && parsed.changed === true, revision: parsed && parsed.revision }
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'таймаут ответа'
      : (error && error.message ? error.message : String(error))
    return { error: message }
  } finally {
    clearTimeout(timer)
  }
}

function detailOf(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.detail === 'string') return parsed.detail
  } catch (error) {
    // не JSON — покажем как есть
  }
  return String(text == null ? '' : text).trim().slice(0, 200)
}

async function main() {
  const options = { dryRun: false }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--api') options.apiUrl = args[++i] || ''
    else if (arg === '--token') options.token = args[++i] || ''
    else if (arg === '--source') options.source = path.resolve(args[++i] || '')
    else if (arg === '--dry-run') options.dryRun = true
    else {
      console.error('неизвестный аргумент: ' + arg)
      console.error('использование: node tools/presets-import.mjs [--api <url>] [--token <token>] ' +
        '[--source <каталог>] [--dry-run]')
      return 2
    }
  }

  const source = options.source || DEFAULT_SOURCE
  const codes = roleCodes(source)
  if (codes === null) {
    console.error('ошибка: нет каталога пресетов: ' + source)
    return 1
  }
  if (codes.length === 0) {
    console.error('ошибка: в каталоге пресетов нет ни одной роли: ' + source)
    return 1
  }

  // `--dry-run` не должен зависеть от настроек и сети: он показывает ровно то,
  // что уйдёт в API, и на этом заканчивается.
  if (options.dryRun) {
    for (const code of codes) {
      const built = buildDocument(source, code)
      if (built.error) {
        console.error('ошибка: ' + built.error)
        return 1
      }
      console.log(JSON.stringify(built.document, null, 2))
    }
    console.log('ролей: ' + codes.length + ', изменено: 0 (dry-run, ничего не отправлено)')
    return 0
  }

  const settings = settingsFromConfig()
  const apiUrl = String(options.apiUrl || settings.apiUrl || '').trim().replace(/\/+$/, '')
  const token = String(options.token || settings.token || '').trim()
  if (!apiUrl) {
    console.error('ошибка: не задан адрес API — нужен --api или registry.apiUrl в настройках отдела')
    return 1
  }
  if (!token) {
    console.error('ошибка: не задан токен реестра — нужен --token или registry.token в настройках отдела')
    return 1
  }

  let changed = 0
  for (const code of codes) {
    const built = buildDocument(source, code)
    if (built.error) {
      console.error('ошибка: ' + built.error)
      return 1
    }
    const answer = await putDocument(apiUrl, token, built.document)
    if (answer.error) {
      // Первая ошибка останавливает заливку: половина ролей в одном состоянии,
      // половина в другом — хуже, чем «не залито ничего».
      console.error('ошибка: роль ' + code + ': ' + answer.error)
      return 1
    }
    if (answer.changed) changed += 1
    console.log(code + ': ' + (answer.changed ? 'changed' : 'unchanged'))
  }
  console.log('ролей: ' + codes.length + ', изменено: ' + changed)
  return 0
}

// Верхний уровень не бросает стеком: у инструмента есть код выхода и сообщение.
main().then((code) => process.exit(code)).catch((error) => {
  console.error('ошибка: ' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})
