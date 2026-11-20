// Пресеты ролей из веб-API: документ роли → каталог пресета DSH.
//
// Зачем это отдельно от диспетчера. `deployPresets()` (в `dev-department.mjs`)
// умеет разложить ГОТОВЫЙ каталог пресетов в `~/.dsh/.agent-presets`, но про веб
// не знает ничего: он не ходит в сеть и не собирает `SKILL.md` из документа.
// Сборка — отдельный шаг, и у неё свои правила (frontmatter, `##`-разделы, шаблон
// композиции); проверять их хочется без поднятого диспетчера и без сети.
//
// Почему веб не отдаёт готовые файлы. Раскладка и тексты пресетов остаются в git,
// а веб правит только тело ролей. Поэтому каталог пакета — основа, а документ из
// API — то, что кладётся поверх: композиция, прочие файлы роли и всё, чего веб не
// касается, обязаны пережить обновление. Иначе правка роли в вебе стирала бы
// `agent.cordis.yml`, который человек ведёт руками.
//
// Ревизии здесь НЕ считаются. Их считает сервер; harness только сравнивает строки
// и решает, что пора перечитывать. Вторая реализация хеша разошлась бы с первой
// на первом же изменении формата — и раскладка молча перестала бы обновляться.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Файл в корне пресетов: какие роли разложил отдел (чужие роли не перечисляются). */
export const DEPLOYED_ROLES_FILE = '.department-roles.json'

// Таймаут одного запроса к API. Диспетчер не должен зависать на мёртвом вебе:
// тик идёт по расписанию, и «висим на сокете» — худший вид отказа.
const REQUEST_TIMEOUT_MS = 10000

// Код роли и код скилла становятся именами каталогов. Слаг проверяется до записи
// на диск: `..` или `a/b` из сети увели бы запись за пределы каталога роли.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// ── Разбор и рендер SKILL.md ────────────────────────────────────────────────

// Первый перевод строки в LF: файлы приезжают и из git (LF), и из Windows (CRLF),
// а сравнение в `deployPresets` побайтное — раскладка не должна зависеть от того,
// где файл правили.
function toLf(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n')
}

// Frontmatter — блок между первой строкой `---` и следующим `---`. Нет второй
// границы — считаем, что frontmatter не закрыт, и весь файл идёт телом: скилл
// без описания полезнее, чем скилл, из которого исчезли все разделы.
function splitFrontmatter(text) {
  const lines = toLf(text).split('\n')
  if (lines.length > 0 && lines[0].replace(/^\uFEFF/, '').trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        return { front: lines.slice(1, i), body: lines.slice(i + 1) }
      }
    }
  }
  return { front: [], body: lines }
}

