// GitHub — плагин пресета: issues, метки и PR проекта сессии. Репозиторий и
// базовая ветка берутся из ~/.dsh/projects.json по рабочей области сессии
// (инструмент project_info), а не из этого файла.
//
// Зачем плагин, а не просто curl: токен читается здесь же и агенту НЕ
// показывается. Инструменты принимают осмысленные аргументы (номер issue,
// текст комментария), а не произвольный HTTP-запрос, поэтому даже при
// ошибочном вызове утечь токену некуда.
//
// Контракт между ролями — метки, созданные в репозитории:
//   ready-for-dev → in-progress → for-code-review → ready-for-test → tested | test-failed
//
// Базовая ветка — поле base проекта: в неё открываются PR и от неё
// ответвляются feature-ветки.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// ── Реестр проектов ─────────────────────────────────────────────────────────
// Ни репозиторий, ни базовая ветка, ни рабочая копия здесь не заданы: они
// принадлежат проекту и живут в ~/.dsh/projects.json. Проект выбирается по
// рабочей области вызывающей сессии, поэтому один и тот же пресет обслуживает
// все проекты машины. Формат файла:
//   { "default": "<id>",
//     "projects": { "<id>": { "repo": "owner/name", "base": "develop-m",
//                             "workspace": "D:\\Agents\\<id>",
//                             "humanClone": "D:\\...",
//                             "composeProject": "<id>-agent",
//                             "frontendPort": 8080, "apiPort": 8001 } } }

const PIPELINE_LABELS = {
  dev: 'ready-for-dev',
  progress: 'in-progress',
  review: 'for-code-review',
  test: 'ready-for-test',
  ok: 'tested',
  failed: 'test-failed',
  // Единственная метка, которую может поставить автор постановки: она включает
  // ступень макета в конвейере.
  mockup: 'needs-mockup',
  mockupsReady: 'mockups-ready',
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function registryFile() {
  return path.join(dshHomeDir(), 'projects.json')
}

// BOM в начале файла (его пишут редакторы Windows и PowerShell) ломает
// JSON.parse невидимым символом. Реестр — обычный файл, который человек
// правит руками, поэтому читаем его снисходительно.
function stripBom(text) {
  const value = String(text)
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

function readRegistry() {
  const file = registryFile()
  let raw
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(
      'не читается реестр проектов ' + file + ': ' + (error && error.message ? error.message : String(error)) +
      '. Нужен файл вида {"default":"<id>","projects":{"<id>":{"repo":"owner/name","base":"develop-m","workspace":"D:\\\\Agents\\\\<id>"}}}',
    )
  }
  const projects = (raw && raw.projects) || {}
  const ids = Object.keys(projects)
  if (ids.length === 0) throw new Error('реестр ' + file + ' пуст: в "projects" нет ни одного проекта')
  const fallbackId = typeof raw.default === 'string' && raw.default ? raw.default : ids[0]
  return { projects, ids, defaultId: fallbackId }
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function projectArtifacts(raw) {
  if (typeof raw.artifacts === 'string' && raw.artifacts) return raw.artifacts
  const workspace = String(raw.workspace || '').replace(/[\\/]+$/, '')
  return workspace ? workspace + '-artifacts' : ''
}

function projectRow(registry, id, cwd) {
  const raw = registry.projects[id] || {}
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : id,
    repo: String(raw.repo || ''),
    base: typeof raw.base === 'string' && raw.base ? raw.base : 'main',
    workspace: String(raw.workspace || ''),
    humanClone: typeof raw.humanClone === 'string' ? raw.humanClone : '',
    composeProject: typeof raw.composeProject === 'string' && raw.composeProject ? raw.composeProject : id,
    artifacts: projectArtifacts(raw),
    frontendPort: Number.isInteger(raw.frontendPort) ? raw.frontendPort : 8080,
    apiPort: Number.isInteger(raw.apiPort) ? raw.apiPort : 8001,
    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),
    matched: false,
    cwd: cwd || '',
  }
}

