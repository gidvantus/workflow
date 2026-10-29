/**
 * Карточка «Список отделов»: состояния загрузки, пустого списка и ошибки загрузки,
 * строки с названием, временем работы, ролями и действиями под «⋯».
 *
 * Время — главный элемент раздела: значение приходит с сервера строкой `"ЧЧ:ММ"` и
 * показывается как `13:00–04:00`, под ним длительность смены. Переход через полночь
 * (`end` раньше `start`) — штатный случай: длительность считается по кругу суток,
 * а слова «через полночь» снимают вопрос «почему конец раньше начала».
 *
 * Роли — текст через запятую по названиям из справочника сервера, не чипы.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { Department } from '../api/departments';

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

/** Минуты с начала суток из `"ЧЧ:ММ"`; неразборчивое время — `null`, без выдумок. */
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

/** Длительность смены: `9 ч`, `15 ч`, `9 ч 30 мин`. Конец раньше начала — через полночь. */
function shiftText(startTime: string, endTime: string): string {
  const start = minutesOf(startTime);
  const end = minutesOf(endTime);
  if (start === null || end === null) {
    return '';
  }
  const overnight = end < start;
  const total = (overnight ? end + 24 * 60 : end) - start;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const length = minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
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
  const time = `${department.start_time}–${department.end_time}`;
  const rolesText = department.roles.map((role) => role.title).join(', ');

  return (
    <li className="row row--department" data-testid="department-item">
      <div className="row__main">
        <p className="row__name" data-testid="department-item-name">
          {department.name}
        </p>
      </div>
      <div className="dept-time">
        <span className="dept-time__value" data-testid="department-item-time">
          {time}
        </span>
        <span className="dept-time__note">
          {shiftText(department.start_time, department.end_time)}
        </span>
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
  onEdit: (department: Department) => void;
  onDelete: (department: Department) => void;
};

export default function DepartmentList({
  departments,
  loading,
  errorText,
  onRetry,
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
        {showCount && <span className="card__meta">{departmentsCount(departments.length)}</span>}
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
            Нажмите «Добавить отдел», и он появится в этом списке.
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
