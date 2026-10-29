/**
 * Клиент API раздела «Отделы» и справочника ролей.
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

/** Отдел в том виде, в каком его отдаёт `GET /api/departments`. */
export type Department = {
  id: number;
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
const DEPARTMENTS_URL = '/api/departments';

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
  const { id, name, start_time, end_time, roles, created_at, updated_at } = payload;
  if (
    typeof id !== 'number' ||
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

/** `GET /api/departments` — только живые отделы, порядок задаёт сервер (по `id`). */
export async function listDepartments(): Promise<Department[]> {
  const response = await send(DEPARTMENTS_URL, { method: 'GET' });
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

/** `POST /api/departments` — `201` и созданный отдел. */
export async function createDepartment(input: DepartmentInput): Promise<Department> {
  const response = await send(DEPARTMENTS_URL, {
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
