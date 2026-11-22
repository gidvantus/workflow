/**
 * Страница проекта: крошки, кнопка «← К проектам», паспорт проекта, полоса подразделов
 * с тремя вкладками — «Задачи», «Отделы» и «Расходы» — и карточка выбранного подраздела
 * под ней.
 *
 * Адреса у страницы нет: это состояние раздела «Проекты», а не маршрут. Поэтому объект
 * проекта приходит со списка, а ручки чтения одного проекта (`GET /api/projects/{id}`)
 * в приложении нет. Если проект успели удалить в другой вкладке, отделам это покажет
 * вложенный `GET` текстом `404 «Проект не найден»` в карточке отделов, задачам —
 * создание задачи тем же текстом, журналу расходов — чтение журнала.
 *
 * Панели «Состояние сервиса» здесь нет: она живёт на экране «Проектов». Формы правки и
 * удаления проекта на странице тоже нет — это действия списка.
 *
 * Вкладка «Отделы» — единственный вход в отделы: отдельного пункта меню и отдельного
 * экрана больше нет. Вкладка «Расходы» — единственное место, где видны и правятся деньги:
 * цены за токены, журнал записей и итог проекта. Оба списка и журнал читаются при
 * открытии страницы, показывается только выбранный; переключение вкладки запросов не
 * повторяет. Создание и удаление отдела — диалоги этой страницы, правка — отдельная
 * страница (`DepartmentPage`): полей у отдела десять плюс уведомления, в окно они не
 * влезают. После сохранения список отделов перечитывается, оптимистичных обновлений нет.
 *
 * Цены проекта приходят вместе с объектом проекта, а правятся своим окном с этой вкладки;
 * ответ `PATCH` и есть новый проект, поэтому страница берёт из него и паспорт, и цены.
 */

import { useCallback, useEffect, useId, useState } from 'react';

import { deleteDepartment, listDepartments, type Department } from '../api/departments';
import { listExpenses, type Expense } from '../api/expenses';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import type { Project } from '../api/projects';
import { listTasks, type Task } from '../api/tasks';
import { formatMoney } from '../format';
import ConfirmDialog from './ConfirmDialog';
import DepartmentCreateDialog from './DepartmentCreateDialog';
import DepartmentList from './DepartmentList';
import DepartmentPage from './DepartmentPage';
import ExpenseFormDialog from './ExpenseFormDialog';
import ExpenseList from './ExpenseList';
import ProjectPricesDialog from './ProjectPricesDialog';
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
type Tab = 'tasks' | 'departments' | 'expenses';

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

/**
 * Состояние журнала расходов: загрузка, записи с итогом проекта или ошибка загрузки.
 *
 * `total` — хранимая стоимость проекта из ответа сервера; она же показывается в паспорте,
 * поэтому лежит здесь, а не в карточке журнала.
 */
type ExpensesState =
  | { status: 'loading' }
  | { status: 'ready'; expenses: Expense[]; total: string }
  | { status: 'error'; errorText: string };

/**
 * Открытое окно отдела: создание выбором вида или подтверждение удаления. Правка окном
 * не открывается — она живёт отдельной страницей (`editor`).
 */
type DepartmentDialogState =
  | { kind: 'create' }
  | { kind: 'delete'; department: Department }
  | null;

type ProjectPageProps = {
  project: Project;
  /** Возврат к списку: страница закрывается, загруженный список не перечитывается. */
  onBack: () => void;
};

