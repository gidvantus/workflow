/**
 * Клиент процесса отдела: таблица переходов, по которой диспетчер исполняет конвейер.
 *
 * Процесс — документ (`version`, 14 имён меток, ступени), а не набор полей отдела: его
 * читают и сохраняют **целиком** парой `GET`/`PUT /api/departments/{id}/process`.
 * `PUT` принимает документ как тело запроса, а не `{document: …}`: половины сохранённой
 * таблицы не бывает, поэтому «частичного» сохранения у ручки нет.
 *
 * `GET` отдаёт три вещи, и все три нужны экрану: `document` (`null` — своего процесса у
 * отдела нет, диспетчер исполняет `defaults`), `defaults` — документ по умолчанию сразу,
 * чтобы кнопка «Сбросить к умолчанию» работала без второго запроса, `roles` и `guards` —
 * справочники для выпадающих списков. Своей копии каталога стражей фронт не держит.
 *
 * Ступень ссылается на **ключи** меток (`dev`, `review`, …), а не на имена: имена живут в
 * `labels` документа, и переименование метки не трогает ступени. `priority` — порядок,
 * целое 1..999; шаг между соседними ступенями умолчаний — 60, чтобы новую вставлять между
 * любыми двумя без перенумерации.
 *
 * Тексты отказов пишет сервер (`422`), фронт показывает их дословно: список текстов —
 * часть контракта, переписывать их на клиенте нельзя.
 */

import { ApiError, isRecord, readDetail, readJson, send } from './http';

/** Ключ метки: 14 штук, все значения `labels` — строки. */
export type ProcessLabelKey =
  | 'dev'
  | 'frontend'
  | 'areaBackend'
  | 'areaFrontend'
  | 'areaFullstack'
  | 'phaseFrontend'
  | 'mockup'
  | 'mockupsReady'
  | 'progress'
  | 'review'
  | 'test'
  | 'ok'
  | 'failed'
  | 'merged';

/** Ключи меток в порядке показа: тот же порядок, что в документе по умолчанию. */
export const PROCESS_LABEL_KEYS: ProcessLabelKey[] = [
  'dev',
  'frontend',
  'areaBackend',
  'areaFrontend',
  'areaFullstack',
  'phaseFrontend',
  'mockup',
  'mockupsReady',
  'progress',
  'review',
  'test',
  'ok',
  'failed',
  'merged',
];

/** Вид ступени: `session` — сессия роли, `route` — страж без сессии, `auto` — только метки. */
export type ProcessStepKind = 'session' | 'route' | 'auto';

/**
 * Роль ступени: `null` — без роли (`route`, `auto`), код роли из `roles` — конкретная
 * сессия, `by-area` и `by-findings` — резолверы кода (половина маршрута и владелец
 * замечаний), их выбирает диспетчер, а не документ.
 */
export type ProcessStepRole = null | string;

/** Ступень таблицы переходов. */
export type ProcessStep = {
  /** Уникальный id ступени: по нему экран рисует строки и подписывает отказы. */
  id: string;
  title: string;
  kind: ProcessStepKind;
  role: ProcessStepRole;
  /** Входящие метки: все должны стоять (не пусто — у ступени без входа нет смысла). */
  when: ProcessLabelKey[];
  /** Исключающие метки: ни одной не должно стоять. */
  unless: ProcessLabelKey[];
  /** Что ступень ставит. */
  put: ProcessLabelKey[];
  /** Что ступень снимает. */
  drop: ProcessLabelKey[];
  /** Id стража из `guards` или `null`: стражей пишет код, документ только выбирает. */
  guard: string | null;
  /** Порядок исполнения: целое 1..999. */
  priority: number;
  /** Выключенная ступень пропускается и в конвейере не участвует. */
  enabled: boolean;
};

/** Документ процесса: то, что лежит в колонке отдела и уходит в `PUT` целиком. */
export type ProcessDocument = {
  version: number;
  labels: Record<ProcessLabelKey, string>;
  steps: ProcessStep[];
};