function yamlUnquote(raw) {
  const value = String(raw == null ? '' : raw).trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

// Значение ключа из frontmatter. Поддержаны три формы, которые реально пишут
// руками: строка, строка в кавычках и блочные `>`/`|` (сворачивающий и
// сохраняющий переводы строк). YAML-парсера в проекте нет и не будет — но и
// полный YAML здесь не нужен: у SKILL.md фронтматтер из двух ключей.
function frontmatterValue(front, key) {
  for (let i = 0; i < front.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(front[i])
    if (!match || match[1] !== key) continue
    const rest = match[2]
    const style = /^([>|])[+-]?[ \t]*$/.exec(rest)
    if (!style) return yamlUnquote(rest)
    // Блочное значение: отступ первого непустого продолжения — общий для блока.
    const block = []
    let indent = null
    for (let j = i + 1; j < front.length; j += 1) {
      const line = front[j]
      if (line.trim() === '') {
        block.push('')
        continue
      }
      if (indent === null) {
        const own = line.length - line.trimStart().length
        if (own === 0) break
        indent = own
      }
      if (line.length - line.trimStart().length < indent) break
      block.push(line.slice(indent).trimEnd())
    }
    // Хвостовые пустые строки блока — разделитель с следующим ключом, а не текст.
    while (block.length > 0 && block[block.length - 1] === '') block.pop()
    if (style[1] === '|') return block.join('\n')
    // `>`: соседние строки абзаца склеиваются пробелом, пустая строка — имя абзаца.
    const folded = []
    let paragraph = []
    for (const line of block) {
      if (line === '') {
        if (paragraph.length > 0) folded.push(paragraph.join(' '))
        paragraph = []
        continue
      }
      paragraph.push(line)
    }
    if (paragraph.length > 0) folded.push(paragraph.join(' '))
    return folded.join('\n')
  }
  return ''
}

// Убрать пустые строки по краям. Нужно и для чтения (тело раздела начинается
// после пустой строки за заголовком), и для рендера: иначе round-trip прибавлял
// бы по пустой строке на каждом проходе.
function trimBlankLines(lines) {
  let start = 0
  let stop = lines.length
  while (start < stop && lines[start].trim() === '') start += 1
  while (stop > start && lines[stop - 1].trim() === '') stop -= 1
  return lines.slice(start, stop)
}

/**
 * Разобрать `SKILL.md`: `{title, description, sections: [{title, body}]}`.
 *
 * Раздел — строка, которая начинается ровно с `## ` и находится ВНЕ блока кода.
 * Внутри ```` ``` ````/`~~~` заголовок — обычный текст: скиллы полны примеров
 * markdown, и считать их разделы структурой файла значило бы резать скилл по
 * чужому коду.
 */
export function parseSkillMarkdown(text) {
  const { front, body } = splitFrontmatter(text)
  const description = frontmatterValue(front, 'description')
  let title = ''
  const sections = []
  let current = null
  let fence = null

  for (const line of body) {
    // Границы блока кода. Открывает ```` ``` ````/`~~~` с любым хвостом (`js`),
    // закрывает только та же серия символов без хвоста.
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      const chars = marker[1]
      if (fence === null) {
        fence = { char: chars[0], length: chars.length }
      } else if (chars[0] === fence.char && chars.length >= fence.length && line.trim() === chars) {
        fence = null
      }
    }
    if (fence === null && line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (fence === null && line.startsWith('# ') && title === '' && sections.length === 0) {
      title = line.slice(2).trim()
      continue
    }
    if (current) current.lines.push(line)
  }

  return {
    title,
    description,
    sections: sections.map((section) => ({
      title: section.title,
      body: trimBlankLines(section.lines).join('\n'),
    })),
  }
}

// Одна строка из многострочного значения: переводы строк в YAML-скаляре и в
// frontmatter описания означали бы структуру, а описание — это текст.
function oneLine(value) {
  return String(value == null ? '' : value).replace(/[ \t]*\n[ \t]*/g, ' ').trim()
}

// YAML-скаляр в двойных кавычках, если без них он прочитается иначе. Кавычки
// ставим по правилу из постановки: `:`, `#` или спецсимвол в начале — значит
// значение может быть разобрано как ключ, комментарий или тип.
function yamlScalar(text) {
  const value = String(text == null ? '' : text)
  if (value === '') return '""'
  const needsQuote = /[:#]/.test(value) ||
    /^[-?:,[\]{}!&*|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value)
  if (!needsQuote) return value
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Собрать `SKILL.md` из документа скилла. Формат фиксирован, потому что его
 * читает DSH: frontmatter с `name`/`description`, заголовок `#`, разделы `##`.
 */
export function renderSkillMarkdown(skill) {
  const source = skill && typeof skill === 'object' ? skill : {}
  const code = oneLine(source.code)
  const title = oneLine(source.title)
  const description = oneLine(source.description)
  const sections = Array.isArray(source.sections) ? source.sections : []

  const blocks = [
    '---\nname: ' + code + '\ndescription: ' + yamlScalar(description) + '\n---',
    '# ' + title,
  ]
  for (const section of sections) {
    const item = section && typeof section === 'object' ? section : {}
    const sectionTitle = oneLine(item.title)
    // Тело раздела — markdown как есть: внутренние блоки кода и пустые строки
    // между абзацами значимы, вычищаем только края.
    const sectionBody = trimBlankLines(toLf(item.body).split('\n')).join('\n')
    blocks.push('## ' + sectionTitle + (sectionBody ? '\n\n' + sectionBody : ''))
  }
  return blocks.join('\n\n') + '\n'
}

/**
 * Собрать `preset.yml` роли: `name` и `description`. Многострочное описание уходит
 * блоком `>-`: оно читается глазами в списке ролей, и склеивать его в одну длинную
 * строку в файле незачем.
 */
export function renderPresetYml(preset) {
  const source = preset && typeof preset === 'object' ? preset : {}
  const title = oneLine(source.title)
  const description = toLf(source.description).trim()
  let out = 'name: ' + yamlScalar(title) + '\n'
  if (description.includes('\n')) {
    out += 'description: >-\n' +
      description.split('\n').map((line) => (line === '' ? '' : '  ' + line)).join('\n') + '\n'
  } else {
    out += 'description: ' + yamlScalar(description) + '\n'
  }
  return out
}

/**
 * Подставить роль в шаблон композиции. Плейсхолдеров нет — текст возвращается
 * как есть: шаблон может быть обычной композицией, и портить её незачем.
 */
export function renderCordis(templateText, role) {
  const template = String(templateText == null ? '' : templateText)
  if (!template.includes('{{role-code}}') && !template.includes('{{role-title}}')) return template
  const source = role && typeof role === 'object' ? role : {}
  const code = String(source.code == null ? '' : source.code)
  const title = String(source.title == null ? '' : source.title)
  return template.split('{{role-code}}').join(code).split('{{role-title}}').join(title)
}

// ── Список разложенных ролей ────────────────────────────────────────────────

// Коды из поля `removed` файла `.department-roles.json`: они проверены тем же слагом и
// тем же дедупликатором, что и `roles`.
function slugList(raw) {
  const list = raw && Array.isArray(raw.roles) ? raw.roles : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const code = item.trim()
    if (!SLUG_RE.test(code) || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out.sort()
}

function readDeployedFile(target) {
  if (!target) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(target, DEPLOYED_ROLES_FILE), 'utf8'))
  } catch (error) {
    return null
  }
}

/**
 * Читать `.department-roles.json`. Нет файла или он битый — пустой список: это не
 * ошибка, а первый запуск. Возвращается массив кодов, без мусора и повторов.
 */
export function readDeployedRoles(target) {
  return slugList(readDeployedFile(target))
}

/**
 * Коды ролей, удалённых в вебе. Это память раскладки: пакетная загрузка плагина
 * (`deployPresets`) не должна возвращать каталог роли, которую человек удалил в вебе,
 * иначе удаление живёт до первого перезапуска приложения. Код уходит из списка, когда
 * роль возвращается в манифест веба.
 */
export function readRemovedRoles(target) {
  const raw = readDeployedFile(target)
  return slugList(raw && Array.isArray(raw.removed) ? { roles: raw.removed } : null)
}

/**
 * Записать `.department-roles.json`. Список сортируется: файл сравнивают глазами
 * и в диффе, а порядок ролей в манифесте — достояние веба. `removed` — те коды, которые
 * разложены отделом раньше, но в вебе их больше нет; их пропускает загрузочная раскладка.
 */
export function writeDeployedRoles(target, roles, removed = []) {
  if (!target) return false
  const list = slugList({ roles })
  const gone = slugList({ roles: Array.isArray(removed) ? removed : [] })
    .filter((code) => !list.includes(code))
  try {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, DEPLOYED_ROLES_FILE),
      JSON.stringify({ roles: list, removed: gone }, null, 2) + '\n')
    return true
  } catch (error) {
    return false
  }
}

