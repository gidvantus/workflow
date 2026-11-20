/**
 * Клиент API отделов проекта, справочников видов и ролей.
 *
 * Отдел живёт внутри проекта: список и создание идут вложенным путём
 * `/api/projects/{project_id}/departments`, проект задаётся **путём**, а не телом
 * запроса. Правка и удаление адресуются самому отделу плоским
 * `/api/departments/{department_id}` — плоских `GET` и `POST` больше нет.
 *
 * Создание выбирает только вид: `POST` принимает `{kind_id}` и ничего больше, имя отдела
 * становится названием вида. Остальные поля страницы правки приезжают пустыми и
 * заполняются `PATCH`-ем.
 *
 * `fields` — какие блоки рисует страница правки и в каком порядке. Это часть контракта,
 * а не константа фронта: подписи и контролы живут здесь, но состав и порядок задаёт вид.
 * Поэтому же справочник видов читается с сервера, как и справочник ролей.
 *
 * Время приходит строкой `"ЧЧ:ММ"` без секунд и уходит обратно так же, поэтому
 * подставляется в `<input type="time">` без переформатирования. Время работы — набор
 * окон `windows`: пустой массив значит «расписания нет», а порядок окон (по возрастанию
 * начала) задаёт сервер — фронт массив не сортирует и время не переформатирует.
 * `""` в строковых полях значит «не заполнено».
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

/** Вид отдела в том виде, в каком он приходит объектом `kind` внутри отдела. */
export type DepartmentKindRef = {
  id: number;
  code: string;
  title: string;
};

/** Вид отдела из справочника `GET /api/department-kinds`. */
export type DepartmentKind = DepartmentKindRef & {
  /**
   * Ключи блоков страницы правки в порядке показа. Незнакомый ключ (третий вид,
   * заведённый новой ревизией) фронт не рисует и экран не роняет.
   */
  fields: string[];
};

/**
 * Окно времени работы: `{"start_time": "ЧЧ:ММ", "end_time": "ЧЧ:ММ"}`.
 *
 * Вторых ключей у элемента колонки `windows` нет, а `end_time` меньше `start_time` —
 * штатный переход через полночь, а не ошибка: окно идёт до конца суток и продолжается
 * с нуля.
 */
export type DepartmentWindow = {
  start_time: string;
  end_time: string;
};

/** Отдел в том виде, в каком его отдают ручки списка, создания и правки. */
export type Department = {
  id: number;
  /**
   * Проект, в котором заведён отдел. `null` — отдел, созданный до миграции `0005`:
   * в списочных ответах такие строки не встречаются, но тип их допускает, иначе
   * разбор ответа был бы строже контракта.
   */
  project_id: number | null;
  /** Имя отдела: на момент создания равно названию вида, отдельно не редактируется. */
  name: string;
  kind: DepartmentKindRef;
  /** Набор блоков страницы правки — тот же, что у вида отдела. */
  fields: string[];
  /**
   * Окна времени работы в серверном порядке (по возрастанию начала). Пустой массив —
   * расписания нет: так приезжает только что созданный отдел и отделы видов без
   * расписания в наборе полей.
   */
  windows: DepartmentWindow[];
  roles: Role[];
  /** Восемь строковых полей страницы правки: `null` — не заполнено. */
  repo_path: string | null;
  base_branch: string | null;
  workspace: string | null;
  human_workspace: string | null;
  artifacts_dir: string | null;
  compose_project: string | null;
  telegram_token: string | null;
  telegram_chat_id: string | null;
  /** Лимит возврата задачи: `0` — «возвращать нельзя», умолчание — `3`. */
  max_rework: number;
  notifications_enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Тело `PATCH /api/departments/{id}`: любое непустое подмножество отрисованных полей.
 * `name` здесь нет — имя не редактируется, `kind` — вид у существующего отдела не меняется.
 *
 * `max_rework` объявлен объединением, потому что поле на экране — текст: страница отправляет
 * строку цифр, а сервер приводит её к `int` (ограничение `0..99` — его, и отказ приходит его
 * текстом). Число контрактом тоже допустимо, поэтому оно остаётся в типе.
 */
export type DepartmentPatch = {
  /** Набор окон целиком: сервер заменяет его, а не дополняет. Пустой список — отказ. */
  windows?: DepartmentWindow[];
  role_ids?: number[];
  repo_path?: string | null;
  base_branch?: string | null;
  workspace?: string | null;
  human_workspace?: string | null;
  artifacts_dir?: string | null;
  compose_project?: string | null;
  telegram_token?: string | null;
  telegram_chat_id?: string | null;
  max_rework?: number | string | null;
  notifications_enabled?: boolean | null;
};

const ROLES_URL = '/api/roles';
const KINDS_URL = '/api/department-kinds';
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

/** Разбор вида: объект `kind` внутри отдела и строка справочника устроены одинаково. */
function readKindRef(payload: unknown): DepartmentKindRef | null {
  return readRole(payload);
}

/** Набор ролей: порядок оставляем серверный (по `id`), мусор в любом элементе — отказ. */
function readRoles(payload: unknown): Role[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const roles: Role[] = [];
  for (const item of payload) {
    const role = readRole(item);
    if (role === null) {
      return null;
    }
    roles.push(role);
  }
  return roles;
}

/**
 * Строковое поле, которое может быть незаполненным: `null` остаётся `null`, строка —
 * строкой, всё остальное (включая отсутствующий ключ) — `undefined`, то есть «не по
 * контракту». Так одно правило проверяет и время, и восемь строк страницы правки.
 */
function readOptionalText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

/** Набор ключей полей: строки в серверном порядке, неизвестные ключи не отбрасываются. */
function readFields(payload: unknown): string[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const fields: string[] = [];
  for (const item of payload) {
    if (typeof item !== 'string') {
      return null;
    }
    fields.push(item);
  }
  return fields;
}

/**
 * Окно времени работы: ровно две строки. Время не проверяется на формат — его формат
 * принадлежит контракту сервера, и переписывать его на фронте нельзя; отказ разбора тут
 * только на форме ответа (не объект, второй ключ вместо пары, число вместо строки).
 */
function readWindow(payload: unknown): DepartmentWindow | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { start_time, end_time } = payload;
  if (typeof start_time !== 'string' || typeof end_time !== 'string') {
    return null;
  }
  return { start_time, end_time };
}

