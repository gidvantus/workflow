/**
 * Клиент журнала расхода смен: суммы проекта и детализация одной смены.
 *
 * Расход считает harness, а не веб: закрытая смена приезжает готовым снимком вместе с
 * тарифами. Поэтому `cost_usd` здесь — **строка** с шестью знаками (`"0.420000"`), и
 * фронт её только показывает, ничего не пересчитывая и не складывая: сумма проекта
 * приходит в `totals.cost_usd`, сумма смены — в `cost_usd` строки, сумма сессии — в её
 * собственной `cost_usd`. Сложи фронт эти числа сам — округления разъехались бы с
 * бэкендом, а при смене тарифов прошлые смены пересчитались бы задним числом.
 *
 * `project_ref` — id проекта из реестра отдела, а не `projects.id` базы: журнал живёт
 * отдельно от справочника, внешнего ключа нет. Ручка `rebuild` собирает документ реестра
 * как `project.code or str(project.id)` (`app/api/registry.py`), поэтому страница проекта
 * подставляет сюда `project.code ?? String(project.id)` — ту же пару, что попадает в
 * документ реестра.
 *
 * Два `404` в этом разделе значат разное, и клиент различает их сам:
 * `GET /api/projects/{ref}/usage` отвечает `404 «Проект не найден»`, когда у проекта ещё
 * нет ни одной смены, — это пустой журнал, а не отказ: `loadProjectUsage` возвращает
 * `null`. У `GET /api/usage/shifts/{id}` `404` значит «смены нет»: текст уходит
 * пользователю дословно, как и любой другой `detail`.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю как есть, своих формулировок фронт не придумывает.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

const PROJECTS_URL = '/api/projects';
const SHIFTS_URL = '/api/usage/shifts';

/** Токены по видам: те же четыре ключа, что в документе смены и `usageRates`. */
export type UsageTokens = {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Смена в списке журнала: интервал, причина закрытия и итоги по сессиям. */
export type UsageShift = {
  id: number;
  /** Метка смены (дата и время начала окна) — ключ идемпотентности, не для чтения. */
  shift_key: string;
  started_at: string;
  ended_at: string;
  /** `window` — закрылось окно смены, `manual` — человек позвал сводку. */
  reason: string;
  sessions_count: number;
  tokens: UsageTokens;
  /** Деньги строкой с шестью знаками; фронт округляет только для показа. */
  cost_usd: string;
};

/** Итоги проекта по журналу: смены, сессии, токены и деньги. */
export type UsageTotals = {
  shifts: number;
  sessions: number;
  tokens: UsageTokens;
  cost_usd: string;
};

/** `GET /api/projects/{project_ref}/usage`: итог проекта и его смены от новых к старым. */
export type ProjectUsage = {
  project_ref: string;
  project_title: string;
  totals: UsageTotals;
  shifts: UsageShift[];
};

/** Сессия роли внутри смены: тикет (может быть пустым), ходы, токены и цена. */
export type UsageSession = {
  role: string;
  session: string;
  /** Источник запуска сессии; `null` — не указан. */
  source: string | null;
  issue_number: number | null;
  issue_title: string | null;
  turns: number;
  tokens: UsageTokens;
  cost_usd: string;
};

/** `GET /api/usage/shifts/{shift_id}`: смена целиком с детализацией по сессиям. */
export type UsageShiftDetail = UsageShift & {
  project_ref: string;
  project_title: string;
  sessions: UsageSession[];
};

/** Счётчик: целое неотрицательное число. Не по контракту — ответ не разобран. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Строка-деньги: форма проверяется на бэкенде, фронт требует только строку. */
function isMoney(value: unknown): value is string {
  return typeof value === 'string';
}

/** Необязательная строка ответа: `null` и отсутствие поля — одно и то же. */
function readNullableText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Номер тикета сессии: число, `null` или отсутствие поля — всё это «тикет есть/нет».
 *
 * Текстовым разбором число гонять нельзя: `readNullableText` вернул бы на числе
 * `undefined`, и настоящая тикетная сессия (`issue_number: 57`) браковала бы весь ответ
 * детализации — экран показывал бы «Сервер не отвечает» вместо списка сессий. Поэтому
 * число проверяется числом, а `undefined` значит «поле не по контракту».
 */
function readIssueNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return isCount(value) ? value : undefined;
}

/** Токены из ответа; `null` — форма не по контракту. */
function readTokens(payload: unknown): UsageTokens | null {
  if (!isRecord(payload)) {
    return null;
  }
  const input = payload.in;
  const output = payload.out;
  const cacheRead = payload.cacheRead;
  const cacheWrite = payload.cacheWrite;
  if (!isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite)) {
    return null;
  }
  return { in: input, out: output, cacheRead, cacheWrite };
}