// Проект сессии — рабочая область с самым длинным совпадающим префиксом. Если
// она не совпала ни с одним проектом, проект по умолчанию берётся только когда
// он в реестре один: молча работать не с тем репозиторием хуже, чем встать.
function pickProject(registry, cwd) {
  const wanted = normalizePath(cwd)
  if (wanted) {
    let best = null
    let bestLength = -1
    for (const id of registry.ids) {
      const row = projectRow(registry, id, cwd)
      // Сессия может стоять и в рабочей копии отдела, и в каталоге человека:
      // оба принадлежат проекту, поэтому оба — его корни.
      for (const candidate of [row.workspace, row.humanClone]) {
        const root = normalizePath(candidate)
        if (!root) continue
        if (wanted === root || wanted.indexOf(root + '\\') === 0) {
          if (root.length > bestLength) { best = row; bestLength = root.length }
        }
      }    }
    if (best) { best.matched = true; return best }
  }
  if (registry.ids.length > 1) {
    throw new Error(
      'рабочая область ' + (cwd || '(неизвестна)') + ' не совпала ни с одним проектом из ' + registryFile() +
      '. Известные проекты: ' + registry.ids.map((id) => id + ' (' + (registry.projects[id] || {}).workspace + ')').join(', ') +
      '. Откройте сессию в рабочей области проекта.',
    )
  }
  return projectRow(registry, registry.defaultId, cwd)
}

function tokenPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'github.token')
}

function readToken() {
  const file = tokenPath()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error('не читается файл токена ' + file + ': ' + error.message)
  }
  const token = raw.trim()
  if (!token) throw new Error('файл токена пуст: ' + file)
  return token
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    let token
    try {
      token = readToken()
    } catch (error) {
      reject(error)
      return
    }
    const payload = body === undefined ? null : JSON.stringify(body)
    let settled = false
    // req.setTimeout следит только за уже подключённым сокетом: если зависли
    // DNS или само соединение, он не сработает, и вызов провисит бесконечно —
    // именно так встал конвейер. Срок ставим отдельным таймером: он накрывает
    // и lookup, и connect, и ответ.
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('таймаут 30 с: ' + method + ' ' + apiPath.split('?')[0]))
    }, 30000)
    function finish(next, value) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      next(value)
    }
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'dsh-github-plugin',
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data.length > 0 ? JSON.parse(data) : null } catch (error) { parsed = null }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          finish(resolve, parsed)
          return
        }
        const message = (parsed && parsed.message) || data.slice(0, 300) || 'пустой ответ'
        finish(reject, new Error('GitHub ' + res.statusCode + ': ' + message))
      })
    })
    req.on('error', (error) => finish(reject, new Error('сеть: ' + error.message)))
    req.setTimeout(30000, () => { req.destroy(new Error('таймаут 30 с')) })
    req.end(payload === null ? undefined : payload)
  })
}

// ── Заголовок роли в первой строке комментария ──────────────────────────────
// Диспетчер отдела разбирает историю тикета по первой строке: по заголовку роли
// он отличает свои комментарии от ревьюерских и находит начало круга доработок.
// Поэтому формат — часть контракта конвейера, а не пожелание скилла: тело без
// заголовка не уходит в GitHub вовсе, и проверка стоит ДО сетевого запроса.
//
// Имя роли ниже — дословно то, что записано в скилле этой роли. Привязки к id
// пресета в файле нет: таблицы «пресет → имя роли» здесь не появляется.
const ROLE_NAME = 'аналитик'

const ROLE_LINE = /^\*\*Роль:\*\* (\S[^\n]*?) · (\S[^\n]*)$/

function assertRoleHeader(body, role) {
  const sample = '**Роль:** ' + role + ' · что сделано и как проверить'
  const first = String(typeof body === 'string' ? body : '').split('\n')[0].replace(/\r$/, '')
  const found = ROLE_LINE.exec(first)
  if (!found) {
    throw new Error('первая строка комментария — заголовок роли, например: ' + sample +
      '. Роль в этом пресете — ' + role + '. Комментарий не отправлен: запроса в GitHub не было.')
  }
  const name = found[1].trim()
  const words = found[2].trim().split(/\s+/).filter((word) => word !== '')
  if (name.length < 2 || name.length > 80) {
    throw new Error('имя роли в первой строке — от 2 до 80 символов, а не «' + name + '». Образец: ' +
      sample + '. Комментарий не отправлен: запроса в GitHub не было.')
  }
  if (words.length < 3 || words.length > 12) {
    throw new Error('«о чём» в первой строке — от 3 до 12 слов, а их ' + words.length + '. Образец: ' +
      sample + '. Комментарий не отправлен: запроса в GitHub не было.')
  }
  return first
}

function labelNames(raw) {
  return (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
}

function issueView(raw) {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    labels: labelNames(raw),
    assignees: (raw.assignees || []).map((a) => a.login),
    comments: raw.comments,
    updatedAt: raw.updated_at,
    url: raw.html_url,
    body: raw.body || '',
  }
}

