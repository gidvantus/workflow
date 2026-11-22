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
  /**
   * Стабильный код проекта — он же `id` проекта в документе реестра отдела.
   * `null` — код не задан, и в реестре проект живёт под числовым `id`.
   */
  code: string | null;
  /**
   * Четыре цены за токены — рубли за 1 000 000 токенов, строкой с шестью знаками
   * (`"0.270000"`). Ноль — «не тарифицируется». На экран цена выводится без хвостовых
   * нулей (`0,27`), но считается только на сервере.
   */
  price_input: string;
  price_output: string;
  price_cache_read: string;
  price_cache_write: string;
  created_at: string;
  updated_at: string;
};

/**
 * Тело создания и правки: `POST` требует `name` и `repo_url`, `PATCH` принимает
 * подмножество. `code` необязателен: `undefined` значит «не трогать» — так правка
 * не отправляет код, который задан и по контракту не меняется.
 *
 * Цен здесь нет: у них своё окно на вкладке «Расходы» и свой запрос
 * (`updateProjectPrices`). Форма проекта деньгами не занимается, а `PATCH` с ценами
 * мимо окна цен был бы вторым способом менять те же четыре поля.
 */
export type ProjectInput = {
  name: string;
  description: string;
  repo_url: string;
  code?: string | null;
};

/** Четыре цены за 1 млн токенов: тело окна «Цены за токены» и `PATCH` только с ними. */
export type ProjectPrices = {
  price_input: string;
  price_output: string;
  price_cache_read: string;
  price_cache_write: string;
};

const PROJECTS_URL = '/api/projects';

/** Разбор одного проекта: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readProject(payload: unknown): Project | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, name, description, repo_url, created_at, updated_at } = payload;
  // Ответ без `code` — старый сервер или усечённое тело: это «код не задан», а не
  // мусор, иначе экран целиком упал бы в «api не отвечает».
  const code = payload.code === undefined ? null : payload.code;
  const {
    price_input: priceInput,
    price_output: priceOutput,
    price_cache_read: priceCacheRead,
    price_cache_write: priceCacheWrite,
  } = payload;
  if (
    typeof id !== 'number' ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    typeof repo_url !== 'string' ||
    (code !== null && typeof code !== 'string') ||
    typeof priceInput !== 'string' ||
    typeof priceOutput !== 'string' ||
    typeof priceCacheRead !== 'string' ||
    typeof priceCacheWrite !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  return {
    id,
    name,
    description,
    repo_url,
    code,
    price_input: priceInput,
    price_output: priceOutput,
    price_cache_read: priceCacheRead,
    price_cache_write: priceCacheWrite,
    created_at,
    updated_at,
  };
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

/**
 * `PATCH /api/projects/{id}` с одними ценами — `200` и обновлённый проект.
 *
 * Тело — ровно четыре цены: остальные поля проекта окно цен не трогает, а `PATCH`
 * меняет только присланное. Записанные суммы журнала от смены цен не пересчитываются —
 * это правило сервера, фронт его только повторяет подсказкой в окне.
 */
export async function updateProjectPrices(
  id: number,
  prices: ProjectPrices,
): Promise<Project> {
  const response = await send(`${PROJECTS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(prices),
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