// ── Сборка staging-каталога ─────────────────────────────────────────────────

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch (error) {
    return false
  }
}

// Копия каталога пакета целиком. Ссылки не разворачиваем: раскладка — про файлы,
// а ссылка привела бы в чужой каталог, который отдел не обновляет.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const absFrom = path.join(from, entry.name)
    const absTo = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(absFrom, absTo)
    else if (entry.isFile()) fs.copyFileSync(absFrom, absTo)
  }
}

// Проверка документа до записи на диск: код роли — это имя каталога, `skills` —
// массив. Всё остальное разберёт рендер (пустой заголовок — беда текста, а не
// раскладки).
function documentProblem(doc, position) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'роль #' + position + ': документ должен быть объектом'
  }
  const code = typeof doc.code === 'string' ? doc.code.trim() : ''
  if (!SLUG_RE.test(code)) {
    return 'роль #' + position + ': код роли должен быть слагом (a-z0-9 и дефис) — ' +
      JSON.stringify(doc.code)
  }
  if (!Array.isArray(doc.skills)) return 'роль ' + code + ': skills должен быть массивом'
  for (const skill of doc.skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      return 'роль ' + code + ': скилл должен быть объектом'
    }
    const skillCode = typeof skill.code === 'string' ? skill.code.trim() : ''
    if (!SLUG_RE.test(skillCode)) {
      return 'роль ' + code + ': код скилла должен быть слагом (a-z0-9 и дефис) — ' +
        JSON.stringify(skill.code)
    }
  }
  return null
}

