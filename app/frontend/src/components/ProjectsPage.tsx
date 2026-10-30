/**
 * Раздел «Проекты»: шапка с крошками, заголовок «Проекты» с кнопкой «Добавить проект»,
 * карточка списка, панель состояния сервиса и диалоги создания, правки и удаления.
 *
 * Когда открыт проект, раздел показывает страницу проекта вместо всего перечисленного:
 * адреса у неё нет, поэтому и «навигация» здесь — это состояние `openProject`.
 *
 * Экран вынесен из `App.tsx` без изменения поведения и текстов: оболочкой (меню, подвал)
 * теперь владеет `App`, а раздел отвечает за своё содержимое и своё состояние — список,
 * открытое окно и ответ `/api/health`.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { deleteProject, listProjects, type Project } from '../api/projects';
import ConfirmDialog from './ConfirmDialog';
import ProjectFormDialog from './ProjectFormDialog';
import ProjectList from './ProjectList';
import ProjectPage from './ProjectPage';

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

type ProjectsPageProps = {
  /**
   * Сколько проектов на экране: бейдж раздела в меню рисует `App`, а список читает этот
   * экран. `null` — список ещё не прочитан или не прочитался.
   */
  onCountChange: (count: number | null) => void;
};

export default function ProjectsPage({ onCountChange }: ProjectsPageProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState<string>(STATUS_UNCHECKED);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [dialog, setDialog] = useState<DialogState>(null);
  /**
   * Открытая страница проекта. Адреса у неё нет: F5 возвращает к списку — это решение
   * постановки. Объект проекта приходит из загруженного списка, отдельной ручки чтения
   * одного проекта нет.
   */
  const [openProject, setOpenProject] = useState<Project | null>(null);

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

  // Бейдж в меню показывает то же число, что и счётчик карточки: ошибка и загрузка
  // числа не дают — бейджа в это время нет.
  useEffect(() => {
    onCountChange(list.status === 'ready' ? list.projects.length : null);
  }, [list, onCountChange]);

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

  // Страница проекта заменяет содержимое раздела целиком: ни шапки со списком, ни
  // панели состояния сервиса под ним на ней нет. Список при этом остаётся в состоянии
  // раздела, поэтому возврат показывает его без повторного запроса.
  if (openProject !== null) {
    return <ProjectPage project={openProject} onBack={() => setOpenProject(null)} />;
  }

  return (
    <>
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
          onOpen={(project) => setOpenProject(project)}
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
        <ConfirmDialog
          testId="project-delete-confirm"
          title="Удалить проект?"
          text={`Проект «${dialog.project.name}» исчезнет из списка. Восстановить его через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteProject(dialog.project.id);
            handleSaved();
          }}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
