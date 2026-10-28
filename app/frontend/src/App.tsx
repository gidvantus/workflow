import { useState } from 'react';

/**
 * Ручка живости сервиса и базы.
 *
 * Адрес относительный: страницу отдаёт nginx, он же проксирует `/api/` в сервис `api`.
 * Хост и порт стенда в коде не зашиты — они задаются окружением compose-проекта.
 */
const HEALTH_URL = '/api/health';

/** Собственный текст фронта для недоступного api. Контрактом бэкенда не является. */
const UNREACHABLE_TEXT = 'Сервер не отвечает';

/**
 * Предел ожидания ответа. Проверка базы на бэкенде укладывается в 2 с, поэтому 5 с —
 * это уже «не ответил»: иначе остановленный контейнер висел бы до таймаута nginx.
 */
const REQUEST_TIMEOUT_MS = 5000;

const STATUS_UNCHECKED = 'не проверено';
const STATUS_LOADING = 'Проверяю…';

/** Ответ `/api/health`. Формы 200 и 503 отличаются только наличием `message`. */
type Health = {
  status: string;
  db: string;
  version: string;
  message?: string;
};

type Phase = 'idle' | 'loading' | 'done';

/** Тело ответа могло не дойти или оказаться не JSON — тогда читать нечего. */
function readHealth(payload: unknown): Health | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.status !== 'string' || typeof body.db !== 'string') {
    return null;
  }
  const health: Health = {
    status: body.status,
    db: body.db,
    version: typeof body.version === 'string' ? body.version : '',
  };
  if (typeof body.message === 'string') {
    health.message = body.message;
  }
  return health;
}

/** Строка состояния из ответа: для 200 — `API: ok · БД: ok`, для 503 — `API: degraded · БД: fail`. */
function statusLine(health: Health): string {
  return `API: ${health.status} · БД: ${health.db}`;
}

export default function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState<string>(STATUS_UNCHECKED);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleCheck(): Promise<void> {
    setPhase('loading');
    setErrorText(null);
    try {
      const response = await fetch(HEALTH_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload: unknown = await response.json().catch(() => null);
      const health = readHealth(payload);

      if (response.ok && health !== null && health.status === 'ok') {
        setStatusText(statusLine(health));
        setPhase('done');
        return;
      }

      // 503 — это контракт, а не сбой: показываем `message` дословно, своих формулировок не добавляем.
      setStatusText(health !== null ? statusLine(health) : STATUS_UNCHECKED);
      setErrorText(health?.message ?? UNREACHABLE_TEXT);
      setPhase('done');
    } catch {
      // api не отвечает (сеть, остановленный контейнер, прокси) — это случай фронта.
      setStatusText(STATUS_UNCHECKED);
      setErrorText(UNREACHABLE_TEXT);
      setPhase('done');
    }
  }

  const isLoading = phase === 'loading';

  return (
    <main className="app">
      <h1 className="app__title">APP</h1>

      <p className="app__status" data-testid="app-status" aria-live="polite">
        {statusText}
      </p>

      <button
        className="app__check"
        type="button"
        data-testid="app-check"
        onClick={() => void handleCheck()}
        disabled={isLoading}
      >
        {isLoading ? STATUS_LOADING : 'Проверить'}
      </button>

      {errorText !== null && (
        <p className="app__error" data-testid="app-error" role="alert">
          {errorText}
        </p>
      )}
    </main>
  );
}
