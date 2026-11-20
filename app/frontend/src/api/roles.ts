/**
 * Клиент раздела «Роли»: справочник ролей и скиллы ролей.
 *
 * Раздел живёт в двух наборах путей, и это контракт, а не удобство фронта: роль читается и
 * создаётся по `/api/roles` (скиллы вложены в роль), а правка и удаление скилла — по id
 * скилла (`/api/skills/{id}`), потому что скилл адресуем сам по себе.
 *
 * **Код неизменяем.** `code` роли — имя каталога пресета DSH, `code` скилла — имя каталога
 * скилла и frontmatter `name`; поэтому `code` задаётся только при создании и в тела правки
 * не попадает вовсе. `PATCH` любого непустого подмножества `{title, description}`
 * (у скилла ещё `sections`) — правка.
 *
 * **Разделы.** `sections` — упорядоченный массив `{"title", "body"}`; порядок массива и есть
 * порядок заголовков `##` в `SKILL.md`, поэтому `PATCH` заменяет массив целиком. Пустой
 * `body` разрешён, пустой `title` — нет.
 *
 * **Удаление мягкое.** `DELETE` отвечает `204` без тела; строка остаётся в базе, из ответов
 * исчезает. Роль, стоящая в живом отделе, не удаляется — `409` с текстом, который фронт
 * показывает дословно.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю как есть, своих формулировок фронт не придумывает.
 *
 * Тип `Role` здесь шире, чем `Role` в `departments.ts`: в отделе от роли приходят только
 * `{id, code, title}`, а справочник раздела отдаёт ещё описание, число скиллов и дату.
 * Это разные ответы одного справочника, а не разные сущности.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

const ROLES_URL = '/api/roles';
const SKILLS_URL = '/api/skills';

/** Роль в ответах `GET/POST /api/roles` и `PATCH /api/roles/{id}`. */
export type Role = {
  id: number;
  /** Слаг: имя каталога пресета DSH. Задаётся при создании и не меняется. */
  code: string;
  title: string;
  /** Пустая строка — описания нет. */
  description: string;
  /** Живых скиллов роли; считает сервер на чтении. */
  skill_count: number;
  updated_at: string;
};

/** Раздел скилла: заголовок `##` и его markdown. */
export type SkillSection = {
  title: string;
  body: string;
};

/** Скилл роли в ответах `GET/POST /api/roles/{id}/skills` и `PATCH /api/skills/{id}`. */
export type Skill = {
  id: number;
  /** Слаг: имя каталога скилла и frontmatter `name`. Задаётся при создании и не меняется. */
  code: string;
  title: string;
  /** Frontmatter `description`: по нему модель решает, когда скилл грузить. */
  description: string;
  /** Разделы в порядке показа: порядок массива и есть порядок `##` в файле. */
  sections: SkillSection[];
  created_at: string;
  updated_at: string;
};

/** Тело `POST /api/roles`. */
export type RoleCreateInput = {
  code: string;
  title: string;
  description: string;
};

/** Тело `PATCH /api/roles/{id}`: кода здесь нет — он не меняется. */
export type RoleUpdateInput = {
  title: string;
  description: string;
};

/** Тело `POST /api/roles/{id}/skills`. */
export type SkillCreateInput = {
  code: string;
  title: string;
  description: string;
  sections: SkillSection[];
};

/** Тело `PATCH /api/skills/{id}`: массив разделов заменяет прежний целиком. */
export type SkillUpdateInput = {
  title: string;
  description: string;
  sections: SkillSection[];
};

/** Необязательная строка: `undefined` — поля нет, `""` — пустое значение. */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Раздел: `title` обязателен, `body` по умолчанию пустой. */
function readSection(payload: unknown): SkillSection | null {
  if (!isRecord(payload) || typeof payload.title !== 'string') {
    return null;
  }
  return { title: payload.title, body: readText(payload.body) ?? '' };
}

