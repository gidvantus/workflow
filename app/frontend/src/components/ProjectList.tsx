/**
 * Карточка «Список проектов»: состояния загрузки, пустого списка и ошибки загрузки,
 * строки с названием, описанием, адресом репозитория и действиями под «⋯».
 *
 * Клик по строке открывает страницу проекта; для клавиатуры то же делает кнопка-название
 * (`.row__name--button`). Действия строки живут отдельно: клик по «⋯» и по пунктам меню
 * страницу не открывает.
 *
 * Описание выводится как есть: пустое остаётся пустой строкой, заглушку не подставляем.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { Project } from '../api/projects';

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

/** Количество проектов с правильным окончанием: «1 проект», «4 проекта», «11 проектов». */
function projectsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} проект`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} проекта`;
  }
  return `${count} проектов`;
}

type ProjectRowProps = {
  project: Project;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
  onOpen: (project: Project) => void;
};

function ProjectRow({ project, onEdit, onDelete, onOpen }: ProjectRowProps): JSX.Element {
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

  const menuLabel = `Действия с проектом ${project.name}`;

  return (
    <li
      className="row row--clickable"
      data-testid="project-item"
      onClick={() => onOpen(project)}
    >
      <div className="row__main">
        {/* Название — кнопка: строка открывается кликом, но дойти до неё с клавиатуры
            иначе было бы нечем. Enter и Space на кнопке дают тот же переход, что и
            клик по строке. */}
        <p className="row__name" data-testid="project-item-name">
          <button
            className="row__name--button"
            type="button"
            data-testid="project-item-open"
          >
            {project.name}
          </button>
        </p>
        <p className="row__desc" data-testid="project-item-description">
          {project.description}
        </p>
      </div>
      <p className="row__repo" title={project.repo_url}>
        {project.repo_url}
      </p>
      <p className="row__date">{formatDate(project.updated_at)}</p>
      {/* Клик по «⋯» и по пунктам меню страницу проекта не открывает: действия строки
          живут отдельно, поэтому всплывание останавливается на их контейнере. */}
      <div className="row__actions" ref={actionsRef} onClick={(event) => event.stopPropagation()}>
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
              data-testid="project-edit"
              onClick={() => {
                setMenuOpen(false);
                // Пункт меню размонтируется тем же действием, которое открывает окно,
                // поэтому фокус сначала возвращается на «⋯»: её окно и запомнит как
                // точку возврата — иначе после Esc он уйдёт на <body>.
                kebabRef.current?.focus();
                onEdit(project);
              }}
            >
              Изменить
            </button>
            <button
              className="menu__item menu__item--delete"
              type="button"
              role="menuitem"
              data-testid="project-delete"
              onClick={() => {
                setMenuOpen(false);
                kebabRef.current?.focus();
                onDelete(project);
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

type ProjectListProps = {
  projects: Project[];
  loading: boolean;
  /** Текст ошибки загрузки; `null` — ошибки нет. */
  errorText: string | null;
  onRetry: () => void;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
  /** Клик по строке или Enter/Space на названии открывает страницу проекта. */
  onOpen: (project: Project) => void;
};

export default function ProjectList({
  projects,
  loading,
  errorText,
  onRetry,
  onEdit,
  onDelete,
  onOpen,
}: ProjectListProps): JSX.Element {
  const titleId = useId();
  const showCount = !loading && errorText === null;

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card__head">
        <h2 className="card__title" id={titleId}>
          Список проектов
        </h2>
        {showCount && <span className="card__meta">{projectsCount(projects.length)}</span>}
      </div>

      {loading && (
        <div className="card__body">
          <p className="state__line" data-testid="projects-state" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {!loading && errorText !== null && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" data-testid="project-error" role="alert">
              {errorText}
            </p>
            <button className="btn" type="button" data-testid="projects-retry" onClick={onRetry}>
              Повторить
            </button>
          </div>
        </div>
      )}

      {!loading && errorText === null && projects.length === 0 && (
        <div className="card__body">
          <p className="state__line" data-testid="projects-empty">
            Пока нет проектов
          </p>
          <p className="state__hint">Нажмите «Добавить проект», и он появится в этом списке.</p>
        </div>
      )}

      {!loading && errorText === null && projects.length > 0 && (
        <>
          <div className="table__head" role="presentation">
            <span>Название</span>
            <span>Репозиторий</span>
            <span>Обновлён</span>
            <span>Действия</span>
          </div>
          <ul className="table__body" data-testid="projects-list">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onEdit={onEdit}
                onDelete={onDelete}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
