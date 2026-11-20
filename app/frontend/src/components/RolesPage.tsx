/**
 * Раздел «Роли»: список ролей отдела разработки и вход в страницу роли.
 *
 * Раздел — вторая секция оболочки рядом с «Проектами» (переключатель в `App`); своего URL
 * у него нет, как и у страницы проекта. Здесь только справочник: название, код, число
 * скиллов и дата. Содержимое роли (описание и скиллы) живёт на странице роли.
 *
 * **Роль против отдела.** Роль в отделе — строка с кодом; отдел на неё ссылается, поэтому
 * роль, стоящую в живом отделе, сервер не удаляет (`409` с текстом «Роль стоит в отделах:
 * сначала уберите её из них»). Текст показывается в окне удаления дословно, кнопка
 * «Удалить» остаётся на месте: сначала человек убирает роль из отдела, потом возвращается.
 *
 * **Код.** Код роли — слаг каталога пресета DSH; он не меняется после создания, поэтому в
 * строке он стоит моноширинно и рядом с названием, а не отдельным полем правки.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { deleteRole, listRoles, type Role } from '../api/roles';
import ConfirmDialog from './ConfirmDialog';
import RoleFormDialog from './RoleFormDialog';
import RolePage from './RolePage';

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

/** Дата в виде «28 окт 2026»: свой список месяцев, чтобы не зависеть от ICU. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** «1 скилл», «2 скилла», «5 скиллов». */
function skillsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} скилл`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} скилла`;
  }
  return `${count} скиллов`;
}

/** «1 роль», «2 роли», «5 ролей». */
function rolesCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} роль`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} роли`;
  }
  return `${count} ролей`;
}

/** Состояние списка ролей: загрузка, готовые данные или ошибка загрузки. */
type ListState =
  | { status: 'loading' }
  | { status: 'ready'; roles: Role[] }
  | { status: 'error'; errorText: string };

/** Открытое окно раздела. */
type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; role: Role }
  | { kind: 'delete'; role: Role }
  | null;

export default function RolesPage(): JSX.Element {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [openRole, setOpenRole] = useState<Role | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async (): Promise<void> => {
    setList({ status: 'loading' });
    try {
      setList({ status: 'ready', roles: await listRoles() });
    } catch (error) {
      setList({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function closeDialog(): void {
    setDialog(null);
  }

  // Открытая роль живёт отдельно от списка: правка роли не должна пересобирать страницу,
  // а возврат в список перечитывает данные — в строке меняются название и число скиллов.
  if (openRole !== null) {
    return (
      <RolePage
        role={openRole}
        onBack={() => {
          setOpenRole(null);
          void load();
        }}
        onRoleSaved={(saved) => {
          setOpenRole(saved);
          void load();
        }}
        onRoleDeleted={() => {
          setOpenRole(null);
          void load();
        }}
      />
    );
  }

  const roles = list.status === 'ready' ? list.roles : null;

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">Роли</span>
        </p>
      </header>

      <main className="content" data-testid="roles-page">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Роли</h1>
            <p className="page-head__sub">
              Роли отдела разработки и их скиллы. Код роли — имя каталога пресета DSH: по нему
              роль раскладывается в «~/.dsh/.agent-presets».
            </p>
          </div>
          <button
            className="btn btn--dark"
            type="button"
            data-testid="role-create"
            onClick={() => setDialog({ kind: 'create' })}
          >
            Добавить роль
          </button>
        </div>

        <section className="card">
          <div className="card__head">
            <h2 className="card__title">Справочник ролей</h2>
            <span className="card__meta">{roles === null ? '' : rolesCount(roles.length)}</span>
          </div>

          {list.status === 'loading' && (
            <div className="card__body">
              <p className="state__line" data-testid="roles-state">
                Загрузка…
              </p>
            </div>
          )}

          {list.status === 'error' && (
            <div className="card__body">
              <div className="state__error">
                <p className="error" data-testid="roles-error" role="alert">
                  {list.errorText}
                </p>
                <button
                  className="btn"
                  type="button"
                  data-testid="roles-retry"
                  onClick={() => void load()}
                >
                  Повторить
                </button>
              </div>
            </div>
          )}

          {roles !== null && roles.length === 0 && (
            <div className="card__body">
              <p className="state__line" data-testid="roles-empty">
                Пока нет ролей
              </p>
              <p className="state__hint">
                Нажмите «Добавить роль»: роль с кодом, названием и описанием заводится здесь,
                а скиллы добавляются на её странице.
              </p>
            </div>
          )}

          {roles !== null && roles.length > 0 && (
            <>
              <div className="table__head table__head--role" role="presentation">
                <span>Название</span>
                <span>Код</span>
                <span>Скиллы</span>
                <span>Обновлена</span>
                <span>Действия</span>
              </div>
              <ul className="table__body" data-testid="roles-list">
                {roles.map((role) => (
                  <li
                    className="row row--role row--clickable"
                    key={role.id}
                    data-testid="role-item"
                    onClick={() => setOpenRole(role)}
                  >
                    <div className="row__main">
                      <p className="row__name">
                        {/* Название — кнопка: до строки можно дойти клавиатурой, Enter и
                            Space открывают то же, что клик по строке. */}
                        <button
                          className="row__name--button"
                          type="button"
                          data-testid="role-item-open"
                        >
                          {role.title}
                        </button>
                      </p>
                      <p className="row__desc">{role.description}</p>
                    </div>
                    <p className="row__repo" data-testid="role-item-code">
                      {role.code}
                    </p>
                    <p className="row__date" data-testid="role-item-skills">
                      {skillsCount(role.skill_count)}
                    </p>
                    <p className="row__date">{formatDate(role.updated_at)}</p>
                    <div className="row__actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        className="btn"
                        type="button"
                        data-testid="role-edit"
                        onClick={() => setDialog({ kind: 'edit', role })}
                      >
                        Изменить
                      </button>
                      <button
                        className="btn btn--danger"
                        type="button"
                        data-testid="role-delete"
                        onClick={() => setDialog({ kind: 'delete', role })}
                      >
                        Удалить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>

      {dialog !== null && dialog.kind === 'create' && (
        <RoleFormDialog
          mode="create"
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void load();
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'edit' && (
        <RoleFormDialog
          mode="edit"
          role={dialog.role}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void load();
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'delete' && (
        <ConfirmDialog
          testId="role-delete-confirm"
          title="Удалить роль?"
          text={`Роль «${dialog.role.title}» исчезнет из списка, а её скиллы перестанут раскладываться. Восстановить роль через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteRole(dialog.role.id);
            closeDialog();
            void load();
          }}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
