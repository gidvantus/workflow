/**
 * Карточка «Список отделов»: состояния загрузки, пустого списка и ошибки загрузки,
 * строки с названием, видом, временем работы, ролями и действиями под «⋯», кнопка
 * «Добавить отдел» в шапке карточки рядом со счётчиком.
 *
 * Карточка самодостаточна и переиспользуется: она не знает, где стоит — на странице
 * проекта; проект в запросы подставляет окно, которое открывает `onCreate`.
 *
 * Вид — мелкая строка под названием, а не колонка: имя отдела равно названию вида
 * только у отделов, заведённых выбором, а у переживших миграцию `0006` оно прежнее
 * («Поддержка» при виде «Разработка»), и различить их иначе нечем.
 *
 * Время — главный элемент раздела: набор окон приходит с сервера массивом строк `"ЧЧ:ММ"`
 * в порядке возрастания начала и показывается как `07:00–09:00, 13:00–04:00`; под ним —
 * суммарная длительность всех окон. Переход через полночь (`end` раньше `start`) — штатный
 * случай: длительность каждого окна считается по кругу суток, а слова «через полночь»
 * снимают вопрос «почему конец раньше начала». Расписания может не быть вовсе — пустой
 * набор: тогда в значении «нет расписания», а длительность пуста.
 *
 * Роли — текст через запятую по названиям из справочника сервера, не чипы; пустой набор
 * ролей допустим и показывается прочерком.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { Department, DepartmentWindow } from '../api/departments';

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

/** Дата обновления в виде «28 окт 2026»: свой список месяцев, чтобы не зависеть от ICU. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/**
 * Минуты с начала суток из `"ЧЧ:ММ"`; неразборчивое время — `null`, без выдумок.
 * Своего формата фронт не требует: время в этом поле пришло от сервера, а `null` здесь
 * значит «строку не разобрать», а не «расписания нет» — расписание приходит массивом.
 */
function minutesOf(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Длительность одного окна в минутах и признак перехода через полночь. Конец раньше
 * начала — окно идёт до конца суток и продолжается с нуля, это норма, а не опечатка.
 */
function windowLength(
  window: DepartmentWindow,
): { minutes: number; overnight: boolean } | null {
  const start = minutesOf(window.start_time);
  const end = minutesOf(window.end_time);
  if (start === null || end === null) {
    return null;
  }
  const overnight = end < start;
  return { minutes: (overnight ? end + 24 * 60 : end) - start, overnight };
}

/** Длительность в прежнем формате: `9 ч`, `15 ч`, `9 ч 30 мин`. */
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/**
 * Суммарная длительность набора и «· через полночь», если хотя бы одно окно переходит
 * полночь. Сумма честная: окна не пересекаются — это правило сервера, а не допущение
 * фронта, поэтому сумма длительностей равна времени работы отдела в сутках.
 */
function scheduleText(windows: DepartmentWindow[]): string {
  if (windows.length === 0) {
    return '';
  }
  let total = 0;
  let overnight = false;
  for (const window of windows) {
    const length = windowLength(window);
    if (length === null) {
      return '';
    }
    total += length.minutes;
    overnight = overnight || length.overnight;
  }
  const length = formatDuration(total);
  return overnight ? `${length} · через полночь` : length;
}

/** Количество отделов с правильным окончанием: «1 отдел», «2 отдела», «11 отделов». */
function departmentsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} отдел`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} отдела`;
  }
  return `${count} отделов`;
}

type DepartmentRowProps = {
  department: Department;
  onEdit: (department: Department) => void;
  onDelete: (department: Department) => void;
};

