/**
 * Клиент детализации одной смены: смена целиком со списком сессий.
 *
 * Список смен у проекта читается не здесь, а в `expenses.ts`: с #72 смены и ручные записи
 * лежат в одном журнале `/api/projects/{id}/expenses`, и второй ручки журнала фронт не
 * держит — иначе две половины одного раздела снова разъехались бы по двум экранам.
 *
 * Расход считает harness, а не веб: закрытая смена приезжает готовым снимком вместе с
 * тарифами. Поэтому `cost_usd` здесь — **строка** с шестью знаками (`"0.420000"`), и
 * фронт её только показывает, ничего не пересчитывая и не складывая: сумма смены — в
 * `cost_usd` строки, сумма сессии — в её собственной `cost_usd`. Сложи фронт эти числа
 * сам — округления разъехались бы с бэкендом, а при смене тарифов прошлые смены сами не
 * пересчитываются: сумму строки меняет только явный пересчёт по кнопке (#88).
 *
 * `404` у `GET /api/usage/shifts/{id}` значит «смены нет»: текст уходит пользователю
 * дословно, как и любой другой `detail`.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю как есть, своих формулировок фронт не придумывает.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

const SHIFTS_URL = '/api/usage/shifts';

/** Токены по видам: те же четыре ключа, что в документе смены и `usageRates`. */
export type UsageTokens = {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Смена в детализации: интервал, причина закрытия и итоги по сессиям. */
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