export default function ProjectPage({
  project: initialProject,
  onBack,
}: ProjectPageProps): JSX.Element {
  const tabsId = useId();
  /**
   * Проект страницы. Копия пришедшего со списка объекта, а не он сам: ответ `PATCH` цен
   * — это новый проект, и паспорт с ценами должны взять его, не перечитывая список.
   */
  const [project, setProject] = useState<Project>(initialProject);
  const [activeTab, setActiveTab] = useState<Tab>('tasks');
  const [tasks, setTasks] = useState<TasksState>({ status: 'loading' });
  const [departments, setDepartments] = useState<DepartmentsState>({ status: 'loading' });
  const [expenses, setExpenses] = useState<ExpensesState>({ status: 'loading' });
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [pricesOpen, setPricesOpen] = useState(false);
  const [departmentDialog, setDepartmentDialog] = useState<DepartmentDialogState>(null);
  /**
   * Открытая страница правки отдела. Как и страница проекта, она занимает содержимое
   * раздела целиком: крошки, шапка и вкладки проекта ей не нужны.
   */
  const [editor, setEditor] = useState<Department | null>(null);

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

  /** Журнал расходов тоже всегда с сервера: после записи он перечитывается вместе с итогом. */
  const loadExpenses = useCallback(async (): Promise<void> => {
    setExpenses({ status: 'loading' });
    try {
      const journal = await listExpenses(project.id);
      setExpenses({ status: 'ready', expenses: journal.items, total: journal.total });
    } catch (error) {
      setExpenses({
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

  // Журнал читается так же, при открытии страницы: итог нужен паспорту, а не только
  // самой вкладке, — иначе «Расходы» появлялись бы в паспорте с задержкой на переход.
  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses]);

  /** Сохранение в форме задачи прошло — окно закрыто, список задач перечитан. */
  function handleTaskSaved(): void {
    setTaskFormOpen(false);
    void loadTasks();
  }

  /** Запись добавлена — окно закрыто, журнал и итог перечитаны с сервера. */
  function handleExpenseSaved(): void {
    setExpenseFormOpen(false);
    void loadExpenses();
  }

  /** Цены сохранены — окно закрыто, страница взяла проект из ответа `PATCH`. */
  function handlePricesSaved(updated: Project): void {
    setProject(updated);
    setPricesOpen(false);
  }

  /**
   * Сохранение, создание или удаление отдела прошло — окно и страница закрыты, список
   * отделов перечитан с сервера.
   */
  function handleDepartmentSaved(): void {
    setDepartmentDialog(null);
    setEditor(null);
    void loadDepartments();
  }

  const tasksPanelId = `${tabsId}-panel-tasks`;
  const departmentsPanelId = `${tabsId}-panel-departments`;
  const expensesPanelId = `${tabsId}-panel-expenses`;

  // Правка отдела — отдельная страница вместо содержимого проекта: так же, как
  // `ProjectsPage` показывает `ProjectPage`. Возврат из неё состояние вкладки не трогает —
  // после сохранения открытой остаётся та же вкладка «Отделы».
  if (editor !== null) {
    return (
      <DepartmentPage
        project={project}
        department={editor}
        onBack={() => setEditor(null)}
        onSaved={handleDepartmentSaved}
      />
    );
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
              {/* Расходы проекта — та же служебная строка паспорта, что и «Обновлён»:
                  не метрика и не дашборд. Пока журнал не прочитан, ни числа, ни слова
                  «Расходы» нет: пустая подпись «Расходы —» читалась бы как ноль. */}
              {expenses.status === 'ready' && (
                <>
                  <span className="crumbs__sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="project-spend">
                    Расходы{' '}
                    <span className="project-spend__value" data-testid="project-total">
                      {formatMoney(expenses.total)}
                    </span>
                  </span>
                </>
              )}
              <span className="crumbs__sep" aria-hidden="true">
                ·
              </span>
              <span>{`Обновлён ${formatDate(project.updated_at)}`}</span>
              {/* Код проекта — тот же идентификатор, под которым проект живёт в
                  документе реестра отдела. Показывается только когда задан. */}
              {project.code !== null && project.code !== '' && (
                <>
                  <span className="crumbs__sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="project-code" data-testid="project-code">
                    {`Код проекта: ${project.code}`}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Полоса подразделов: три вкладки одного уровня, у выбранной `aria-selected`.
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
          <button
            className="tab"
            type="button"
            role="tab"
            id={`${tabsId}-expenses`}
            aria-selected={activeTab === 'expenses'}
            aria-controls={expensesPanelId}
            data-testid="project-tab-expenses"
            onClick={() => setActiveTab('expenses')}
          >
            Расходы
          </button>
        </div>

        {/* Обе панели есть в разметке всегда, невыбранная скрыта атрибутом `hidden`:
            так `aria-controls` у каждой вкладки ссылается на существующую область, а не
            в пустоту (`aria-valid-attr-value`), и скрытая панель недоступна ни глазу, ни
            скринридеру. Своего `display` у панели нет, поэтому пользовательское
            `[hidden] { display: none }` работает без отдельного правила. */}
        <div
          role="tabpanel"
          id={tasksPanelId}
          aria-labelledby={`${tabsId}-tasks`}
          hidden={activeTab !== 'tasks'}
        >
          <TaskList
            tasks={tasks.status === 'ready' ? tasks.tasks : []}
            loading={tasks.status === 'loading'}
            errorText={tasks.status === 'error' ? tasks.errorText : null}
            onRetry={() => void loadTasks()}
            onCreate={() => setTaskFormOpen(true)}
          />
        </div>

        <div
          role="tabpanel"
          id={departmentsPanelId}
          aria-labelledby={`${tabsId}-departments`}
          hidden={activeTab !== 'departments'}
        >
          <DepartmentList
            departments={departments.status === 'ready' ? departments.departments : []}
            loading={departments.status === 'loading'}
            errorText={departments.status === 'error' ? departments.errorText : null}
            onRetry={() => void loadDepartments()}
            onCreate={() => setDepartmentDialog({ kind: 'create' })}
            onEdit={(department) => setEditor(department)}
            onDelete={(department) => setDepartmentDialog({ kind: 'delete', department })}
          />
        </div>

        <div
          role="tabpanel"
          id={expensesPanelId}
          aria-labelledby={`${tabsId}-expenses`}
          hidden={activeTab !== 'expenses'}
        >
          <ExpenseList
            expenses={expenses.status === 'ready' ? expenses.expenses : []}
            total={expenses.status === 'ready' ? expenses.total : null}
            loading={expenses.status === 'loading'}
            errorText={expenses.status === 'error' ? expenses.errorText : null}
            prices={project}
            onRetry={() => void loadExpenses()}
            onCreate={() => setExpenseFormOpen(true)}
            onEditPrices={() => setPricesOpen(true)}
          />
        </div>
      </main>

      {taskFormOpen && (
        <TaskFormDialog
          projectId={project.id}
          onClose={() => setTaskFormOpen(false)}
          onSaved={handleTaskSaved}
        />
      )}

      {expenseFormOpen && (
        <ExpenseFormDialog
          projectId={project.id}
          onClose={() => setExpenseFormOpen(false)}
          onSaved={handleExpenseSaved}
        />
      )}

      {pricesOpen && (
        <ProjectPricesDialog
          project={project}
          onClose={() => setPricesOpen(false)}
          onSaved={handlePricesSaved}
        />
      )}

      {departmentDialog !== null && departmentDialog.kind === 'create' && (
        <DepartmentCreateDialog
          projectId={project.id}
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