/** Массив разделов: любой неразборчивый элемент делает неразборчивым весь массив. */
function readSections(payload: unknown): SkillSection[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const sections: SkillSection[] = [];
  for (const item of payload) {
    const section = readSection(item);
    if (section === null) {
      return null;
    }
    sections.push(section);
  }
  return sections;
}

/** Роль из ответа; `null` — ответ не по контракту и показывать его нечем. */
function readRole(payload: unknown): Role | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, code, title, skill_count: skillCount, updated_at: updatedAt } = payload;
  const description = readText(payload.description);
  if (
    typeof id !== 'number' ||
    typeof code !== 'string' ||
    typeof title !== 'string' ||
    typeof skillCount !== 'number' ||
    typeof updatedAt !== 'string' ||
    description === undefined
  ) {
    return null;
  }
  return { id, code, title, description, skill_count: skillCount, updated_at: updatedAt };
}

/** Массив ролей: пустой массив — легальный ответ «ролей нет». */
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

/** Скилл из ответа. */
function readSkill(payload: unknown): Skill | null {
  if (!isRecord(payload)) {
    return null;
  }
  const {
    id,
    code,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
  } = payload;
  const description = readText(payload.description);
  const sections = readSections(payload.sections);
  if (
    typeof id !== 'number' ||
    typeof code !== 'string' ||
    typeof title !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    description === undefined ||
    sections === null
  ) {
    return null;
  }
  return { id, code, title, description, sections, created_at: createdAt, updated_at: updatedAt };
}

/** Тело успешного ответа с ролью; неразборчивое тело — не контракт, значит «не отвечает». */
async function readRoleBody(response: Response): Promise<Role> {
  const role = readRole(await readJson(response));
  if (role === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return role;
}

/** Тело успешного ответа со скиллом; то же правило. */
async function readSkillBody(response: Response): Promise<Skill> {
  const skill = readSkill(await readJson(response));
  if (skill === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return skill;
}

/** `GET /api/roles` — только живые роли, порядок задаёт сервер (по `id`). */
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
 * `POST /api/roles` — `201` и созданная роль. Занятый код отвечает `409`
 * `Роль с таким кодом уже есть`.
 */
export async function createRole(input: RoleCreateInput): Promise<Role> {
  const response = await send(ROLES_URL, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readRoleBody(response);
}

/**
 * `PATCH /api/roles/{id}` — `200` и обновлённая роль. Пустое тело сервер не принимает
 * (`422 Нет полей для изменения`), поэтому оба поля отправляются всегда.
 */
export async function updateRole(id: number, patch: RoleUpdateInput): Promise<Role> {
  const response = await send(`${ROLES_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readRoleBody(response);
}

/** `DELETE /api/roles/{id}` — `204` без тела: мягкое удаление, строка остаётся в базе. */
export async function deleteRole(id: number): Promise<void> {
  const response = await send(`${ROLES_URL}/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
}

/** `GET /api/roles/{id}/skills` — только живые скиллы роли, порядок по `id`. */
export async function listSkills(roleId: number): Promise<Skill[]> {
  const response = await send(`${ROLES_URL}/${roleId}/skills`, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const skills: Skill[] = [];
  for (const item of payload) {
    const skill = readSkill(item);
    if (skill === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    skills.push(skill);
  }
  return skills;
}

/** `POST /api/roles/{id}/skills` — `201` и созданный скилл. */
export async function createSkill(roleId: number, input: SkillCreateInput): Promise<Skill> {
  const response = await send(`${ROLES_URL}/${roleId}/skills`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readSkillBody(response);
}

/** `PATCH /api/skills/{id}` — `200` и обновлённый скилл; `sections` заменяет массив. */
export async function updateSkill(id: number, patch: SkillUpdateInput): Promise<Skill> {
  const response = await send(`${SKILLS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readSkillBody(response);
}

/** `DELETE /api/skills/{id}` — `204` без тела: мягкое удаление. */
export async function deleteSkill(id: number): Promise<void> {
  const response = await send(`${SKILLS_URL}/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
}
