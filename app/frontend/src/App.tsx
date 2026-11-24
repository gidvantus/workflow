/**
 * Оболочка приложения: бренд, меню из двух разделов — «Проекты» и «Роли» — и подвал.
 *
 * Роутера и отдельных URL в приложении нет: раздел переключается состоянием, а F5 всегда
 * открывает «Проекты». Отделы живут внутри проекта вкладкой на его странице, отдельного
 * пункта меню и отдельного экрана у них по-прежнему нет.
 *
 * Оба раздела смонтированы постоянно, невыбранный скрыт атрибутом `hidden` — так переход в
 * другой раздел и обратно не теряет состояние: список проектов, открытая страница проекта и
 * открытая роль остаются там, где их оставили. Своего `display` у обёртки нет, поэтому
 * пользовательское `[hidden] { display: none }` работает без отдельного правила.
 *
 * Бейдж меню показывает то же число, что счётчик списка проектов, и появляется, когда
 * список прочитан.
 */

import { useCallback, useState } from 'react';

import AgentsPage from './components/AgentsPage';
import ProjectsPage from './components/ProjectsPage';
import RolesPage from './components/RolesPage';

/** Раздел оболочки; порядок в меню совпадает с порядком объявления. */
type Section = 'projects' | 'roles' | 'agents';

export default function App(): JSX.Element {
  const [section, setSection] = useState<Section>('projects');
  const [projectsCount, setProjectsCount] = useState<number | null>(null);
  const [agentsCount, setAgentsCount] = useState<number | null>(null);

  // Обработчик стабилен: раздел зовёт его из эффекта, и новая ссылка на каждой
  // отрисовке запускала бы эффект заново.
  const handleProjectsCount = useCallback((count: number | null): void => {
    setProjectsCount(count);
  }, []);

  const handleAgentsCount = useCallback((count: number | null): void => {
    setAgentsCount(count);
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
            aria-current={section === 'roles' ? 'page' : undefined}
            data-testid="nav-roles"
            onClick={(event) => {
              event.preventDefault();
              setSection('roles');
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
              <path d="M8 2.5a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5z" />
              <path d="M2.75 13.5c0-2.4 2.35-4 5.25-4s5.25 1.6 5.25 4" />
            </svg>
            Роли
          </a>
          <a
            className="nav__item"
            href="#"
            aria-current={section === 'agents' ? 'page' : undefined}
            data-testid="nav-agents"
            onClick={(event) => {
              event.preventDefault();
              setSection('agents');
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
              <rect x="2.5" y="3.5" width="11" height="8" rx="1.5" />
              <path d="M5.5 6.5h5M5.5 9h3M8 2v1.5M8 11.5V13" />
            </svg>
            Агенты
            {agentsCount !== null && <span className="nav__count">{agentsCount}</span>}
          </a>
        </nav>
      </aside>

      <div className="main">
        <div className="view" hidden={section !== 'projects'}>
          <ProjectsPage onCountChange={handleProjectsCount} />
        </div>
        <div className="view" hidden={section !== 'roles'}>
          <RolesPage />
        </div>
        <div className="view" hidden={section !== 'agents'}>
          <AgentsPage onCountChange={handleAgentsCount} />
        </div>

        <footer className="footbar">
          <p className="footbar__note">© 2026 Workflow</p>
        </footer>
      </div>
    </div>
  );
}