/** Итоги из ответа; `null` — форма не по контракту. */
function readTotals(payload: unknown): UsageTotals | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { shifts, sessions } = payload;
  const tokens = readTokens(payload.tokens);
  const cost = payload.cost_usd;
  if (!isCount(shifts) || !isCount(sessions) || tokens === null || !isMoney(cost)) {
    return null;
  }
  return { shifts, sessions, tokens, cost_usd: cost };
}

/** Строка смены из ответа; `null` — форма не по контракту. */
function readShift(payload: unknown): UsageShift | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, shift_key, started_at, ended_at, reason, sessions_count } = payload;
  const tokens = readTokens(payload.tokens);
  const cost = payload.cost_usd;
  if (
    !isCount(id) ||
    typeof shift_key !== 'string' ||
    typeof started_at !== 'string' ||
    typeof ended_at !== 'string' ||
    typeof reason !== 'string' ||
    !isCount(sessions_count) ||
    tokens === null ||
    !isMoney(cost)
  ) {
    return null;
  }
  return {
    id,
    shift_key,
    started_at,
    ended_at,
    reason,
    sessions_count,
    tokens,
    cost_usd: cost,
  };
}

/** Сессия смены из ответа; `null` — форма не по контракту. */
function readSession(payload: unknown): UsageSession | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { role, session, turns } = payload;
  const source = readNullableText(payload.source);
  const issueTitle = readNullableText(payload.issue_title);
  const issueNumber = readIssueNumber(payload.issue_number);
  const tokens = readTokens(payload.tokens);
  const cost = payload.cost_usd;
  if (
    typeof role !== 'string' ||
    typeof session !== 'string' ||
    !isCount(turns) ||
    tokens === null ||
    !isMoney(cost) ||
    source === undefined ||
    issueTitle === undefined ||
    issueNumber === undefined
  ) {
    return null;
  }
  return {
    role,
    session,
    source,
    issue_number: issueNumber,
    issue_title: issueTitle,
    turns,
    tokens,
    cost_usd: cost,
  };
}

/** Ответ `GET /api/projects/{ref}/usage`; `null` — форма не по контракту. */
function readProjectUsage(payload: unknown): ProjectUsage | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { project_ref, project_title } = payload;
  const totals = readTotals(payload.totals);
  if (typeof project_ref !== 'string' || typeof project_title !== 'string' || totals === null) {
    return null;
  }
  const rows = payload.shifts;
  if (!Array.isArray(rows)) {
    return null;
  }
  const shifts: UsageShift[] = [];
  for (const row of rows) {
    const shift = readShift(row);
    if (shift === null) {
      return null;
    }
    shifts.push(shift);
  }
  return { project_ref, project_title, totals, shifts };
}

/** Ответ `GET /api/usage/shifts/{id}`; `null` — форма не по контракту. */
function readShiftDetail(payload: unknown): UsageShiftDetail | null {
  const shift = readShift(payload);
  if (shift === null || !isRecord(payload)) {
    return null;
  }
  const { project_ref, project_title } = payload;
  if (typeof project_ref !== 'string' || typeof project_title !== 'string') {
    return null;
  }
  const rows = payload.sessions;
  if (!Array.isArray(rows)) {
    return null;
  }
  const sessions: UsageSession[] = [];
  for (const row of rows) {
    const session = readSession(row);
    if (session === null) {
      return null;
    }
    sessions.push(session);
  }
  return { ...shift, project_ref, project_title, sessions };
}

/**
 * `GET /api/projects/{project_ref}/usage` — журнал проекта, смены от новых к старым.
 *
 * `404` здесь не ошибка: у проекта ещё нет ни одной смены, и экран показывает пустое
 * состояние. Остальные отказы — исключение с текстом из `detail`.
 */
export async function loadProjectUsage(projectRef: string): Promise<ProjectUsage | null> {
  const response = await send(`${PROJECTS_URL}/${encodeURIComponent(projectRef)}/usage`, {
    method: 'GET',
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const usage = readProjectUsage(await readJson(response));
  if (usage === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return usage;
}

/** `GET /api/usage/shifts/{shift_id}` — смена с сессиями; `404` даёт «Смена не найдена». */
export async function loadShiftDetail(shiftId: number): Promise<UsageShiftDetail> {
  const response = await send(`${SHIFTS_URL}/${shiftId}`, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const shift = readShiftDetail(await readJson(response));
  if (shift === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return shift;
}
