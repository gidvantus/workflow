/**
 * Клиент API объединённого журнала расходов проекта.
 *
 * Журнал один на два источника факта (#72). Ручную запись человек вводит формой, смену
 * пишет отдел сам (`POST /api/usage/shifts`), а читаются обе половины одной ручкой:
 * `/api/projects/{id}/expenses`. Строку отличает `kind` — `manual` или `shift`; у смены
 * дополнительно есть интервал, причина закрытия и число сессий, у ручной записи этих
 * ключей нет вовсе (сервер отдаёт ответ с `response_model_exclude_none`).
 *
 * Общая часть запроса — таймаут, разбор `detail` и собственный текст недоступного api —
 * живёт в `http.ts`; разбор тела повторяет `tasks.ts`: форма ответа проверяется, чтобы
 * экран не падал на мусоре.
 *
 * Сумм фронт не считает и в запросе не передаёт. Сервер перемножает четыре количества на
 * четыре цены проекта (`$` за 1 000 000 токенов), округляет до шести знаков и прибавляет к
 * стоимости проекта. `amount` строки и `total` журнала приходят строками ровно с шестью
 * знаками — на экран они выводятся как `119,23 $`, а фронт их не пересчитывает.
 *
 * С #88 строку можно пересчитать и удалить: `recalculateExpense` пересчитывает сумму
 * одной строки по текущим ценам проекта (итог проекта пересобирается сервером), а
 * `deleteExpense` убирает строку из журнала. Оба ответа несут новый `total`, но экран
 * берёт строки и итог из повторного `GET`, а не из ответа мутации.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

/** Четыре количества токенов строки — те же ключи, что у смены и у тела записи. */
export type JournalTokens = {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Половина журнала: смену пишет отдел, ручную запись добавляет человек. */
export type JournalKind = 'manual' | 'shift';

/**
 * Строка журнала в том виде, в каком её отдаёт `GET /api/projects/{id}/expenses`.
 *
 * `id` — id строки в своей таблице, а не сквозной номер ведомости: у ручной записи и у
 * смены свои таблицы, и одинаковые `id` у двух строк разных половин — норма. Ключ
 * списка поэтому склеен из `kind` и `id`.
 */
export type JournalEntry = {
  kind: JournalKind;
  id: number;
  /** Календарная дата `ГГГГ-ММ-ДД`: у ручной записи её назвал человек, у смены это день закрытия. */
  spent_on: string;
  tokens: JournalTokens;
  /** Снимок суммы на момент записи — строка ровно с шестью знаками. */
  amount: string;
  /** Интервал смены; у ручной записи этих полей нет. */
  started_at?: string;
  ended_at?: string;
  /** Причина закрытия смены: `window` или `manual`. */
  reason?: string;
  /** Сколько сессий ролей вошло в сумму смены. */
  sessions_count?: number;
};

/** Тело ручной записи: день и четыре количества. Суммы в теле нет — её считает сервер. */
export type ExpenseInput = {
  spent_on: string;
  tokens: JournalTokens;
};

/**
 * Ответ журнала: итог проекта и обе половины одним списком.
 *
 * `total` — хранимая стоимость проекта (`projects.total_cost`), а не сумма прочитанных
 * строк: её прибавляют обе ручки записи, а пересчёт и удаление пересобирают суммой
 * строк. Поэтому сумма строк на экране сходится с итогом и с паспортом проекта.
 */
export type ExpenseJournal = {
  total: string;
  items: JournalEntry[];
};

/** Ответ пересчёта строки: сама строка в форме журнала и новый итог проекта. */
export type ExpenseRecalculated = {
  item: JournalEntry;
  total: string;
};

/** Ответ удаления строки: только новый итог проекта — строки в журнале уже нет. */
export type ExpenseDeleted = {
  total: string;
};

/** Путь журнала одного проекта. Хост и порт не зашиты: `/api/` проксирует nginx. */
function expensesUrl(projectId: number): string {
  return `/api/projects/${projectId}/expenses`;
}

/** Количество токенов: целое неотрицательное. Не по контракту — ответ не разобран. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Блок количеств строки; любой отсутствующий вид токенов — мусор, а не ноль. */
function readTokens(payload: unknown): JournalTokens | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { in: tokensIn, out, cacheRead, cacheWrite } = payload;
  if (!isCount(tokensIn) || !isCount(out) || !isCount(cacheRead) || !isCount(cacheWrite)) {
    return null;
  }
  return { in: tokensIn, out, cacheRead, cacheWrite };
}

