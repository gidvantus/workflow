/**
 * Клиент API задач проекта.
 *
 * Задача принадлежит проекту, поэтому путь вложен в него: `/api/projects/{id}/tasks`.
 * Общая часть запроса — таймаут, разбор `detail` и собственный текст недоступного api —
 * живёт в `http.ts`; разбор тела ответа повторяет `projects.ts`: форма проверяется,
 * чтобы экран не падал на мусоре.
 *
 * Текст отказа показывается пользователю дословно: сервер присылает его в `detail`.
 *
 * Стоимость — деньги в рублях с копейками, и фронт их не считает: сервер отдаёт строку
 * ровно с двумя знаками (`"1250.00"`) или `null`, если стоимость не указана. На экран
 * строка выводится как `1 250,00 ₽`, в запрос уходит строкой с точкой, а `null` остаётся
 * `null` — не `0` и не `""`, иначе «бесплатно» и «неизвестно» стали бы неразличимы.
 */

import {
  ApiError,
  UNREACHABLE_TEXT,
  isRecord,
  readDetail,
  readJson,
  send,
} from './http';

/** Задача в том виде, в каком её отдаёт `GET /api/projects/{id}/tasks`. */
export type Task = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  /** Строка ровно с двумя знаками после точки или `null` — «стоимость не указана». */
  cost: string | null;
  created_at: string;
  updated_at: string;
};

/** Тело создания задачи: обязателен только `name`, `cost` может быть «не указана». */
export type TaskInput = {
  name: string;
  description: string;
  cost: string | null;
};

/** Путь задач одного проекта. Хост и порт не зашиты: `/api/` проксирует nginx. */
function tasksUrl(projectId: number): string {
  return `/api/projects/${projectId}/tasks`;
}

/** Разбор одной задачи: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readTask(payload: unknown): Task | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, project_id, name, description, cost, created_at, updated_at } = payload;
  if (
    typeof id !== 'number' ||
    typeof project_id !== 'number' ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  // `null` — контракт («не указана»); строка — указанная стоимость. Всё остальное
  // (число от постороннего клиента, объект) контрактом не является.
  if (cost !== null && typeof cost !== 'string') {
    return null;
  }
  return { id, project_id, name, description, cost, created_at, updated_at };
}

/** Тело успешного ответа с задачей; неразборчивое тело — не контракт, значит «не отвечает». */
async function readTaskBody(response: Response): Promise<Task> {
  const task = readTask(await readJson(response));
  if (task === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return task;
}

/** `GET /api/projects/{id}/tasks` — задачи только этого проекта, порядок задаёт сервер. */
export async function listTasks(projectId: number): Promise<Task[]> {
  const response = await send(tasksUrl(projectId), { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const tasks: Task[] = [];
  for (const item of payload) {
    const task = readTask(item);
    if (task === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    tasks.push(task);
  }
  return tasks;
}

/** `POST /api/projects/{id}/tasks` — `201` и созданная задача. */
export async function createTask(projectId: number, input: TaskInput): Promise<Task> {
  const response = await send(tasksUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readTaskBody(response);
}