/** Страж из каталога `guards`: id и подпись для выпадающего списка. */
export type ProcessGuard = {
  id: string;
  title: string;
};

/** Ответ `GET /api/departments/{id}/process`. */
export type ProcessResponse = {
  /** `null` — своего процесса у отдела нет, диспетчер исполняет `defaults`. */
  document: ProcessDocument | null;
  /** Документ по умолчанию: по нему заполняется «Сбросить к умолчанию». */
  defaults: ProcessDocument;
  /** Коды ролей из справочника: из них выбирается `role` ступени. */
  roles: string[];
  /** Каталог стражей: подписи приходят с сервера, своей копии фронт не держит. */
  guards: ProcessGuard[];
};

/** Ответ `PUT /api/departments/{id}/process`: номер ревизии реестра и сохранённый документ. */
export type ProcessSaveResponse = {
  revision: number;
  document: ProcessDocument;
};

const DEPARTMENTS_URL = '/api/departments';

function readSteps(value: unknown): ProcessStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((step) => ({
    id: String(step.id ?? ''),
    title: String(step.title ?? ''),
    kind: (step.kind === 'route' || step.kind === 'auto' ? step.kind : 'session') as ProcessStepKind,
    role: step.role === null || step.role === undefined ? null : String(step.role),
    when: readLabelKeys(step.when),
    unless: readLabelKeys(step.unless),
    put: readLabelKeys(step.put),
    drop: readLabelKeys(step.drop),
    guard: step.guard === null || step.guard === undefined ? null : String(step.guard),
    priority: typeof step.priority === 'number' ? step.priority : 0,
    enabled: step.enabled !== false,
  }));
}

function readLabelKeys(value: unknown): ProcessLabelKey[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((key): key is ProcessLabelKey =>
    PROCESS_LABEL_KEYS.includes(key as ProcessLabelKey),
  );
}

function readDocument(value: unknown): ProcessDocument | null {
  if (!isRecord(value) || !isRecord(value.labels) || !Array.isArray(value.steps)) {
    return null;
  }
  const labels = {} as Record<ProcessLabelKey, string>;
  for (const key of PROCESS_LABEL_KEYS) {
    const name = value.labels[key];
    labels[key] = typeof name === 'string' ? name : '';
  }
  return {
    version: typeof value.version === 'number' ? value.version : 1,
    labels,
    steps: readSteps(value.steps),
  };
}

function readGuards(value: unknown): ProcessGuard[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((guard) => ({
    id: String(guard.id ?? ''),
    title: String(guard.title ?? ''),
  }));
}

function readProcessBody(value: unknown): ProcessResponse {
  const body = isRecord(value) ? value : {};
  const defaults = readDocument(body.defaults);
  return {
    document: readDocument(body.document),
    // Без умолчаний экран нечего сбрасывать: пустой документ честнее выдуманного.
    defaults: defaults ?? { version: 1, labels: {} as Record<ProcessLabelKey, string>, steps: [] },
    roles: Array.isArray(body.roles) ? body.roles.filter((role): role is string => typeof role === 'string') : [],
    guards: readGuards(body.guards),
  };
}

/** `GET /api/departments/{id}/process` — сохранённый документ, умолчания, роли, стражи. */
export async function getProcess(departmentId: number): Promise<ProcessResponse> {
  const response = await send(`${DEPARTMENTS_URL}/${departmentId}/process`, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readProcessBody(await readJson(response));
}

/** `PUT /api/departments/{id}/process` — сохранить документ целиком. */
export async function saveProcess(
  departmentId: number,
  document: ProcessDocument,
): Promise<ProcessSaveResponse> {
  const response = await send(`${DEPARTMENTS_URL}/${departmentId}/process`, {
    method: 'PUT',
    body: JSON.stringify(document),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const body = await readJson(response);
  const saved = isRecord(body) ? readDocument(body.document) : null;
  return {
    revision: isRecord(body) && typeof body.revision === 'number' ? body.revision : 0,
    document: saved ?? document,
  };
}
