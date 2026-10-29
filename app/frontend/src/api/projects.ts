/**
 * Клиент API проектов.
 *
 * Общая часть запроса — таймаут, разбор `detail` и собственный текст недоступного api —
 * живёт в `http.ts`: раздела два, и расходиться в мелочах они не должны.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю дословно.
 */

import {
  ApiError,
  UNREACHABLE_TEXT,
  isRecord,
  readDetail,
  readJson,
  send,
} from './http';

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

/** Тело успешного ответа с проектом; неразборчивое тело — не контракт, значит «не отвечает». */
async function readProjectBody(response: Response): Promise<Project> {
  const project = readProject(await readJson(response));
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
  const payload = await readJson(response);
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
