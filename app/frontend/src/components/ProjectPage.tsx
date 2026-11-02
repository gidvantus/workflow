/**
 * Страница проекта: крошки, кнопка «← К проектам», паспорт проекта, полоса подразделов
 * с двумя вкладками — «Задачи» и «Отделы» — и карточка выбранного подраздела под ней.
 *
 * Адреса у страницы нет: это состояние раздела «Проекты», а не маршрут. Поэтому объект
 * проекта приходит со списка, а ручки чтения одного проекта (`GET /api/projects/{id}`)
 * в приложении нет. Если проект успели удалить в другой вкладке, отделам это покажет
 * вложенный `GET` текстом `404 «Проект не найден»` в карточке отделов, а задачам —
 * создание задачи тем же текстом.
 *
 * Панели «Состояние сервиса» здесь нет: она живёт на экране «Проектов». Формы правки и
 * удаления проекта на странице тоже нет — это действия списка.
 *
 * Вкладка «Отделы» — единственный вход в отделы: отдельного пункта меню и отдельного
 * экрана больше нет. Оба списка читаются при открытии страницы, показывается только
 * выбранный; переключение вкладки запросов не повторяет. Создание, правка и удаление
 * отдела — диалоги этой страницы: после сохранения список отделов перечитывается,
 * оптимистичных обновлений нет.
 */

import { useCallback, useEffect, useId, useState } from 'react';

import { deleteDepartment, listDepartments, type Department } from '../api/departments';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import type { Project } from '../api/projects';
import { listTasks, type Task } from '../api/tasks';
import ConfirmDialog from './ConfirmDialog';
import DepartmentFormDialog from './DepartmentFormDialog';
import DepartmentList from './DepartmentList';
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

/** Открытая вкладка подразделов. */
type Tab = 'tasks' | 'departments';

/** Состояние списка задач: загрузка, готовые данные или ошибка загрузки. */
type TasksState =
  | { status: 'loading' }
  | { status: 'ready'; tasks: Task[] }
  | { status: 'error'; errorText: string };

/** Состояние списка отделов: загрузка, готовые данные или ошибка загрузки. */
type DepartmentsState =
  | { status: 'loading' }
  | { status: 'ready'; departments: Department[] }
  | { status: 'error'; errorText: string };

/** Открытое окно отдела: форма создания, форма правки или подтверждение удаления. */
type DepartmentDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; department: Department }
  | { kind: 'delete'; department: Department }
  | null;

type ProjectPageProps = {
  project: Project;
  /** Возврат к списку: страница закрывается, загруженный список не перечитывается. */
  onBack: () => void;
};

export default function ProjectPage({ project, onBack }: ProjectPageProps): JSX.Element {
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<Tab>('tasks');
  const [tasks, setTasks] = useState<TasksState>({ status: 'loading' });
  const [departments, setDepartments] = useState<DepartmentsState>({ status: 'loading' });
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState>(null);

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

  /** Список отделов тоже всегда с сервера: после правки и удаления он перечитывается. */
  const loadDepartments = useCallback(async (): Promise<void> => {
    setDepartments({ status: 'loading' });
    try {
      const loaded = await listDepartments(project.id);
      setDepartments({ status: 'ready', departments: loaded });
    } catch (error) {
      setDepartments({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, [project.id]);

  // Оба списка читаются при открытии страницы, а не при первом заходе на вкладку:
  // иначе «Отделы» показывали бы «Загрузка…» после каждого переключения.
  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  /** Сохранение в форме задачи прошло — окно закрыто, список задач перечитан. */
  function handleTaskSaved(): void {
    setTaskFormOpen(false);
    void loadTasks();
  }

  /** Сохранение или удаление отдела прошло — окно закрыто, список отделов перечитан. */
  function handleDepartmentSaved(): void {
    setDepartmentDialog(null);
    void loadDepartments();
  }

  const tasksPanelId = `${tabsId}-panel-tasks`;
  const departmentsPanelId = `${tabsId}-panel-departments`;

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

        {/* Полоса подразделов: две вкладки одного уровня, у выбранной `aria-selected`.
            Подписи без счётчиков и пилюль — это переключатель содержимого, а не
            украшение шапки. */}
        <div className="tabs" role="tablist" aria-label="Подразделы проекта">
          <button
            className="tab"
            type="button"
            role="tab"
            id={`${tabsId}-tasks`}
            aria-selected={activeTab === 'tasks'}
            aria-controls={tasksPanelId}
            data-testid="project-tab-tasks"
            onClick={() => setActiveTab('tasks')}
          >
            Задачи
          </button>
          <button
            className="tab"
            type="button"
            role="tab"
            id={`${tabsId}-departments`}
            aria-selected={activeTab === 'departments'}
            aria-controls={departmentsPanelId}
            data-testid="project-tab-departments"
            onClick={() => setActiveTab('departments')}
          >
            Отделы
          </button>
        </div>

        {activeTab === 'tasks' && (
          <div role="tabpanel" id={tasksPanelId} aria-labelledby={`${tabsId}-tasks`}>
            <TaskList
              tasks={tasks.status === 'ready' ? tasks.tasks : []}
              loading={tasks.status === 'loading'}
              errorText={tasks.status === 'error' ? tasks.errorText : null}
              onRetry={() => void loadTasks()}
              onCreate={() => setTaskFormOpen(true)}
            />
          </div>
        )}

        {activeTab === 'departments' && (
          <div role="tabpanel" id={departmentsPanelId} aria-labelledby={`${tabsId}-departments`}>
            <DepartmentList
              departments={departments.status === 'ready' ? departments.departments : []}
              loading={departments.status === 'loading'}
              errorText={departments.status === 'error' ? departments.errorText : null}
              onRetry={() => void loadDepartments()}
              onCreate={() => setDepartmentDialog({ kind: 'create' })}
              onEdit={(department) => setDepartmentDialog({ kind: 'edit', department })}
              onDelete={(department) => setDepartmentDialog({ kind: 'delete', department })}
            />
          </div>
        )}
      </main>

      {taskFormOpen && (
        <TaskFormDialog
          projectId={project.id}
          onClose={() => setTaskFormOpen(false)}
          onSaved={handleTaskSaved}
        />
      )}

      {departmentDialog !== null && departmentDialog.kind === 'create' && (
        <DepartmentFormDialog
          mode="create"
          projectId={project.id}
          onClose={() => setDepartmentDialog(null)}
          onSaved={handleDepartmentSaved}
        />
      )}
      {departmentDialog !== null && departmentDialog.kind === 'edit' && (
        <DepartmentFormDialog
          mode="edit"
          projectId={project.id}
          department={departmentDialog.department}
          onClose={() => setDepartmentDialog(null)}
          onSaved={handleDepartmentSaved}
        />
      )}
      {departmentDialog !== null && departmentDialog.kind === 'delete' && (
        <ConfirmDialog
          testId="department-delete-confirm"
          title="Удалить отдел?"
          text={`Отдел «${departmentDialog.department.name}» исчезнет из списка. Восстановить его через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteDepartment(departmentDialog.department.id);
            handleDepartmentSaved();
          }}
          onClose={() => setDepartmentDialog(null)}
        />
      )}
    </>
  );
}