/**
 * Собрать в `staging` каталоги пресетов из документов ролей.
 *
 * `source` — каталог пакетных пресетов (`plugins/agent-presets`), `template` —
 * шаблон композиции для роли, которой в пакете ещё нет. Роль из пакета копируется
 * целиком и затем правится: `preset.yml` перезаписывается, `skills/` заменяется
 * ПОЛНОСТЬЮ — иначе скилл, убранный из документа, продолжал бы подгружаться из
 * прошлой версии.
 *
 * Возвращает `{ok, staging, roles, error}`; при ошибке staging не используется, и
 * вызывающая сторона просто выбрасывает каталог.
 */
export function buildStaging(options = {}) {
  const result = { ok: false, staging: options.staging || null, roles: [], error: null }
  const source = options.source
  // Вызывающая сторона даёт одноразовый каталог (обычно из `mkdtemp`). «С нуля» —
  // значит без остатков прошлого прогона: пустой каталог ровно тот, что нужен.
  const staging = options.staging

  try {
    if (!staging) {
      result.error = 'не задан каталог staging'
      return result
    }
    if (!Array.isArray(options.documents)) {
      result.error = 'документы ролей: нужен массив'
      return result
    }
    if (!source || !isDirectory(source)) {
      result.error = 'нет каталога пакетных пресетов: ' + String(source)
      return result
    }

    // Каждый документ проверяем ДО записи: половина ролей на диске и ошибка в
    // пятой — худший результат, чем отсутствие раскладки.
    for (let i = 0; i < options.documents.length; i += 1) {
      const problem = documentProblem(options.documents[i], i + 1)
      if (problem) {
        result.error = problem
        return result
      }
    }
    const codes = options.documents.map((doc) => doc.code.trim())
    const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index)
    if (duplicates.length > 0) {
      result.error = 'роль ' + duplicates[0] + ' встречается в документах дважды'
      return result
    }

    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })

    for (const doc of options.documents) {
      const code = doc.code.trim()
      const from = path.join(source, code)
      const to = path.join(staging, code)
      const title = oneLine(doc.title) || code
      const description = toLf(doc.description).trim()

      if (isDirectory(from)) {
        copyTree(from, to)
      } else {
        // Роли нет в пакете — единственный источник композиции шаблон. Нет
        // шаблона — молча собирать пресет без композиции нельзя: он не смонтируется.
        if (!options.template || !fs.existsSync(options.template)) {
          result.error = 'роль ' + code + ': нет каталога в пакете и нет шаблона композиции (' +
            String(options.template) + ')'
          return result
        }
        fs.mkdirSync(to, { recursive: true })
        fs.writeFileSync(path.join(to, 'agent.cordis.yml'),
          renderCordis(fs.readFileSync(options.template, 'utf8'), { code, title }))
      }

      fs.writeFileSync(path.join(to, 'preset.yml'), renderPresetYml({ title, description }))

      // `skills/` заменяется целиком, а не дополняется.
      fs.rmSync(path.join(to, 'skills'), { recursive: true, force: true })
      fs.mkdirSync(path.join(to, 'skills'), { recursive: true })
      const skills = doc.skills
        .map((skill) => skill)
        .sort((left, right) => String(left.code).localeCompare(String(right.code)))
      for (const skill of skills) {
        const skillCode = skill.code.trim()
        const dir = path.join(to, 'skills', skillCode)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMarkdown(skill))
      }
      result.roles.push(code)
    }

    result.roles.sort()
    result.ok = true
    result.staging = staging
    return result
  } catch (error) {
    result.ok = false
    result.roles = []
    result.error = 'сборка пресетов: ' + (error && error.message ? error.message : String(error))
    return result
  }
}

// ── Синхронизация с API ────────────────────────────────────────────────────

function stripTrailingSlash(value) {
  return String(value == null ? '' : value).trim().replace(/\/+$/, '')
}

/**
 * Запрос JSON с таймаутом. Ошибки не бросаются, а возвращаются: у вызывающего
 * один путь обработки — `{ok, error}`.
 */
