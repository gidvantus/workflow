/**
 * Страница роли: название, код и описание, состояние пресета DSH и скиллы роли.
 *
 * Роль открывается из списка раздела; собственного URL у страницы нет — открытость роли
 * живёт состоянием `RolesPage`, как страница проекта у «Проектов».
 *
 * **Скиллы.** Читаются отдельной ручкой `GET /api/roles/{id}/skills` — списком, а не в
 * составе роли: число скиллов в строке списка ролей сервер считает сам. Правка и удаление
 * адресуются скиллу по `id` (`/api/skills/{id}`), создание — вложено в роль.
 *
 * **Пресет DSH.** Блок читает манифест `/api/presets` — машинную ручку под токеном
 * надстройки. Токена в браузерной сборке нет, и это штатное состояние экрана: блок честно
 * говорит, что ревизию раскладки показывает статус отдела (`presetsSync`), а не веб.
 * Если стенд всё же задал токен сборки, блок показывает ревизию роли из манифеста или
 * дословный `401`.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { readPresetManifest, registryToken, type PresetManifest } from '../api/presets';
import { deleteRole, deleteSkill, listSkills, type Role, type Skill } from '../api/roles';
import ConfirmDialog from './ConfirmDialog';
import RoleFormDialog from './RoleFormDialog';
import SkillFormDialog from './SkillFormDialog';

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

/** «1 раздел», «2 раздела», «5 разделов». */
function sectionsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} раздел`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} раздела`;
  }
  return `${count} разделов`;
}

/** Состояние списка скиллов: загрузка, готовые данные или ошибка загрузки. */
type SkillsState =
  | { status: 'loading' }
  | { status: 'ready'; skills: Skill[] }
  | { status: 'error'; errorText: string };

/**
 * Состояние манифеста пресетов. `unavailable` — токена надстройки в сборке нет, запрос не
 * отправляется вовсе: `401` на этом стенде был бы ожидаемым и ничего не сказал бы человеку.
 */
type PresetState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'ready'; manifest: PresetManifest }
  | { status: 'error'; errorText: string };

/** Открытое окно страницы. */
type DialogState =
  | { kind: 'role-edit' }
  | { kind: 'role-delete' }
  | { kind: 'skill-create' }
  | { kind: 'skill-edit'; skill: Skill }
  | { kind: 'skill-delete'; skill: Skill }
  | null;

type RolePageProps = {
  role: Role;
  onBack: () => void;
  /** Роль сохранена: страница обновляет заголовок, список ролей перечитывается в разделе. */
  onRoleSaved: (role: Role) => void;
  /** Роль удалена: раздел закрывает страницу и перечитывает список. */
  onRoleDeleted: () => void;
};