/**
 * Набор окон. Порядок остаётся серверный — сортировки здесь нет; пустой массив допустим
 * («расписания нет»), а мусор в любом элементе — отказ разбора всего ответа.
 */
function readWindows(payload: unknown): DepartmentWindow[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const windows: DepartmentWindow[] = [];
  for (const item of payload) {
    const window = readWindow(item);
    if (window === null) {
      return null;
    }
    windows.push(window);
  }
  return windows;
}

/**
 * Разбор отдела. Строковые поля страницы правки проверяются одним правилом: строка или
 * `null`, поэтому список полей растёт без правки разбора.
 */
function readDepartment(payload: unknown): Department | null {
  if (!isRecord(payload)) {
    return null;
  }
  const {
    id,
    project_id,
    name,
    kind,
    fields,
    windows,
    roles,
    created_at,
    updated_at,
  } = payload;

  const maxRework = payload.max_rework;
  const notificationsEnabled = payload.notifications_enabled;
  const repoPath = readOptionalText(payload.repo_path);
  const baseBranch = readOptionalText(payload.base_branch);
  const workspace = readOptionalText(payload.workspace);
  const humanWorkspace = readOptionalText(payload.human_workspace);
  const artifactsDir = readOptionalText(payload.artifacts_dir);
  const composeProject = readOptionalText(payload.compose_project);
  const telegramToken = readOptionalText(payload.telegram_token);
  const telegramChatId = readOptionalText(payload.telegram_chat_id);

  if (
    typeof id !== 'number' ||
    (project_id !== null && typeof project_id !== 'number') ||
    typeof name !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string' ||
    typeof maxRework !== 'number' ||
    typeof notificationsEnabled !== 'boolean' ||
    repoPath === undefined ||
    baseBranch === undefined ||
    workspace === undefined ||
    humanWorkspace === undefined ||
    artifactsDir === undefined ||
    composeProject === undefined ||
    telegramToken === undefined ||
    telegramChatId === undefined
  ) {
    return null;
  }

  const parsedKind = readKindRef(kind);
  const parsedFields = readFields(fields);
  const parsedRoles = readRoles(roles);
  const parsedWindows = readWindows(windows);
  if (
    parsedKind === null ||
    parsedFields === null ||
    parsedRoles === null ||
    parsedWindows === null
  ) {
    return null;
  }

  return {
    id,
    project_id,
    name,
    kind: parsedKind,
    fields: parsedFields,
    windows: parsedWindows,
    roles: parsedRoles,
    repo_path: repoPath,
    base_branch: baseBranch,
    workspace,
    human_workspace: humanWorkspace,
    artifacts_dir: artifactsDir,
    compose_project: composeProject,
    telegram_token: telegramToken,
    telegram_chat_id: telegramChatId,
    max_rework: maxRework,
    notifications_enabled: notificationsEnabled,
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
  const roles = readRoles(await readJson(response));
  if (roles === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return roles;
}

/**
 * `GET /api/department-kinds` — справочник видов, порядок задаёт сервер (по `id`).
 * Справочник только читается: новый вид — новая ревизия, а не ручка.
 */
export async function listDepartmentKinds(): Promise<DepartmentKind[]> {
  const response = await send(KINDS_URL, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const kinds: DepartmentKind[] = [];
  for (const item of payload) {
    const kind = readKindRef(item);
    const fields = isRecord(item) ? readFields(item.fields) : null;
    if (kind === null || fields === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    kinds.push({ ...kind, fields });
  }
  return kinds;
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
 * `POST /api/projects/{project_id}/departments` — `201` и созданный отдел; тело — только
 * `kind_id`. `project_id` в ответе равен id проекта из пути, второго отдела того же вида
 * в проекте быть не может: имя занято, сервер отвечает `409`.
 */
export async function createDepartment(
  projectId: number,
  kindId: number,
): Promise<Department> {
  const response = await send(projectDepartmentsUrl(projectId), {
    method: 'POST',
    body: JSON.stringify({ kind_id: kindId } satisfies { kind_id: number }),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readDepartmentBody(response);
}

/**
 * `PATCH /api/departments/{id}` — `200` и обновлённый отдел; `role_ids` и `windows`
 * заменяют набор целиком.
 */
export async function updateDepartment(
  id: number,
  patch: DepartmentPatch,
): Promise<Department> {
  const response = await send(`${DEPARTMENTS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
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