function DepartmentRow({
  department,
  onEdit,
  onDelete,
}: DepartmentRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    firstItemRef.current?.focus();

    function handleMouseDown(event: MouseEvent): void {
      const actions = actionsRef.current;
      if (actions === null || !(event.target instanceof Node)) {
        return;
      }
      if (!actions.contains(event.target)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        kebabRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const menuLabel = `Действия с отделом ${department.name}`;
  // Расписание — набор окон: пустой набор значит «расписания нет». Окна идут как пришли
  // с сервера (по возрастанию начала), фронт их не сортирует и время не переписывает.
  const hasSchedule = department.windows.length > 0;
  const rolesText =
    department.roles.length === 0
      ? '—'
      : department.roles.map((role) => role.title).join(', ');

  return (
    <li className="row row--department" data-testid="department-item">
      <div className="row__main">
        <p className="row__name" data-testid="department-item-name">
          {department.name}
        </p>
        <p className="row__kind" data-testid="department-item-kind">
          {department.kind.title}
        </p>
      </div>
      <div className="dept-time">
        {/*
          Окна — отдельными спанами: на широком экране каждое занимает свою строку
          (запятая остаётся концом предыдущей), на узком встают в строку через запятую.
          Текст ячейки при этом один и тот же: `07:00–09:00, 13:00–04:00` — в серверном
          порядке, по возрастанию начала.
        */}
        <span
          className={hasSchedule ? 'dept-time__value' : 'dept-time__value dept-time__value--empty'}
          data-testid="department-item-time"
        >
          {hasSchedule
            ? department.windows.map((window, index) => (
                <span className="dept-time__window" key={index}>
                  {`${window.start_time}–${window.end_time}`}
                  {index < department.windows.length - 1 ? ', ' : ''}
                </span>
              ))
            : 'нет расписания'}
        </span>
        <span className="dept-time__note">{scheduleText(department.windows)}</span>
      </div>
      <p className="row__roles" data-testid="department-item-roles">
        {rolesText}
      </p>
      <p className="row__date">{formatDate(department.updated_at)}</p>
      <div className="row__actions" ref={actionsRef}>
        <button
          ref={kebabRef}
          className="kebab"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={menuLabel}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.15" />
            <circle cx="8" cy="8" r="1.15" />
            <circle cx="12.5" cy="8" r="1.15" />
          </svg>
        </button>
        {menuOpen && (
          <div className="menu" role="menu" aria-label={menuLabel}>
            <button
              ref={firstItemRef}
              className="menu__item"
              type="button"
              role="menuitem"
              data-testid="department-edit"
              onClick={() => {
                setMenuOpen(false);
                // Пункт меню размонтируется тем же действием, которое открывает окно,
                // поэтому фокус сначала возвращается на «⋯»: её окно и запомнит как
                // точку возврата — иначе после Esc он уйдёт на <body>.
                kebabRef.current?.focus();
                onEdit(department);
              }}
            >
              Изменить
            </button>
            <button
              className="menu__item menu__item--delete"
              type="button"
              role="menuitem"
              data-testid="department-delete"
              onClick={() => {
                setMenuOpen(false);
                kebabRef.current?.focus();
                onDelete(department);
              }}
            >
              Удалить
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

type DepartmentListProps = {
  departments: Department[];
  loading: boolean;
  /** Текст ошибки загрузки; `null` — ошибки нет. */
  errorText: string | null;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (department: Department) => void;
  onDelete: (department: Department) => void;
};

export default function DepartmentList({
  departments,
  loading,
  errorText,
  onRetry,
  onCreate,
  onEdit,
  onDelete,
}: DepartmentListProps): JSX.Element {
  const titleId = useId();
  const showCount = !loading && errorText === null;

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card__head">
        <h2 className="card__title" id={titleId}>
          Список отделов
        </h2>
        <div className="card__tools">
          {showCount && <span className="card__meta">{departmentsCount(departments.length)}</span>}
          <button
            className="btn btn--dark"
            type="button"
            data-testid="department-create"
            onClick={onCreate}
          >
            Добавить отдел
          </button>
        </div>
      </div>

      {loading && (
        <div className="card__body">
          <p className="state__line" data-testid="departments-state" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {!loading && errorText !== null && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" data-testid="department-error" role="alert">
              {errorText}
            </p>
            <button
              className="btn"
              type="button"
              data-testid="departments-retry"
              onClick={onRetry}
            >
              Повторить
            </button>
          </div>
        </div>
      )}

      {!loading && errorText === null && departments.length === 0 && (
        <div className="card__body">
          <p className="state__line" data-testid="departments-empty">
            Пока нет отделов
          </p>
          <p className="state__hint">
            Нажмите «Добавить отдел», выберите вид — и отдел появится в этом списке.
          </p>
        </div>
      )}

      {!loading && errorText === null && departments.length > 0 && (
        <>
          <div className="table__head table__head--department" role="presentation">
            <span>Отдел</span>
            <span>Время работы</span>
            <span>Роли</span>
            <span>Обновлён</span>
            <span>Действия</span>
          </div>
          <ul className="table__body" data-testid="departments-list">
            {departments.map((department) => (
              <DepartmentRow
                key={department.id}
                department={department}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