/** Разбор одной строки: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readEntry(payload: unknown): JournalEntry | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { kind, id, spent_on, amount } = payload;
  if (
    (kind !== 'manual' && kind !== 'shift') ||
    typeof id !== 'number' ||
    typeof spent_on !== 'string' ||
    typeof amount !== 'string'
  ) {
    return null;
  }
  const tokens = readTokens(payload.tokens);
  if (tokens === null) {
    return null;
  }
  const entry: JournalEntry = { kind, id, spent_on, tokens, amount };
  if (kind === 'shift') {
    // У смены интервал, причина и число сессий есть всегда: без них строку нельзя ни
    // показать, ни раскрыть, поэтому их отсутствие — не контракт, а мусор в ответе.
    const { started_at, ended_at, reason, sessions_count } = payload;
    if (
      typeof started_at !== 'string' ||
      typeof ended_at !== 'string' ||
      typeof reason !== 'string' ||
      !isCount(sessions_count)
    ) {
      return null;
    }
    entry.started_at = started_at;
    entry.ended_at = ended_at;
    entry.reason = reason;
    entry.sessions_count = sessions_count;
  }
  return entry;
}

/** Тело успешного ответа со строкой; неразборчивое тело — не контракт, значит «не отвечает». */
async function readEntryBody(response: Response): Promise<JournalEntry> {
  const entry = readEntry(await readJson(response));
  if (entry === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return entry;
}

/** `GET /api/projects/{id}/expenses` — итог и обе половины журнала, порядок задаёт сервер. */
export async function listExpenses(projectId: number): Promise<ExpenseJournal> {
  const response = await send(expensesUrl(projectId), { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!isRecord(payload) || typeof payload.total !== 'string' || !Array.isArray(payload.items)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const items: JournalEntry[] = [];
  for (const item of payload.items) {
    const entry = readEntry(item);
    if (entry === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    items.push(entry);
  }
  return { total: payload.total, items };
}

/** `POST /api/projects/{id}/expenses` — `201` и созданная ручная запись. */
export async function createExpense(
  projectId: number,
  input: ExpenseInput,
): Promise<JournalEntry> {
  const response = await send(expensesUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readEntryBody(response);
}

/** Путь одной строки журнала: `kind` — `manual` или `shift`, `id` — id в своей таблице. */
function expenseRowUrl(projectId: number, kind: JournalKind, id: number): string {
  return `${expensesUrl(projectId)}/${kind}/${id}`;
}

/**
 * `POST .../expenses/{kind}/{id}/recalculate` — `200` с пересчитанной строкой и итогом.
 *
 * Тело запроса пустое: суммы и цен в нём нет, сервер берёт количества строки и текущие
 * цены проекта. Отказ приходит текстом в `detail` (цены не заполнены, сумма сверх
 * предела журнала) и показывается пользователю дословно.
 */
export async function recalculateExpense(
  projectId: number,
  kind: JournalKind,
  id: number,
): Promise<ExpenseRecalculated> {
  const response = await send(`${expenseRowUrl(projectId, kind, id)}/recalculate`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!isRecord(payload) || typeof payload.total !== 'string') {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const item = readEntry(payload.item);
  if (item === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return { item, total: payload.total };
}

/**
 * `DELETE .../expenses/{kind}/{id}` — `200` с новым итогом проекта.
 *
 * У смены сервер удаляет сначала её сессии, потом саму смену; восстановить строку через
 * интерфейс нельзя. Экран после успеха перечитывает журнал целиком (`listExpenses`), а
 * не правит строки и итог сам.
 */
export async function deleteExpense(
  projectId: number,
  kind: JournalKind,
  id: number,
): Promise<ExpenseDeleted> {
  const response = await send(expenseRowUrl(projectId, kind, id), { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!isRecord(payload) || typeof payload.total !== 'string') {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return { total: payload.total };
}
