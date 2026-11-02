/**
 * Клиент API отделов проекта и справочника ролей.
 *
 * Отдел живёт внутри проекта: список и создание идут вложенным путём
 * `/api/projects/{project_id}/departments`, проект задаётся **путём**, а не телом
 * запроса. Правка и удаление адресуются самому отделу плоским
 * `/api/departments/{department_id}` — плоских `GET` и `POST` больше нет.
 *
 * Справочник ролей читается с сервера и только с сервера: кодов и названий ролей
 * фронт не зашивает — их отдаёт `GET /api/roles`. Время приходит строкой `"ЧЧ:ММ"`
 * без секунд, поэтому подставляется в `<input type="time">` без переформатирования.
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

/** Роль из справочника `GET /api/roles`. */
export type Role = {
  id: number;
  code: string;
  title: string;
};

/** Отдел в том виде, в каком его отдаёт `GET /api/projects/{project_id}/departments`. */
export type Department = {
  id: number;
  /**
   * Проект, в котором заведён отдел. `null` — отдел, созданный до миграции `0005`:
   * в списочных ответах такие строки не встречаются, но тип их допускает, иначе
   * разбор ответа был бы строже контракта.
   */
  project_id: number | null;
  name: string;
  /** Время работы «с» в виде `"ЧЧ:ММ"`, без секунд. */
  start_time: string;
  /** Время работы «по»; меньше `start_time` — переход через полночь, это норма. */
  end_time: string;
  roles: Role[];
  created_at: string;
  updated_at: string;
};

/** Тело создания и правки: `POST` требует все четыре поля, `PATCH` принимает подмножество. */
export type DepartmentInput = {
  name: string;
  start_time: string;
  end_time: string;
  role_ids: number[];
};

const ROLES_URL = '/api/roles';
/** Плоский путь отдела: по нему ходят только `PATCH` и `DELETE`. */
const DEPARTMENTS_URL = '/api/departments';

/** Вложенный путь отделов проекта: проект передаётся путём, а не телом запроса. */
function projectDepartmentsUrl(projectId: number): string {
  return `/api/projects/${projectId}/departments`;
}

/** Разбор роли: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readRole(payload: unknown): Role | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, code, title } = payload;
  if (typeof id !== 'number' || typeof code !== 'string' || typeof title !== 'string') {
    return null;
  }
  return { id, code, title };
}

/** Разбор отдела; роли проверяются по одной, порядок оставляем серверный (по `id`). */
function readDepartment(payload: unknown): Department | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, project_id, name, start_time, end_time, roles, created_at, updated_at } =
    payload;
  if (
    typeof id !== 'number' ||
    (project_id !== null && typeof project_id !== 'number') ||
    typeof name !== 'string' ||
    typeof start_time !== 'string' ||
    typeof end_time !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string' ||
    !Array.isArray(roles)
  ) {
    return null;
  }
  const parsedRoles: Role[] = [];
  for (const item of roles) {
    const role = readRole(item);
    if (role === null) {
      return null;
    }
    parsedRoles.push(role);
  }
  return {
    id,
    project_id,
    name,
    start_time,
    end_time,
    roles: parsedRoles,
    created_at,
    updated_at,
  };
}

/** Тело успешного ответа с отделом; неразборчивое тело — не контракт, значит «не отвечает». */
async function readDepartmentBody(response: Response): Promise<Department> {
  const department = readDepartment(await readJson(response));
  if (department === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return department;
}

/** `GET /api/roles` — справочник ролей, порядок задаёт сервер (по `id`). */
export async function listRoles(): Promise<Role[]> {
  const response = await send(ROLES_URL, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const roles: Role[] = [];
  for (const item of payload) {
    const role = readRole(item);
    if (role === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    roles.push(role);
  }
  return roles;
}

/**
 * `GET /api/projects/{project_id}/departments` — только живые отделы этого проекта,
 * порядок задаёт сервер (по `id`). Несуществующий и мягко удалённый проект — `404`
 * с текстом `Проект не найден`.
 */
export async function listDepartments(projectId: number): Promise<Department[]> {
  const response = await send(projectDepartmentsUrl(projectId), { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const departments: Department[] = [];
  for (const item of payload) {
    const department = readDepartment(item);
    if (department === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    departments.push(department);
  }
  return departments;
}

/**
 * `POST /api/projects/{project_id}/departments` — `201` и созданный отдел; в ответе
 * `project_id` равен id проекта из пути. Тело проекта не содержит.
 */
export async function createDepartment(
  projectId: number,
  input: DepartmentInput,
): Promise<Department> {
  const response = await send(projectDepartmentsUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readDepartmentBody(response);
}

/** `PATCH /api/departments/{id}` — `200` и обновлённый отдел; `role_ids` заменяет набор целиком. */
export async function updateDepartment(
  id: number,
  input: DepartmentInput,
): Promise<Department> {
  const response = await send(`${DEPARTMENTS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readDepartmentBody(response);
}

/** `DELETE /api/departments/{id}` — `204` без тела: мягкое удаление, строка остаётся в базе. */
export async function deleteDepartment(id: number): Promise<void> {
  const response = await send(`${DEPARTMENTS_URL}/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
}
