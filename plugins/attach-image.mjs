// attach_image — картинка в комментарии GitHub вместо пути на диске (issue #87).
//
// Роли показывают скриншоты: дизайнер — макет, тестировщик — состояние проверки.
// MCP-сервер GitHub вложений не умеет, поэтому путь к PNG оставался текстом, а
// человек открывал файл руками на своей машине. Инструмент закрывает звено:
// загружает локальную картинку в user-attachments GitHub и возвращает ровно одну
// markdown-строку `![alt](https://github.com/user-attachments/assets/<uuid>)`,
// которую роль вставляет в тело комментария.
//
// ТОКЕН — ОДИН НА ВСЕ РОЛИ И ЖИВЁТ У MCP-СЕРВЕРА: `<DSH_HOME>/mcp/
// github-mcp-server/token`. Роли токен не носят и про GitHub не знают; читает его
// только этот модуль, в момент вызова, и в результат не отдаёт. Нет файла или он
// пуст — это отказ инструмента с точной причиной, а не падение плагина.
//
// РЕПОЗИТОРИЙ ОПРЕДЕЛЯЕТСЯ ПО РАБОЧЕЙ ОБЛАСТИ ВЫЗЫВАЮЩЕЙ СЕССИИ, а не
// аргументом: одна и та же роль работает в разных проектах, и приложить снимок
// она обязана в свой репозиторий, а не в соседний. Рабочая область → проект →
// `repo` у отдела разработки: путь к реестру собирает `./state-paths.mjs`, форму
// документа и поиск проекта по корням — `./registry.mjs`. Оба модуля уже
// единственные места, где это знание живёт; второй копии здесь нет.
//
// КЭШ `repository_id`. GitHub требует числовой `repository_id`, а не `owner/repo`,
// поэтому первый вызов на репозиторий делает `GET /repos/<owner>/<repo>`. Кеш — в
// памяти процесса по `owner/repo`: второй снимок в ту же смену не повторяет
// запрос. Между запусками кеша нет намеренно: это цена одного GET, а не данные,
// которые стоит переживать перезапуск.
//
// ПОЧЕМУ ЖУРНАЛ. Вывод `console.*` из плагинов НЕ попадает в логи приложения
// (см. `role-sessions.mjs`), поэтому каждая загрузка и каждый отказ пишутся в
// `<DSH_HOME>/profiles/desktop/dsh-dev-department/attach-image.log`. Путь и имя
// называет `./state-paths.mjs`, как у остальных плагинов отдела.
//
// ГРАНИЦА СЕТИ. Вся сеть — в одной функции `httpRequest`, а оркестратор
// `attachImage` принимает её подменяемой (`deps.request`). Набор
// `plugins/tools/tests/attach-image.test.mjs` идёт без сети и без токена: он
// подставляет и `request`, и `token`, и документ реестра.
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { STATE_FILES, stateFile, readStateFile, dshHome } from './state-paths.mjs'
import { readRegistryFile, projectsOf, projectRoots, developmentOf, findProjectByRoots } from './registry.mjs'

/** Предел размера: больше GitHub не примет, а обрезать картинку — не наше дело. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Принимаемые расширения и их mime. По расширению, а не по содержимому. */
const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
])

/**
 * `repository_id` по `owner/repo` — на время жизни процесса. Ключ в нижнем
 * регистре: имена репозиториев GitHub регистронезависимы.
 */
const repositoryIdCache = new Map()