function prView(raw) {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    draft: !!raw.draft,
    head: raw.head && raw.head.ref,
    base: raw.base && raw.base.ref,
    mergeable: raw.mergeable,
    merged: !!raw.merged,
    url: raw.html_url,
    body: raw.body || '',
  }
}

export default {
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (!tools) throw new Error('github: сервис tools недоступен, инструменты не зарегистрированы')
    const sessions = ctx.get('sessions')

    // Инструменты пресета общие для всех сессий на этом пресете (standing
    // mount), поэтому проект определяется на каждом вызове, а не при
    // регистрации инструмента.
    function callerCwd(exec) {
      try {
        const caller = exec && exec.agent
        if (!caller || !sessions) return ''
        const session = sessions.get(caller.id)
        return (session && session.header && session.header.cwd) || ''
      } catch (error) {
        return ''
      }
    }

    function resolveProject(exec) {
      return pickProject(readRegistry(), callerCwd(exec))
    }

    function define(name, description, parameters, run) {
      return {
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
        },
        async execute(args, exec) {
          const p = resolveProject(exec)
          // У проекта может не быть репозитория вовсе (рабочий каталог, не
          // связанный с GitHub). Говорим об этом прямо: иначе инструмент ушёл
          // бы на /repos//issues/… и вернул невнятную ошибку.
          if (!p.repo && name !== 'project_info') {
            throw new Error('у проекта ' + p.id + ' не задан repo в ~/.dsh/projects.json — инструменты GitHub для него недоступны')
          }
          return JSON.stringify(await run(args || {}, p), null, 2)
        },
      }
    }

    const issueTool = define(
      'gh_issue',
      'Прочитать issue проекта: заголовок, тело, метки, назначенные, ссылку.',
      {
        type: 'object',
        properties: { number: { type: 'integer', description: 'Номер issue' } },
        required: ['number'],
        additionalProperties: false,
      },
      async (a, p) => issueView(await api('GET', '/repos/' + p.repo + '/issues/' + a.number)),
    )

    const issuesTool = define(
      'gh_issues',
      'Список issue проекта, по умолчанию открытых. Фильтруется по метке — так tester находит `ready-for-test`, а dev — `ready-for-dev`.',
      {
        type: 'object',
        properties: {
          labels: { type: 'string', description: 'Метки через запятую, например "ready-for-test". Пусто — без фильтра.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Состояние, по умолчанию open.' },
          limit: { type: 'integer', description: 'Сколько вернуть, по умолчанию 20.' },
        },
        required: [],
        additionalProperties: false,
      },
      async (a, p) => {
        const state = a.state || 'open'
        const limit = a.limit && a.limit > 0 && a.limit <= 100 ? a.limit : 20
        const query = 'state=' + state + '&per_page=' + limit + '&sort=updated'
        const labels = typeof a.labels === 'string' ? a.labels.trim() : ''
        const apiPath = '/repos/' + p.repo + '/issues?' + query + (labels ? '&labels=' + encodeURIComponent(labels) : '')
        const rows = await api('GET', apiPath)
        return rows.filter((r) => !r.pull_request).map((r) => ({
          number: r.number,
          title: r.title,
          labels: labelNames(r),
          assignees: (r.assignees || []).map((x) => x.login),
          updatedAt: r.updated_at,
          url: r.html_url,
        }))
      },
    )

    const commentTool = define(
      'gh_issue_comment',
      'Добавить комментарий в issue. Так dev отчитывается о сделанном, а tester пишет вердикт с воспроизведением. Первая строка — заголовок роли: `**Роль:** <имя> · <о чём>`; без него инструмент отказывает до сетевого запроса.',
      {
        type: 'object',
        properties: {
          number: { type: 'integer', description: 'Номер issue' },
          body: { type: 'string', description: 'Текст комментария (markdown)' },
        },
        required: ['number', 'body'],
        additionalProperties: false,
      },
      async (a, p) => {
        assertRoleHeader(a.body, ROLE_NAME)
        const created = await api('POST', '/repos/' + p.repo + '/issues/' + a.number + '/comments', { body: a.body })
        return { commentId: created && created.id, url: created && created.html_url }
      },
    )

    // Метки этого пресета — только одна и только через отдельный инструмент.
    // Общий редактор меток убран: он позволял поставить ready-for-dev или
    // area:* «потому что так сказал процесс», и постановка уходила в работу без
    // человека (issue #63). Оставить роль без права трогать конвейер надёжнее,
    // чем ещё раз попросить его не использовать.
    const mockupTool = define(
      'gh_issue_mockup',
      'Отметить постановку как визуальную: дизайнер подготовит макет до того, как задачу возьмут в работу. Других меток инструмент не ставит.',
      {
        type: 'object',
        properties: {
          number: { type: 'integer', description: 'Номер issue' },
          needed: { type: 'boolean', description: 'true — макет нужен, false — снять пометку' },
        },
        required: ['number', 'needed'],
        additionalProperties: false,
      },
      async (a, p) => {
        const label = p.labels.mockup
        if (a.needed) {
          await api('POST', '/repos/' + p.repo + '/issues/' + a.number + '/labels', { labels: [label] })
        } else {
          try {
            await api('DELETE', '/repos/' + p.repo + '/issues/' + a.number + '/labels/' + encodeURIComponent(label))
          } catch (error) { /* метки могло и не быть */ }
        }
        const after = await api('GET', '/repos/' + p.repo + '/issues/' + a.number)
        return { number: a.number, mockup: a.needed, labels: labelNames(after) }
      },
    )

    const prCreateTool = define(
      'gh_pr_create',
      'Открыть pull request. База — базовая ветка проекта (project_info.base). Заголовок и тело должны ссылаться на issue; мерж PR делает человек, не агент.',
      {
        type: 'object',
        properties: {
          head: { type: 'string', description: 'Ветка с изменениями, например feature/52-unsubscribe' },
          base: { type: 'string', description: 'Целевая ветка; по умолчанию — базовая ветка проекта (project_info.base)' },
          title: { type: 'string', description: 'Заголовок PR' },
          body: { type: 'string', description: 'Описание: что сделано и как проверять' },
          draft: { type: 'boolean', description: 'Открыть как черновик' },
        },
        required: ['head', 'title'],
        additionalProperties: false,
      },
      async (a, p) => prView(await api('POST', '/repos/' + p.repo + '/pulls', {
        head: a.head,
        base: a.base || p.base,
        title: a.title,
        body: a.body || '',
        draft: !!a.draft,
      })),
    )

    const prsTool = define(
      'gh_prs',
      'Список pull request. Фильтр issue ищет PR, относящиеся к issue: по ветке feature/<номер>-… или по ссылке #<номер> в тексте.',
      {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Состояние, по умолчанию open.' },
          head: { type: 'string', description: 'Точная ветка, например feature/52-unsubscribe' },
          issue: { type: 'integer', description: 'Номер issue, к которому относится PR' },
        },
        required: [],
        additionalProperties: false,
      },
      async (a, p) => {
        const state = a.state || 'open'
        const apiPath = '/repos/' + p.repo + '/pulls?state=' + state + '&per_page=100&sort=updated'
        let rows = await api('GET', apiPath)
        if (typeof a.head === 'string' && a.head.trim() !== '') {
          rows = rows.filter((r) => r.head && r.head.ref === a.head.trim())
        }
        if (Number.isInteger(a.issue)) {
          const n = a.issue
          const prefix = 'feature/' + n + '-'
          rows = rows.filter((r) => {
            const branch = (r.head && r.head.ref) || ''
            if (branch === 'feature/' + n || branch.indexOf(prefix) === 0) return true
            const text = (r.body || '') + ' ' + (r.title || '')
            return text.indexOf('#' + n) !== -1
          })
        }
        return rows.map(prView)
      },
    )

    const prTool = define(
      'gh_pr',
      'Детали pull request. С files=true добавляет список изменённых файлов — обычно именно его нужно проверить tester.',
      {
        type: 'object',
        properties: {
          number: { type: 'integer', description: 'Номер PR' },
          files: { type: 'boolean', description: 'Добавить список изменённых файлов' },
        },
        required: ['number'],
        additionalProperties: false,
      },
      async (a, p) => {
        const view = prView(await api('GET', '/repos/' + p.repo + '/pulls/' + a.number))
        if (a.files) {
          const rows = await api('GET', '/repos/' + p.repo + '/pulls/' + a.number + '/files?per_page=100')
          view.files = rows.map((f) => ({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          }))
        }
        return view
      },
    )

    // Метки в этом инструменте намеренно отсутствуют. Аналитик — автор
    // постановки, а не движок конвейера: метку ready-for-dev ставит человек,
    // маршрут area:* — диспетчер. Когда параметр labels был доступен, агент
    // передавал его сам, потому что «данные проекта отдают метки» легко
    // прочитать как разрешение (issue #63 так и ушёл в работу без человека).
    // Убрать параметр надёжнее, чем ещё раз попросить его не использовать.
    const issueCreateTool = define(
      'gh_issue_create',
      'Создать issue проекта: в теле — промт для разработчика и план работы. Метки инструмент не ставит: ready-for-dev ставит человек, маршрут area:* — диспетчер. Нужен макет — отдельный вызов gh_issue_mockup.',
      {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Заголовок issue' },
          body: { type: 'string', description: 'Тело issue (markdown): промт и план работы' },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      async (a, p) => {
        const created = await api('POST', '/repos/' + p.repo + '/issues', { title: a.title, body: a.body })
        return issueView(created)
      },
    )

    // Постановка — живой документ: ревью и разработка возвращаются с вопросами,
    // и правка «в комментарии» оставляет тело issue описывать прежнюю ревизию.
    // Инструмент меняет ТОЛЬКО title и body: меток он по-прежнему не ставит —
    // ready-for-dev остаётся за человеком, маршрут area:* — за диспетчером.
    // Поля передаются ровно те, что пришли: непереданное поле PATCH не трогает.
    const issueEditTool = define(
      'gh_issue_edit',
      'Изменить заголовок и/или тело issue. Меняет только title и body — метки, состояние и назначенных не трогает. Переданное поле заменяет прежнее значение целиком, поэтому сначала прочитай текущее тело через gh_issue, а потом передай его с правкой.',
      {
        type: 'object',
        properties: {
          number: { type: 'integer', description: 'Номер issue' },
          title: { type: 'string', description: 'Новый заголовок issue (не передан — заголовок остаётся прежним)' },
          body: { type: 'string', description: 'Новое тело issue целиком (не передано — тело остаётся прежним)' },
        },
        required: ['number'],
        additionalProperties: false,
      },
      async (a, p) => {
        const patch = {}
        if (typeof a.title === 'string') patch.title = a.title
        if (typeof a.body === 'string') patch.body = a.body
        if (Object.keys(patch).length === 0) {
          throw new Error('передайте title и/или body: пустой вызов тело issue не меняет, а сетевой запрос не нужен')
        }
        const updated = await api('PATCH', '/repos/' + p.repo + '/issues/' + a.number, patch)
        return {
          number: updated && updated.number,
          title: updated && updated.title,
          body: (updated && updated.body) || '',
          url: updated && updated.html_url,
        }
      },
    )
    ctx.effect(() => tools.register(issueTool), 'github:gh_issue')
    ctx.effect(() => tools.register(issueEditTool), 'github:gh_issue_edit')
    ctx.effect(() => tools.register(issueCreateTool), 'github:gh_issue_create')
    ctx.effect(() => tools.register(issuesTool), 'github:gh_issues')
    ctx.effect(() => tools.register(commentTool), 'github:gh_issue_comment')
    ctx.effect(() => tools.register(mockupTool), 'github:gh_issue_mockup')
    ctx.effect(() => tools.register(prCreateTool), 'github:gh_pr_create')
    ctx.effect(() => tools.register(prsTool), 'github:gh_prs')
    ctx.effect(() => tools.register(prTool), 'github:gh_pr')

    const projectInfoTool = define(
      'project_info',
      'Проект этой сессии: репозиторий, базовая ветка, рабочая копия отдела, защищённый клон человека, имя compose-проекта, порты стенда и метки конвейера. Вызывай до любых действий с git, GitHub и docker и используй значения дословно.',
      { type: 'object', properties: {}, required: [], additionalProperties: false },
      async (_a, p) => ({
        id: p.id,
        title: p.title,
        repo: p.repo || null,
        base: p.base,
        workspace: p.workspace,
        humanClone: p.humanClone || null,
        composeProject: p.composeProject,
        artifacts: p.artifacts,
        frontendPort: p.frontendPort,
        apiPort: p.apiPort,
        labels: p.labels,
        resolvedFrom: p.matched ? 'рабочая область сессии' : 'проект по умолчанию (рабочая область не совпала ни с одним проектом)',
        cwd: p.cwd || null,
      }),
    )
    ctx.effect(() => tools.register(projectInfoTool), 'github:project_info')
  },
}