export default function RolePage({
  role,
  onBack,
  onRoleSaved,
  onRoleDeleted,
}: RolePageProps): JSX.Element {
  const [skills, setSkills] = useState<SkillsState>({ status: 'loading' });
  const [preset, setPreset] = useState<PresetState>(() =>
    registryToken() === null ? { status: 'unavailable' } : { status: 'loading' },
  );
  const [dialog, setDialog] = useState<DialogState>(null);

  const loadSkills = useCallback(async (): Promise<void> => {
    setSkills({ status: 'loading' });
    try {
      setSkills({ status: 'ready', skills: await listSkills(role.id) });
    } catch (error) {
      setSkills({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, [role.id]);

  const loadPreset = useCallback(async (): Promise<void> => {
    if (registryToken() === null) {
      return;
    }
    setPreset({ status: 'loading' });
    try {
      setPreset({ status: 'ready', manifest: await readPresetManifest() });
    } catch (error) {
      setPreset({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    void loadPreset();
  }, [loadPreset]);

  function closeDialog(): void {
    setDialog(null);
  }

  const skillsReady = skills.status === 'ready' ? skills.skills : null;
  const presetRole =
    preset.status === 'ready'
      ? preset.manifest.roles.find((item) => item.code === role.code)
      : undefined;

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          Роли
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">{role.title}</span>
        </p>
        <button className="btn" type="button" data-testid="role-page-back" onClick={onBack}>
          ← К ролям
        </button>
      </header>

      <main className="content" data-testid="role-page">
        <div className="page-head">
          <div className="project-head">
            <h1 className="page-head__title" data-testid="role-title">
              {role.title}
            </h1>
            <p className="project-head__desc">{role.description}</p>
            <p className="project-head__meta">
              <span className="project-repo">{role.code}</span>
              <span className="crumbs__sep" aria-hidden="true">
                ·
              </span>
              <span>{`Обновлена ${formatDate(role.updated_at)}`}</span>
            </p>
          </div>
          <div className="page-head__tools">
            <button
              className="btn"
              type="button"
              data-testid="role-edit"
              onClick={() => setDialog({ kind: 'role-edit' })}
            >
              Изменить роль
            </button>
            <button
              className="btn btn--danger"
              type="button"
              data-testid="role-delete"
              onClick={() => setDialog({ kind: 'role-delete' })}
            >
              Удалить роль
            </button>
          </div>
        </div>

        <section className="card" data-testid="role-preset">
          <div className="card__head">
            <h2 className="card__title">Пресет DSH</h2>
            {presetRole !== undefined && (
              <span className="card__meta" data-testid="role-preset-revision">
                {`Ревизия ${presetRole.revision}`}
              </span>
            )}
          </div>
          <div className="card__body">
            {preset.status === 'unavailable' && (
              <>
                <p className="state__line" data-testid="role-preset-state">
                  Ревизию раскладки показывает статус отдела
                </p>
                <p className="state__hint">
                  Манифест пресетов закрыт токеном надстройки, а в браузерной сборке его нет
                  намеренно: с токеном страницу мог бы переписать любой, кто её открыл.
                  Раскладку в «~/.dsh/.agent-presets» и её ревизию показывает
                  «dev_department_status» полем «presetsSync».
                </p>
              </>
            )}

            {preset.status === 'loading' && (
              <p className="state__line" data-testid="role-preset-state">
                Загрузка…
              </p>
            )}

            {preset.status === 'ready' && presetRole === undefined && (
              <>
                <p className="state__line" data-testid="role-preset-state">
                  Роли нет в манифесте веба
                </p>
                <p className="state__hint">
                  Пока скиллы не залиты ручкой импорта, harness раскладывает пакетную
                  версию роли из репозитория.
                </p>
              </>
            )}

            {preset.status === 'ready' && presetRole !== undefined && (
              <p className="state__line" data-testid="role-preset-state">
                {`Роль в манифесте: ${skillsCount(presetRole.skill_count)} в раскладке`}
              </p>
            )}

            {preset.status === 'error' && (
              <div className="state__error">
                <p className="error" data-testid="role-preset-error" role="alert">
                  {preset.errorText}
                </p>
                <button
                  className="btn"
                  type="button"
                  data-testid="role-preset-retry"
                  onClick={() => void loadPreset()}
                >
                  Повторить
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__head">
            <h2 className="card__title">Скиллы роли</h2>
            <div className="card__tools">
              <span className="card__meta">
                {skillsReady === null ? '' : skillsCount(skillsReady.length)}
              </span>
              <button
                className="btn"
                type="button"
                data-testid="skill-create"
                onClick={() => setDialog({ kind: 'skill-create' })}
                disabled={skillsReady === null}
              >
                Добавить скилл
              </button>
            </div>
          </div>

          {skills.status === 'loading' && (
            <div className="card__body">
              <p className="state__line" data-testid="skills-state">
                Загрузка…
              </p>
            </div>
          )}

          {skills.status === 'error' && (
            <div className="card__body">
              <div className="state__error">
                <p className="error" data-testid="skills-error" role="alert">
                  {skills.errorText}
                </p>
                <button
                  className="btn"
                  type="button"
                  data-testid="skills-retry"
                  onClick={() => void loadSkills()}
                >
                  Повторить
                </button>
              </div>
            </div>
          )}

          {skillsReady !== null && skillsReady.length === 0 && (
            <div className="card__body">
              <p className="state__line" data-testid="skills-empty">
                Пока нет скиллов
              </p>
              <p className="state__hint">
                Нажмите «Добавить скилл», и он появится в файлах пресета этой роли.
              </p>
            </div>
          )}

          {skillsReady !== null && skillsReady.length > 0 && (
            <>
              <div className="table__head table__head--skill" role="presentation">
                <span>Название</span>
                <span>Разделы</span>
                <span>Обновлён</span>
                <span>Действия</span>
              </div>
              <ul className="table__body" data-testid="skills-list">
                {skillsReady.map((skill) => (
                  <li
                    className="row row--skill row--clickable"
                    key={skill.id}
                    data-testid="skill-item"
                    onClick={() => setDialog({ kind: 'skill-edit', skill })}
                  >
                    <div className="row__main">
                      <p className="row__name">
                        {/* Название — кнопка: до строки можно дойти клавиатурой, Enter и
                            Space открывают то же окно, что клик по строке. */}
                        <button
                          className="row__name--button"
                          type="button"
                          data-testid="skill-item-open"
                        >
                          {skill.title}
                        </button>
                      </p>
                      <p className="row__desc row__repo" data-testid="skill-item-code">
                        {skill.code}
                      </p>
                    </div>
                    <p className="row__date" data-testid="skill-item-sections">
                      {sectionsCount(skill.sections.length)}
                    </p>
                    <p className="row__date">{formatDate(skill.updated_at)}</p>
                    <div
                      className="row__actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        className="btn"
                        type="button"
                        data-testid="skill-edit"
                        onClick={() => setDialog({ kind: 'skill-edit', skill })}
                      >
                        Изменить
                      </button>
                      <button
                        className="btn btn--danger"
                        type="button"
                        data-testid="skill-delete"
                        onClick={() => setDialog({ kind: 'skill-delete', skill })}
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

      {dialog !== null && dialog.kind === 'role-edit' && (
        <RoleFormDialog
          mode="edit"
          role={role}
          onClose={closeDialog}
          onSaved={(saved) => {
            closeDialog();
            onRoleSaved(saved);
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'role-delete' && (
        <ConfirmDialog
          testId="role-delete-confirm"
          title="Удалить роль?"
          text={`Роль «${role.title}» исчезнет из списка, а её скиллы перестанут раскладываться. Восстановить роль через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteRole(role.id);
            onRoleDeleted();
          }}
          onClose={closeDialog}
        />
      )}

      {dialog !== null && dialog.kind === 'skill-create' && (
        <SkillFormDialog
          roleId={role.id}
          mode="create"
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void loadSkills();
            onRoleSaved(role);
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'skill-edit' && (
        <SkillFormDialog
          roleId={role.id}
          mode="edit"
          skill={dialog.skill}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void loadSkills();
            onRoleSaved(role);
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'skill-delete' && (
        <ConfirmDialog
          testId="skill-delete-confirm"
          title="Удалить скилл?"
          text={`Скилл «${dialog.skill.title}» исчезнет из роли и из раскладки, когда harness сверит ревизию. Восстановить его через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteSkill(dialog.skill.id);
            closeDialog();
            void loadSkills();
            onRoleSaved(role);
          }}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
