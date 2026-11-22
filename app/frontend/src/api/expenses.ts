/**
 * Клиент API журнала расходов проекта.
 *
 * Журнал принадлежит проекту, поэтому путь вложен в него: `/api/projects/{id}/expenses`.
 * Общая часть запроса — таймаут, разбор `detail` и собственный текст недоступного api —
 * живёт в `http.ts`; разбор тела повторяет `tasks.ts`: форма ответа проверяется, чтобы
 * экран не падал на мусоре.
 *
 * Сумм фронт не считает и в запросе не передаёт: сервер перемножает количества на цены
 * проекта, округляет до копеек и прибавляет к стоимости проекта. `amount` записи и
 * `total` журнала приходят строками ровно с двумя знаками — на экран они выводятся как
 * `0,41 ₽` и `10,53 ₽`, но не пересчитываются.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

/** Запись журнала в том виде, в каком её отдаёт `GET /api/projects/{id}/expenses`. */
export type Expense = {
  id: number;
  project_id: number;
  /** Календарная дата `ГГГГ-ММ-ДД`: день, за который записаны токены. */
  spent_on: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  /** Снимок суммы на момент записи — строка ровно с двумя знаками. */
  amount: string;
  created_at: string;
};

/** Тело записи: дата и четыре количества, все пять полей обязательны. */
export type ExpenseInput = {
  spent_on: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
};

/**
 * Ответ журнала: итог проекта и его записи.
 *
 * `total` — хранимая стоимость проекта, а не сумма прочитанных строк: она равна сумме
 * уже округлённых сумм, поэтому сходится с `amount` всех записей.
 */
export type ExpenseJournal = {
  total: string;
  items: Expense[];
};

/** Путь журнала одного проекта. Хост и порт не зашиты: `/api/` проксирует nginx. */
function expensesUrl(projectId: number): string {
  return `/api/projects/${projectId}/expenses`;
}

/** Разбор одной записи: форма ответа проверяется, чтобы экран не падал на мусоре. */
function readExpense(payload: unknown): Expense | null {
  if (!isRecord(payload)) {
    return null;
  }
  const {
    id,
    project_id,
    spent_on,
    tokens_input,
    tokens_output,
    tokens_cache_read,
    tokens_cache_write,
    amount,
    created_at,
  } = payload;
  if (
    typeof id !== 'number' ||
    typeof project_id !== 'number' ||
    typeof spent_on !== 'string' ||
    typeof tokens_input !== 'number' ||
    typeof tokens_output !== 'number' ||
    typeof tokens_cache_read !== 'number' ||
    typeof tokens_cache_write !== 'number' ||
    typeof amount !== 'string' ||
    typeof created_at !== 'string'
  ) {
    return null;
  }
  return {
    id,
    project_id,
    spent_on,
    tokens_input,
    tokens_output,
    tokens_cache_read,
    tokens_cache_write,
    amount,
    created_at,
  };
}

/** Тело успешного ответа с записью; неразборчивое тело — не контракт, значит «не отвечает». */
async function readExpenseBody(response: Response): Promise<Expense> {
  const expense = readExpense(await readJson(response));
  if (expense === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return expense;
}

/** `GET /api/projects/{id}/expenses` — итог и записи этого проекта, порядок задаёт сервер. */
export async function listExpenses(projectId: number): Promise<ExpenseJournal> {
  const response = await send(expensesUrl(projectId), { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!isRecord(payload) || typeof payload.total !== 'string' || !Array.isArray(payload.items)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const items: Expense[] = [];
  for (const item of payload.items) {
    const expense = readExpense(item);
    if (expense === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    items.push(expense);
  }
  return { total: payload.total, items };
}

/** `POST /api/projects/{id}/expenses` — `201` и созданная запись. */
export async function createExpense(
  projectId: number,
  input: ExpenseInput,
): Promise<Expense> {
  const response = await send(expensesUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readExpenseBody(response);
}