// Журнал отдела. Запись не должна ломать инструмент: сбой журнала — не сбой загрузки.
function trace(line) {
  try {
    fs.appendFileSync(stateFile(STATE_FILES.attachImage),
      new Date().toISOString() + ' [attach-image] ' + line + '\n')
  } catch (error) {
    // журналирование — удобство, а не условие работы
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

/** mime по расширению или `null`, если расширение не картинка из списка. */
export function mimeForFile(file) {
  return MIME_BY_EXTENSION.get(path.extname(String(file == null ? '' : file)).toLowerCase()) || null
}

/** Адрес загрузки: один POST, параметры — в строке запроса, файл — в теле. */
export function userAttachmentsUrl(name, mime, repositoryId) {
  return 'https://uploads.github.com/user-attachments/assets' +
    '?name=' + encodeURIComponent(String(name)) +
    '&content_type=' + encodeURIComponent(String(mime)) +
    '&repository_id=' + encodeURIComponent(String(repositoryId))
}

/** Готовая строка комментария. Ровно она и уходит роли. */
export function markdownFor(alt, url) {
  return '![' + String(alt) + '](' + String(url) + ')'
}

/** alt по умолчанию — имя файла без расширения. */
export function defaultAlt(file) {
  const full = String(file == null ? '' : file)
  return path.basename(full, path.extname(full))
}

/** Путь картинки: абсолютный как есть, относительный — от cwd сессии. */
export function resolveImagePath(input, cwd) {
  const value = String(input == null ? '' : input).trim()
  if (!value) throw new Error('attach_image: не задан путь к картинке (path)')
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(String(cwd == null ? '' : cwd) || process.cwd(), value)
}

/**
 * Локальная проверка до сети: расширение, существование, обычный файл, размер.
 * Любой отказ — исключение с точной причиной; сеть и токен не трогаются.
 */
export function inspectImageFile(file) {
  const full = String(file == null ? '' : file)
  const mime = mimeForFile(full)
  if (mime === null) {
    throw new Error('attach_image: не картинка — принимаются .png, .jpg и .jpeg: ' + full)
  }
  let stat
  try {
    stat = fs.statSync(full)
  } catch (error) {
    throw new Error('attach_image: файла нет: ' + full)
  }
  if (!stat.isFile()) {
    throw new Error('attach_image: это не обычный файл (каталог?): ' + full)
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error('attach_image: файл больше 8 МиБ (' + stat.size + ' байт): ' + full)
  }
  return { file: full, name: path.basename(full), mime, size: stat.size, data: fs.readFileSync(full) }
}

/** Токен MCP-сервера GitHub. Отсутствие и пустота — отказ с путём, не падение. */
export function readToken() {
  const file = path.join(dshHome(), 'mcp', 'github-mcp-server', 'token')
  let token = ''
  try {
    token = fs.readFileSync(file, 'utf8').trim()
  } catch (error) {
    throw new Error('attach_image: нет токена GitHub — файл ' + file + ' не читается; загрузка картинок не настроена')
  }
  if (!token) throw new Error('attach_image: токен GitHub пуст — файл ' + file)
  return token
}

/** Реестр проектов как документ. Нечитаемый файл или чужой формат — отказ. */
export function readProjectsDocument() {
  return readRegistryFile(readStateFile(STATE_FILES.projects)).document
}

/** Проект по рабочей области и его `repo`. Незнакомый путь — отказ с путём. */
export function repoForWorkspace(workspace, document) {
  const wanted = String(workspace == null ? '' : workspace)
  const project = findProjectByRoots(projectsOf(document), projectRoots, wanted)
  if (!project) {
    throw new Error('attach_image: рабочая область «' + wanted +
      '» не найдена в реестре проектов отдела — картинке некуда приложиться')
  }
  const department = developmentOf(project).department || {}
  const repo = String(department.repo == null ? '' : department.repo).trim()
  if (!repo) {
    throw new Error('attach_image: у проекта «' + project.id +
      '» отдела разработки пустой repo — картинке некуда приложиться')
  }
  return repo
}

/**
 * Сеть одним местом. `spec = {method, url, headers, body}` — `body` строкой или
 * буфером. Возвращает `{status, body}`. Подменяется в наборе через `deps.request`.
 */
export function httpRequest(spec) {
  return new Promise((resolve, reject) => {
    const url = new URL(String(spec.url))
    const headers = Object.assign({ 'User-Agent': 'dsh-attach-image' }, spec.headers || {})
    if (spec.body !== undefined && spec.body !== null) {
      headers['Content-Length'] = Buffer.byteLength(spec.body)
    }
    const req = https.request({
      host: url.hostname,
      path: url.pathname + url.search,
      method: spec.method || 'GET',
      headers,
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
      // Обрыв уже после прихода статуса: без слушателя `res` эмитит `error` и
      // промис не оседает. Отказ честный — роль впишет путь в комментарий.
      res.on('error', (error) => reject(new Error('attach_image: соединение оборвалось при ответе GitHub (' + messageOf(error) + ') — впиши путь и скажи, что картинка не приложилась')))
      res.on('aborted', () => reject(new Error('attach_image: GitHub оборвал ответ — впиши путь и скажи, что картинка не приложилась')))
    })
    req.setTimeout(30000, () => req.destroy(new Error('таймаут запроса к GitHub')))
    req.on('error', reject)
    req.end(spec.body === undefined || spec.body === null ? undefined : spec.body)
  })
}

/** Текст отказа загрузки: код GitHub и одна подсказка, что делать роли. */
export function uploadFailure(status, file) {
  const hint = 'впиши путь в текст комментария и скажи, что картинка не приложилась'
  if (status === 422) return 'attach_image: GitHub ответил 422 — этот файл не картинка и не видео; ' + hint + ': ' + file
  if (status === 404) return 'attach_image: GitHub ответил 404 — у токена нет push-права на репозиторий; ' + hint + ': ' + file
  if (status === 401 || status === 403) return 'attach_image: GitHub ответил ' + status + ' — токен не принят; ' + hint + ': ' + file
  return 'attach_image: GitHub ответил ' + status + ' при загрузке картинки; ' + hint + ': ' + file
}

/** Числовой `repository_id` с кешем по `owner/repo`. */
export async function repositoryIdFor(repo, request, token, cache) {
  const key = String(repo).toLowerCase()
  if (cache.has(key)) return cache.get(key)
  const response = await request({
    method: 'GET',
    url: 'https://api.github.com/repos/' + repo,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (response.status !== 200) {
    throw new Error('attach_image: GitHub не отдал id репозитория ' + repo + ' — ответ ' + response.status)
  }
  const row = parseJson(response.body)
  const id = row ? Number(row.id) : NaN
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('attach_image: в ответе GitHub нет id репозитория ' + repo)
  }
  cache.set(key, id)
  return id
}

/** Загрузка файла; возвращает адрес ассета из ответа `201`. */
export async function uploadImage({ name, mime, data, repositoryId, token, request }) {
  const response = await request({
    method: 'POST',
    url: userAttachmentsUrl(name, mime, repositoryId),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': mime,
    },
    body: data,
  })
  if (response.status !== 201) {
    throw new Error(uploadFailure(response.status, name))
  }
  const row = parseJson(response.body)
  const asset = row && typeof row.url === 'string' ? row.url : ''
  if (!asset) {
    throw new Error('attach_image: GitHub принял файл (201), но не вернул url — впиши путь в текст комментария и скажи, что картинка не приложилась: ' + name)
  }
  return asset
}

/**
 * Оркестратор инструмента. Порядок намеренный и проверяется набором:
 * локальные проверки → проект и repo по cwd → токен → кеш/GET id → POST загрузки.
 * До первого сетевого вызова ни токен, ни сеть не трогаются.
 *
 * `deps`: `cwd` (рабочая область сессии), `request`, `token`, `readDocument`,
 * `cache` — всё подставляется тестом.
 */
export async function attachImage(args, deps = {}) {
  const cwd = String(deps.cwd == null ? '' : deps.cwd).trim()
  if (!cwd) {
    throw new Error('attach_image: не удалось определить рабочую область вызывающей сессии (нет cwd)')
  }
  const image = inspectImageFile(resolveImagePath(args && args.path, cwd))

  const readDocument = deps.readDocument || readProjectsDocument
  const repo = repoForWorkspace(cwd, await readDocument())

  const alt = String(args && args.alt != null ? args.alt : '').trim() || defaultAlt(image.file)
  const token = deps.token !== undefined ? deps.token : readToken()
  const request = deps.request || httpRequest
  const cache = deps.cache || repositoryIdCache

  const repositoryId = await repositoryIdFor(repo, request, token, cache)
  const url = await uploadImage({
    name: image.name,
    mime: image.mime,
    data: image.data,
    repositoryId,
    token,
    request,
  })
  trace('attached ' + image.file + ' → ' + url)
  return markdownFor(alt, url)
}

export default {
  // Инструменту нужны только регистрация и cwd вызывающей сессии. Без объявленных
  // `inject` плагин применяется раньше бандлов, стартует в пустом окружении и молча
  // ничего не делает — см. шапку `role-sessions.mjs`.
  inject: ['tools', 'sessions'],

  apply(ctx) {
    const tools = ctx.get('tools')
    const sessions = ctx.get('sessions')
    if (!tools || !sessions) {
      trace('ABORT: tools или sessions недоступны, хотя объявлены в inject')
      return
    }

    // cwd вызывающей сессии — та же тропа, что у `resolveWorkspace` в role-sessions.
    function callerCwd(exec) {
      const caller = exec && exec.agent
      if (!caller) return ''
      const me = sessions.get(caller.id)
      return me && me.header && me.header.cwd ? me.header.cwd : ''
    }

    const tool = {
      name: 'attach_image',
      description: [
        'Приложить локальную картинку к комментарию GitHub и вернуть готовую markdown-строку ![alt](адрес).',
        'Принимаются .png, .jpg и .jpeg до 8 МиБ; путь абсолютный или относительный от рабочей области сессии.',
        'Репозиторий определяется по рабочей области: снимок уходит в проект вызывающей роли.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Путь к картинке: абсолютный или относительный от рабочей области сессии.',
          },
          alt: {
            type: 'string',
            description: 'Необязательный альтернативный текст. По умолчанию — имя файла без расширения.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args, exec) {
        try {
          const line = await attachImage(
            { path: args.path, alt: args.alt },
            { cwd: callerCwd(exec) },
          )
          return line
        } catch (error) {
          trace('attach_image FAILED: ' + messageOf(error))
          throw error
        }
      },
    }

    ctx.effect(() => tools.register(tool), 'attach-image:attach_image')
    trace('registrations issued')
  },
}
