/**
 * Карточка «Задачи проекта»: состояния загрузки, пустого списка и ошибки загрузки,
 * строки задач и кнопка «Добавить задачу» в шапке карточки.
 *
 * Строка задачи — ровно три элемента: номер (`#12`), название и стоимость. Описания
 * в строке нет: это решение постановки, а не потеря поля — описание остаётся полем
 * задачи, приходит в ответе API и есть в форме создания.
 *
 * Стоимость фронт не считает: сервер отдаёт строку `"1250.00"` или `null`, здесь она
 * только переставляется в вид `1 250,00 ₽` или «не указана». Копейки в рубли не
 * переводятся, округления нет.
 */

import { useId } from 'react';

import type { Task } from '../api/tasks';
import { formatMoney } from '../format';

/** Количество задач с правильным окончанием: «1 задача», «2 задачи», «5 задач». */
function tasksCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} задача`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} задачи`;
  }
  return `${count} задач`;
}

/**
 * Стоимость для экрана: `"1250.00"` → `1 250,00 ₽`, `null` → «не указана».
 *
 * Сам разбор строки живёт в `format.ts`: тот же вид суммы нужен журналу расходов и итогу
 * проекта, и две копии одной регулярки разошлись бы. Здесь только «не указана» — состояние
 * задачи, которого у денег журнала не бывает.
 */
function formatCost(cost: string | null): string {
  return cost === null ? 'не указана' : formatMoney(cost);
}

type TaskRowProps = {
  task: Task;
};

function TaskRow({ task }: TaskRowProps): JSX.Element {
  return (
    <li className="task-row" data-testid="task-item">
      <p className="row__id" data-testid="task-item-id">
        {`#${task.id}`}
      </p>
      <p className="task-row__name" data-testid="task-item-name">
        {task.name}
      </p>
      <p className="row__cost" data-testid="task-item-cost">
        {formatCost(task.cost)}
      </p>
    </li>
  );
}

type TaskListProps = {
  tasks: Task[];
  loading: boolean;
  /** Текст ошибки загрузки; `null` — ошибки нет. */
  errorText: string | null;
  onRetry: () => void;
  onCreate: () => void;
};

export default function TaskList({
  tasks,
  loading,
  errorText,
  onRetry,
  onCreate,
}: TaskListProps): JSX.Element {
  const titleId = useId();
  // Счётчик — часть шапки карточки: он отвечает на вопрос «сколько уже есть».
  // Пока список читается или не прочитался, числа нет — как в «Проектах».
  const showCount = !loading && errorText === null;

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card__head">
        <h2 className="card__title" id={titleId}>
          Задачи проекта
        </h2>
        <div className="card__tools">
          {showCount && <span className="card__meta">{tasksCount(tasks.length)}</span>}
          <button
            className="btn btn--dark"
            type="button"
            data-testid="task-create"
            onClick={onCreate}
          >
            Добавить задачу
          </button>
        </div>
      </div>

      {loading && (
        <div className="card__body">
          <p className="state__line" data-testid="tasks-state" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {!loading && errorText !== null && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" data-testid="tasks-error" role="alert">
              {errorText}
            </p>
            <button className="btn" type="button" data-testid="tasks-retry" onClick={onRetry}>
              Повторить
            </button>
          </div>
        </div>
      )}

      {!loading && errorText === null && tasks.length === 0 && (
        <div className="card__body">
          <p className="state__line" data-testid="tasks-empty">
            Пока нет задач
          </p>
          <p className="state__hint">Нажмите «Добавить задачу», и она появится в этом списке.</p>
        </div>
      )}

      {!loading && errorText === null && tasks.length > 0 && (
        <ul className="table__body" data-testid="tasks-list">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </section>
  );
}