function makeRequest(fetchImpl, token, timeoutMs) {
  return async function request(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = { Accept: 'application/json' }
      if (token) headers['X-Registry-Token'] = token
      const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
      const status = response && Number.isInteger(response.status) ? response.status : 0
      let text = ''
      try {
        text = await response.text()
      } catch (error) {
        text = ''
      }
      if (status === 401) return { ok: false, error: 'токен реестра не принят' }
      if (status === 404) return { ok: false, error: 'роль не найдена' }
      if (status !== 200) {
        let detail = ''
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed.detail === 'string') detail = parsed.detail
        } catch (error) {
          detail = ''
        }
        return { ok: false, error: url + ' ответил кодом ' + status + (detail ? ' — ' + detail : '') }
      }
      try {
        return { ok: true, body: JSON.parse(text) }
      } catch (error) {
        return { ok: false, error: 'ответ не JSON: ' + url }
      }
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? 'таймаут ответа'
        : (error && error.message ? error.message : String(error))
      return { ok: false, error: url + ': ' + message }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Привести раскладку в соответствие с вебом.
 *
 * `options`: `{apiUrl, token, source, template, target, deploy, applied,
 * fetchImpl, timeoutMs}`. `deploy` передаётся снаружи (обычно `deployPresets`),
 * чтобы у модуля не было циклического импорта с диспетчером. `applied` —
 * `{revision, roles: {code: revision}}` того, что уже разложено в этом процессе.
 *
 * Возвращает `{ok, revision, roles, roleRevisions, error, deployed, removed,
 * written, updated, unchanged}`. `roleRevisions` — карта «роль → ревизия», чтобы
 * вызывающему было чем заполнить `applied` в следующий раз.
 *
 * Исключений не бросает и НЕ трогает `target`, пока все документы не собраны:
 * недособранная раскладка опаснее старой.
 */
