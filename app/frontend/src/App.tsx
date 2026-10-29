import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  UNREACHABLE_TEXT,
  listProjects,
  type Project,
} from './api/projects';
import ConfirmDialog from './components/ConfirmDialog';
import ProjectFormDialog from './components/ProjectFormDialog';
import ProjectList from './components/ProjectList';

/**
 * Ручка живости сервиса и базы.
 *
 * Адрес относительный: страницу отдаёт nginx, он же проксирует `/api/` в сервис `api`.
 * Хост и порт стенда в коде не зашиты — они задаются окружением compose-проекта.
 */
const HEALTH_URL = '/api/health';

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

/** Состояние списка: загрузка, готовые данные или ошибка загрузки. */
type ListState =
  | { status: 'loading' }
  | { status: 'ready'; projects: Project[] }
  | { status: 'error'; errorText: string };

/** Открытое окно: форма создания, форма правки или подтверждение удаления. */
type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; project: Project }
  | { kind: 'delete'; project: Project }
  | null;

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
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [dialog, setDialog] = useState<DialogState>(null);

  /**
   * Список всегда читается с сервера: после создания, правки и удаления экран
   * перечитывает его, а не правит своё состояние на веру.
   */
  const loadProjects = useCallback(async (): Promise<void> => {
    setList({ status: 'loading' });
    try {
      const projects = await listProjects();
      setList({ status: 'ready', projects });
    } catch (error) {
      setList({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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

  function closeDialog(): void {
    setDialog(null);
  }

  /** Сохранение в форме прошло — окно закрыто, список перечитан с сервера. */
  function handleSaved(): void {
    setDialog(null);
    void loadProjects();
  }

  const isLoading = phase === 'loading';
  const projectCount = list.status === 'ready' ? list.projects.length : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <path d="M2.5 5.5 8 2.5l5.5 3L8 8.5z" />
              <path d="M2.5 8.5 8 11.5l5.5-3" />
            </svg>
          </span>
          <span>
            <p className="brand__name">Workflow</p>
            <p className="brand__sub">Отдел разработки</p>
          </span>
        </div>

        <nav className="nav" aria-label="Разделы">
          <p className="nav__label">Разделы</p>
          <a className="nav__item" href="#" aria-current="page">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3l1.5 1.5h4A1.5 1.5 0 0 1 13.5 7v4.5A1.5 1.5 0 0 1 12 13H3.5A1.5 1.5 0 0 1 2 11.5z" />
            </svg>
            Проекты
            {projectCount !== null && <span className="nav__count">{projectCount}</span>}
          </a>
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <p className="crumbs">
            Приложение
            <span className="crumbs__sep" aria-hidden="true">
              /
            </span>
            <span className="crumbs__current">Проекты</span>
          </p>
        </header>

        <main className="content">
          <div className="page-head">
            <div>
              <h1 className="page-head__title">Проекты</h1>
              <p className="page-head__sub">Все проекты отдела</p>
            </div>
            <button
              className="btn btn--dark"
              type="button"
              data-testid="project-create"
              onClick={() => setDialog({ kind: 'create' })}
            >
              Добавить проект
            </button>
          </div>

          <ProjectList
            projects={list.status === 'ready' ? list.projects : []}
            loading={list.status === 'loading'}
            errorText={list.status === 'error' ? list.errorText : null}
            onRetry={() => void loadProjects()}
            onEdit={(project) => setDialog({ kind: 'edit', project })}
            onDelete={(project) => setDialog({ kind: 'delete', project })}
          />

          <section className="service" aria-labelledby="service-label">
            <div>
              <p className="service__label" id="service-label">
                Состояние сервиса
              </p>
              <p className="service__line">
                <span className="status__dot" aria-hidden="true" />
                <span className="status__text" data-testid="app-status" aria-live="polite">
                  {statusText}
                </span>
              </p>
              {errorText !== null && (
                <p className="error service__error" data-testid="app-error" role="alert">
                  {errorText}
                </p>
              )}
            </div>
            <button
              className="btn"
              type="button"
              data-testid="app-check"
              onClick={() => void handleCheck()}
              disabled={isLoading}
            >
              {isLoading ? STATUS_LOADING : 'Проверить'}
            </button>
          </section>
        </main>

        <footer className="footbar">
          <p className="footbar__note">© 2026 Workflow</p>
        </footer>
      </div>

      {dialog !== null && dialog.kind === 'create' && (
        <ProjectFormDialog mode="create" onClose={closeDialog} onSaved={handleSaved} />
      )}
      {dialog !== null && dialog.kind === 'edit' && (
        <ProjectFormDialog
          mode="edit"
          project={dialog.project}
          onClose={closeDialog}
          onSaved={handleSaved}
        />
      )}
      {dialog !== null && dialog.kind === 'delete' && (
        <ConfirmDialog project={dialog.project} onClose={closeDialog} onDeleted={handleSaved} />
      )}
    </div>
  );
}
