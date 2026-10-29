/**
 * Оболочка приложения: бренд, меню с двумя разделами и подвал.
 *
 * Выбранный раздел — состояние в `App`: роутера и отдельных URL нет, поэтому F5 всегда
 * открывает «Проекты». Оба раздела смонтированы и читают свои списки при старте, чтобы
 * бейдж количества стоял у обоих пунктов меню, а не появлялся после переключения;
 * невыбранный раздел скрыт атрибутом `hidden` и потому недоступен ни глазу, ни
 * вспомогательным технологиям.
 */

import { useCallback, useState } from 'react';

import DepartmentsPage from './components/DepartmentsPage';
import ProjectsPage from './components/ProjectsPage';

type Section = 'projects' | 'departments';

export default function App(): JSX.Element {
  const [section, setSection] = useState<Section>('projects');
  const [projectsCount, setProjectsCount] = useState<number | null>(null);
  const [departmentsCount, setDepartmentsCount] = useState<number | null>(null);

  // Обработчики стабильны: разделы зовут их из эффекта, и новая ссылка на каждой
  // отрисовке запускала бы эффект заново.
  const handleProjectsCount = useCallback((count: number | null): void => {
    setProjectsCount(count);
  }, []);
  const handleDepartmentsCount = useCallback((count: number | null): void => {
    setDepartmentsCount(count);
  }, []);

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
          <a
            className="nav__item"
            href="#"
            aria-current={section === 'projects' ? 'page' : undefined}
            data-testid="nav-projects"
            onClick={(event) => {
              event.preventDefault();
              setSection('projects');
            }}
          >
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
            {projectsCount !== null && <span className="nav__count">{projectsCount}</span>}
          </a>
          <a
            className="nav__item"
            href="#"
            aria-current={section === 'departments' ? 'page' : undefined}
            data-testid="nav-departments"
            onClick={(event) => {
              event.preventDefault();
              setSection('departments');
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d="M3 13V7.5m5 5.5v-9m5 9V9.5" />
            </svg>
            Отделы
            {departmentsCount !== null && <span className="nav__count">{departmentsCount}</span>}
          </a>
        </nav>
      </aside>

      <div className="main">
        <div className="page" hidden={section !== 'projects'}>
          <ProjectsPage onCountChange={handleProjectsCount} />
        </div>

        <div className="page" hidden={section !== 'departments'}>
          <DepartmentsPage onCountChange={handleDepartmentsCount} />
        </div>

        <footer className="footbar">
          <p className="footbar__note">© 2026 Workflow</p>
        </footer>
      </div>
    </div>
  );
}
