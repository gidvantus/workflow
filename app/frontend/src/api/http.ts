/**
 * Общий HTTP-клиент фронта: один таймаут, один разбор отказа, один собственный текст.
 *
 * Путь относительный: страницу отдаёт nginx, он же проксирует `/api/` в сервис `api`.
 * Хост и порт стенда в коде не зашиты — их задаёт окружение compose-проекта, поэтому
 * CORS фронту не нужен.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * пользователю дословно. Собственный текст фронта здесь один — «Сервер не отвечает»:
 * он нужен, когда ответа нет вовсе или в теле нет строкового `detail`.
 */

/**
 * Предел ожидания ответа. Сервер укладывается в 2 с, поэтому 5 с — это уже «не ответил»:
 * иначе остановленный контейнер висел бы до таймаута nginx.
 */
const REQUEST_TIMEOUT_MS = 5000;

/** Собственный текст фронта для недоступного api. Контрактом бэкенда не является. */
export const UNREACHABLE_TEXT = 'Сервер не отвечает';

/** Отказ запроса с текстом, который можно показать пользователю как есть. */
export class ApiError extends Error {}

/** Тело ответа может быть объектом, массивом или мусором — здесь только проверка формы. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Текст отказа из тела ответа; всё, что не непустая строка, — «Сервер не отвечает». */
export async function readDetail(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (isRecord(payload)) {
    const { detail } = payload;
    if (typeof detail === 'string' && detail !== '') {
      return detail;
    }
  }
  return UNREACHABLE_TEXT;
}

/** Запрос с общим таймаутом; сетевой сбой и таймаут — это «Сервер не отвечает». */
export async function send(path: string, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(UNREACHABLE_TEXT);
  }
}

/** Тело успешного ответа как JSON; неразборчивое тело — не контракт, значит «не отвечает». */
export async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}
