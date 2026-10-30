/**
 * Страница проекта: крошки, кнопка «← К проектам», паспорт проекта, полоса подразделов
 * с одной вкладкой «Задачи» и карточка задач под ней.
 *
 * Адреса у страницы нет: это состояние раздела «Проекты», а не маршрут. Поэтому объект
 * проекта приходит со списка, а ручки чтения одного проекта (`GET /api/projects/{id}`)
 * в приложении нет. Если проект успели удалить в другой вкладке, это вылезет только при
 * создании задачи текстом `404` — так и задумано.
 *
 * Панели «Состояние сервиса» здесь нет: она живёт на экране «Проектов». Формы правки и
 * удаления проекта на странице тоже нет — это действия списка.
 *
 * Задачи читаются с сервера: загрузка, готовый список и ошибка загрузки. После создания
 * список перечитывается, оптимистичных обновлений нет.
 */

import { useCallback, useEffect, useId, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import type { Project } from '../api/projects';
import { listTasks, type Task } from '../api/tasks';
import TaskFormDialog from './TaskFormDialog';
import TaskList from './TaskList';

const MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

/**
 * Дата обновления в виде «28 окт 2026». Тот же разбор, что в `ProjectList` и
 * `DepartmentList`: свой список месяцев, чтобы не зависеть от ICU, и ровно тот вид,
 * что в списке проектов, — постановка требует одинаковый.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** Состояние списка задач: загрузка, готовые данные или ошибка загрузки. */
type TasksState =
  | { status: 'loading' }
  | { status: 'ready'; tasks: Task[] }
  | { status: 'error'; errorText: string };

type ProjectPageProps = {
  project: Project;
  /** Возврат к списку: страница закрывается, загруженный список не перечитывается. */
  onBack: () => void;
};

export default function ProjectPage({ project, onBack }: ProjectPageProps): JSX.Element {
  const tabsId = useId();
  const [tasks, setTasks] = useState<TasksState>({ status: 'loading' });
  const [formOpen, setFormOpen] = useState(false);

  /** Список задач всегда читается с сервера: после создания экран его перечитывает. */
  const loadTasks = useCallback(async (): Promise<void> => {
    setTasks({ status: 'loading' });
    try {
      const loaded = await listTasks(project.id);
      setTasks({ status: 'ready', tasks: loaded });
    } catch (error) {
      setTasks({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, [project.id]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  /** Сохранение в форме прошло — окно закрыто, список перечитан с сервера. */
  function handleSaved(): void {
    setFormOpen(false);
    void loadTasks();
  }

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          Проекты
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">{project.name}</span>
        </p>
        <button className="btn" type="button" data-testid="project-back" onClick={onBack}>
          ← К проектам
        </button>
      </header>

      <main className="content" data-testid="project-page">
        <div className="page-head">
          <div className="project-head">
            <h1 className="page-head__title" data-testid="project-title">
              {project.name}
            </h1>
            <p className="project-head__desc">{project.description}</p>
            <p className="project-head__meta">
              <span className="project-repo" title={project.repo_url}>
                {project.repo_url}
              </span>
              <span className="crumbs__sep" aria-hidden="true">
                ·
              </span>
              <span>{`Обновлён ${formatDate(project.updated_at)}`}</span>
            </p>
          </div>
        </div>

        {/* Подраздел открыт один и всегда активен: переключателя подразделов в задаче
            нет, полоса говорит «здесь начинается содержимое проекта». */}
        <div className="tabs" role="tablist" aria-label="Подразделы проекта">
          <button
            className="tab"
            type="button"
            role="tab"
            id={`${tabsId}-tasks`}
            aria-selected="true"
            data-testid="project-tab-tasks"
          >
            Задачи
          </button>
        </div>

        <TaskList
          tasks={tasks.status === 'ready' ? tasks.tasks : []}
          loading={tasks.status === 'loading'}
          errorText={tasks.status === 'error' ? tasks.errorText : null}
          onRetry={() => void loadTasks()}
          onCreate={() => setFormOpen(true)}
        />
      </main>

      {formOpen && (
        <TaskFormDialog
          projectId={project.id}
          onClose={() => setFormOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
