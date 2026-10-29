/**
 * Клиент API проектов.
 *
 * Путь относительный: страницу отдаёт nginx, он же проксирует `/api/` в сервис `api`.
 * Хост и порт стенда в коде не зашиты — их задаёт окружение compose-проекта, поэтому
 * CORS фронту не нужен.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю дословно. Собственный текст фронта здесь один — «Сервер не отвечает»:
 * он нужен, когда ответа нет вовсе или в теле нет строкового `detail`.
 */

/** Проект в том виде, в каком его отдаёт `GET /api/projects`. */
export type Project = {
  id: number;
  name: string;
  description: string;
  repo_url: string;
  created_at: string;
  updated_at: string;
};

/** Тело создания и правки: `POST` требует `name` и `repo_url`, `PATCH` принимает подмножество. */
export type ProjectInput = {
  name: string;
  description: string;
  repo_url: string;
};

const PROJECTS_URL = '/api/projects';

/**
 * Предел ожидания ответа — как у проверки состояния в `App.tsx`: сервер укладывается
 * в 2 с, поэтому 5 с означает «не ответил», а не «медленно работает».
 */
const REQUEST_TIMEOUT_MS = 5000;

/** Собственный текст фронта для недоступного api. Контрактом бэкенда не является. */
export const UNREACHABLE_TEXT = 'Сервер не отвечает';

/** Отказ запроса с текстом, который можно показать пользователю как есть. */
export class ApiError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Разбор одного проекта: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readProject(payload: unknown): Project | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, name, description, repo_url, created_at, updated_at } = payload;
  if (
    typeof id !== 'number' ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    typeof repo_url !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  return { id, name, description, repo_url, created_at, updated_at };
}

/** Текст отказа из тела ответа; всё, что не строка, — «Сервер не отвечает». */
async function readDetail(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (isRecord(payload)) {
    const { detail } = payload;
    if (typeof detail === 'string' && detail !== '') {
      return detail;
    }
  }
  return UNREACHABLE_TEXT;
}

/** Запрос с общим таймаутом; сетевой сбой и таймаут — это «Сервер не отвечает». */
async function send(path: string, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(UNREACHABLE_TEXT);
  }
}

/** Тело успешного ответа с проектом; неразборчивое тело — не контракт, значит «не отвечает». */
async function readProjectBody(response: Response): Promise<Project> {
  const payload: unknown = await response.json().catch(() => null);
  const project = readProject(payload);
  if (project === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return project;
}

/** `GET /api/projects` — только живые проекты, порядок задаёт сервер (по `id`). */
export async function listProjects(): Promise<Project[]> {
  const response = await send(PROJECTS_URL, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const projects: Project[] = [];
  for (const item of payload) {
    const project = readProject(item);
    if (project === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    projects.push(project);
  }
  return projects;
}

/** `POST /api/projects` — `201` и созданный проект. */
export async function createProject(input: ProjectInput): Promise<Project> {
  const response = await send(PROJECTS_URL, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readProjectBody(response);
}

/** `PATCH /api/projects/{id}` — `200` и обновлённый проект. */
export async function updateProject(id: number, input: ProjectInput): Promise<Project> {
  const response = await send(`${PROJECTS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readProjectBody(response);
}

/** `DELETE /api/projects/{id}` — `204` без тела: мягкое удаление, строка остаётся в базе. */
export async function deleteProject(id: number): Promise<void> {
  const response = await send(`${PROJECTS_URL}/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
}
