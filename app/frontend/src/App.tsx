/**
 * Оболочка приложения: бренд, меню с единственным разделом «Проекты» и подвал.
 *
 * Раздел один: отделы живут внутри проекта вкладкой на его странице, отдельного пункта
 * меню и отдельного экрана у них больше нет. Роутера и отдельных URL в приложении нет,
 * поэтому F5 всегда открывает «Проекты».
 *
 * Раздел смонтирован постоянно, и состояние страницы проекта живёт в нём: бейдж меню
 * показывает то же число, что счётчик списка, и появляется, когда список прочитан.
 */

import { useCallback, useState } from 'react';

import ProjectsPage from './components/ProjectsPage';

export default function App(): JSX.Element {
  const [projectsCount, setProjectsCount] = useState<number | null>(null);

  // Обработчик стабилен: раздел зовёт его из эффекта, и новая ссылка на каждой
  // отрисовке запускала бы эффект заново.
  const handleProjectsCount = useCallback((count: number | null): void => {
    setProjectsCount(count);
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
            aria-current="page"
            data-testid="nav-projects"
            onClick={(event) => event.preventDefault()}
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
        </nav>
      </aside>

      <div className="main">
        <ProjectsPage onCountChange={handleProjectsCount} />

        <footer className="footbar">
          <p className="footbar__note">© 2026 Workflow</p>
        </footer>
      </div>
    </div>
  );
}
