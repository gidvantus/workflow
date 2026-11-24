/**
 * Клиент процесса отдела: таблица переходов, по которой диспетчер исполняет конвейер.
 *
 * Процесс — документ (`version`, 14 тегов, ступени), а не набор полей отдела: его
 * читают и сохраняют **целиком** парой `GET`/`PUT /api/departments/{id}/process`.
 * `PUT` принимает документ как тело запроса, а не `{document: …}`: половины сохранённой
 * таблицы не бывает, поэтому «частичного» сохранения у ручки нет.
 *
 * `GET` отдаёт три вещи, и все три нужны экрану: `document` (`null` — своего процесса у
 * отдела нет, диспетчер исполняет `defaults`), `defaults` — документ по умолчанию сразу,
 * чтобы кнопка «Сбросить к умолчанию» работала без второго запроса, `roles` и `guards` —
 * справочники для выпадающих списков. Своей копии каталога стражей фронт не держит.
 * Агенты для выбора на теге приходят отдельной ручкой `GET /api/agents`.
 *
 * **Версия документа.** Сервер пишет версию 2 (`tags` вместо `labels`), но стенд может
 * хранить версию 1. `readDocument` нормализует обе в памяти: тег версии 1 получает
 * `title = key` и `agent = null`. Сохранение всегда отправляет версию 2.
 *
 * Ступень ссылается на **ключи** тегов (`dev`, `review`, …), а не на имена: имена, подписи
 * и агенты живут в `tags` документа, и переименование тега не трогает ступени. `priority` —
 * порядок, целое 1..999; шаг между соседними ступенями умолчаний — 60, чтобы новую
 * вставлять между любыми двумя без перенумерации.
 *
 * Тексты отказов пишет сервер (`422`), фронт показывает их дословно: список текстов —
 * часть контракта, переписывать их на клиенте нельзя.
 */

import { ApiError, isRecord, readDetail, readJson, send } from './http';

/** Ключ тега: 14 штук, все значения тегов ссылаются на них. */
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

/** Тег проекта: имя метки на GitHub, подпись для глаза и ответственный агент. */
export type ProcessTag = {
  key: ProcessLabelKey;
  /** Метка на GitHub (`for-code-review`); переименование не трогает ступени. */
  name: string;
  /** Подпись для глаза («На код-ревью»); приходит с сервера, своей копии у фронта нет. */
  title: string;
  /** Код живого агента или `null` — «ступень берёт диспетчер». */
  agent: string | null;
};

/** Документ процесса: то, что лежит в колонке отдела и уходит в `PUT` целиком. */
export type ProcessDocument = {
  version: number;
  tags: ProcessTag[];
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

/** Имя тега на GitHub из документа; пустая строка — тега нет. */
export function tagNameOf(document: ProcessDocument, key: ProcessLabelKey): string {
  return document.tags.find((tag) => tag.key === key)?.name ?? '';
}

/** Подпись тега для глаза из документа; ключ — запасной вариант. */
export function tagTitleOf(document: ProcessDocument, key: ProcessLabelKey): string {
  const title = document.tags.find((tag) => tag.key === key)?.title ?? '';
  return title === '' ? key : title;
}

/** Тег документа по ключу: нужен экранам, которые рисуют агента рядом с подписью. */
export function tagOf(document: ProcessDocument, key: ProcessLabelKey): ProcessTag | undefined {
  return document.tags.find((tag) => tag.key === key);
}

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

/** Теги версии 2; недостающий ключ заполняется пустым тегом, чтобы строки не пропали. */
function readTags(value: unknown): ProcessTag[] {
  const byKey = new Map<ProcessLabelKey, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const key = item.key;
      if (PROCESS_LABEL_KEYS.includes(key as ProcessLabelKey)) {
        byKey.set(key as ProcessLabelKey, item);
      }
    }
  }
  return PROCESS_LABEL_KEYS.map((key) => {
    const tag = byKey.get(key);
    return {
      key,
      name: typeof tag?.name === 'string' ? tag.name : '',
      title: typeof tag?.title === 'string' && tag.title !== '' ? tag.title : key,
      agent: typeof tag?.agent === 'string' && tag.agent !== '' ? tag.agent : null,
    };
  });
}

/** Теги версии 1: `labels` объектом; подпись — ключ, агент — диспетчер. */
function readLegacyTags(value: Record<string, unknown>): ProcessTag[] {
  return PROCESS_LABEL_KEYS.map((key) => ({
    key,
    name: typeof value[key] === 'string' ? (value[key] as string) : '',
    title: key,
    agent: null,
  }));
}

function readDocument(value: unknown): ProcessDocument | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return null;
  }
  let tags: ProcessTag[] | null = null;
  if (Array.isArray(value.tags)) {
    tags = readTags(value.tags);
  } else if (isRecord(value.labels)) {
    tags = readLegacyTags(value.labels);
  }
  if (tags === null) {
    return null;
  }
  return {
    // Фронт всегда пишет версию 2: старый документ нормализуется в памяти при чтении.
    version: 2,
    tags,
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
    defaults: defaults ?? { version: 2, tags: [], steps: [] },
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