export async function syncPresets(options = {}) {
  const result = {
    ok: false,
    revision: null,
    roles: [],
    roleRevisions: {},
    error: null,
    deployed: false,
    removed: [],
    written: 0,
    updated: 0,
    unchanged: 0,
  }
  let staging = null
  try {
    const apiUrl = stripTrailingSlash(options.apiUrl)
    if (!apiUrl) {
      result.error = 'не задан адрес API пресетов'
      return result
    }
    const target = options.target
    if (!target) {
      result.error = 'не задан корень пресетов (target)'
      return result
    }
    if (typeof options.deploy !== 'function') {
      result.error = 'не передана функция раскладки (deploy)'
      return result
    }
    const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      result.error = 'нет fetch: сетевой запрос сделать нечем'
      return result
    }
    const token = typeof options.token === 'string' ? options.token : ''
    const applied = options.applied && typeof options.applied === 'object' ? options.applied : {}
    const appliedRoles = applied.roles && typeof applied.roles === 'object' && !Array.isArray(applied.roles)
      ? applied.roles
      : {}
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : REQUEST_TIMEOUT_MS
    const request = makeRequest(fetchImpl, token, timeoutMs)

    // 1. Манифест. Ревизию отдаёт сервер: сравниваем строки, ничего не считаем.
    const manifest = await request(apiUrl + '/api/presets')
    if (!manifest.ok) {
      result.error = 'пресеты из веба: ' + manifest.error
      return result
    }
    const doc = manifest.body
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      result.error = 'пресеты из веба: список ролей — не объект'
      return result
    }
    const revision = typeof doc.revision === 'string' ? doc.revision.trim() : ''
    if (revision === '') {
      result.error = 'пресеты из веба: в ответе нет ревизии'
      return result
    }
    if (!Array.isArray(doc.roles)) {
      result.error = 'пресеты из веба: в ответе нет списка ролей'
      return result
    }
    const live = []
    for (const entry of doc.roles) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        result.error = 'пресеты из веба: роль в списке — не объект'
        return result
      }
      const code = typeof entry.code === 'string' ? entry.code.trim() : ''
      if (!SLUG_RE.test(code)) {
        result.error = 'пресеты из веба: код роли не слаг — ' + JSON.stringify(entry.code)
        return result
      }
      live.push({ code, revision: typeof entry.revision === 'string' ? entry.revision.trim() : '' })
    }
    result.revision = revision

    // 2. Та же ревизия, что уже разложена — работы нет. Это самый частый тик.
    if (typeof applied.revision === 'string' && applied.revision === revision) {
      result.ok = true
      result.roles = live.map((entry) => entry.code).sort()
      result.roleRevisions = Object.fromEntries(live.map((entry) => [entry.code, entry.revision]))
      return result
    }

    // 3. Пустой манифест — допустим, но раскладка не запускается вовсе: правило
    // «пустая база не стирает пакетные скиллы» сильнее полноты синхронизации.
    if (live.length === 0) {
      result.ok = true
      return result
    }

    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
    const plan = live.filter((entry) => !hasOwn(appliedRoles, entry.code) ||
      appliedRoles[entry.code] !== entry.revision)

    const deployedByUs = plan.length > 0
    if (deployedByUs) {
      // 4. Документы — только по изменившимся ролям: сеть — самое дорогое в тике.
      const documents = []
      for (const entry of plan) {
        const answer = await request(apiUrl + '/api/presets/' + encodeURIComponent(entry.code))
        if (!answer.ok) {
          result.error = 'пресеты из веба: роль ' + entry.code + ': ' + answer.error
          return result
        }
        const roleDoc = answer.body
        if (!roleDoc || typeof roleDoc !== 'object' || Array.isArray(roleDoc)) {
          result.error = 'пресеты из веба: роль ' + entry.code + ': документ — не объект'
          return result
        }
        if (typeof roleDoc.code !== 'string' || roleDoc.code.trim() !== entry.code) {
          result.error = 'пресеты из веба: роль ' + entry.code + ': документ про другую роль'
          return result
        }
        documents.push(roleDoc)
      }

      // 5. Сборка. Каталог одноразовый: источник раскладки — staging, а не пакет,
      // иначе чужие файлы пакета поехали бы в `target` мимо правил.
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-presets-'))
      const built = buildStaging({
        source: options.source,
        documents,
        template: options.template,
        staging,
      })
      if (!built.ok) {
        result.error = 'пресеты из веба: ' + built.error
        return result
      }

      const deployed = await options.deploy({ source: staging, target })
      if (deployed && deployed.problem) {
        result.error = 'пресеты из веба: раскладка: ' + deployed.problem
        return result
      }
      result.deployed = true
      result.written = Number.isInteger(deployed && deployed.written) ? deployed.written : 0
      result.updated = Number.isInteger(deployed && deployed.updated) ? deployed.updated : 0
      result.unchanged = Number.isInteger(deployed && deployed.unchanged) ? deployed.unchanged : 0
    }

    // 6. Список ролей отдела: все живые роли манифеста. Он же — единственный
    // источник, по которому удаляются каталоги: роли, заведённые человеком, в
    // этом файле не значатся и удалить их нельзя.
    //
    // Вместе с ним пишется список удалённых кодов: загрузочная раскладка пакета
    // (`deployPresets` при старте плагина) пропускает их, иначе удалённая в вебе роль
    // возвращалась бы после каждого перезапуска приложения. Код, вернувшийся в манифест,
    // из этого списка уходит — тогда пакетная раскладка снова имеет право его класть.
    const nextRoles = live.map((entry) => entry.code).sort()
    const previous = readDeployedRoles(target)
    const removed = previous.filter((code) => !nextRoles.includes(code))
    for (const code of removed) {
      try {
        fs.rmSync(path.join(target, code), { recursive: true, force: true })
      } catch (error) {
        result.error = 'пресеты из веба: не удаляется устаревшая роль ' + code + ': ' +
          (error && error.message ? error.message : String(error))
        return result
      }
    }
    result.removed = removed
    const gone = [...readRemovedRoles(target), ...removed]
      .filter((code) => !nextRoles.includes(code))
    if (!writeDeployedRoles(target, nextRoles, gone)) {
      result.error = 'пресеты из веба: не записывается список разложенных ролей в ' + target
      return result
    }

    result.ok = true
    result.roles = nextRoles
    result.roleRevisions = Object.fromEntries(live.map((entry) => [entry.code, entry.revision]))
    return result
  } catch (error) {
    result.ok = false
    result.error = 'пресеты из веба: ' + (error && error.message ? error.message : String(error))
    return result
  } finally {
    if (staging) {
      // Одноразовый каталог: после раскладки он не нужен никому.
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch (error) {
        // уборка staging не должна менять вердикт синхронизации
      }
    }
  }
}
