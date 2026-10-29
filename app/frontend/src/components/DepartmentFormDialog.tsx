/**
 * Одно окно на создание и правку отдела (`mode`).
 *
 * Поля: «Название», время работы «с»/«по» двумя `<input type="time">` и набор ролей
 * чекбоксами из справочника `GET /api/roles`. Названия и коды ролей фронт не зашивает —
 * их отдаёт сервер; `code` нужен только для `data-testid`.
 *
 * Время приходит с сервера строкой `"ЧЧ:ММ"` и подставляется в поле как есть, без
 * собственного форматирования: переход через полночь (`end` раньше `start`) — штатный
 * случай, и «поправлять» его фронт не должен.
 *
 * Пока роли грузятся или не загрузились, «Сохранить» неактивна: отдел без ролей сервер
 * не примет, а выбор из пустого списка — это не выбор. Текст отказа рисуется здесь же
 * дословно из `detail`, своих формулировок нет.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  createDepartment,
  listRoles,
  updateDepartment,
  type Department,
  type Role,
} from '../api/departments';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import Dialog from './Dialog';

type DepartmentFormDialogProps = {
  mode: 'create' | 'edit';
  /** Текущее значение полей при правке. */
  department?: Department;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, список перечитывается с сервера. */
  onSaved: () => void;
};

/** Справочник ролей: грузится, готов или не загрузился. */
type RolesState =
  | { status: 'loading' }
  | { status: 'ready'; roles: Role[] }
  | { status: 'error'; errorText: string };

/** Поле, к которому относится текст отказа — нужно только для `aria-invalid`. */
type InvalidField = 'name' | 'time' | 'roles' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('назван')) {
    return 'name';
  }
  if (lower.includes('врем') || lower.includes('начало')) {
    return 'time';
  }
  if (lower.includes('роль') || lower.includes('роли')) {
    return 'roles';
  }
  return null;
}

export default function DepartmentFormDialog({
  mode,
  department,
  onClose,
  onSaved,
}: DepartmentFormDialogProps): JSX.Element {
  const [name, setName] = useState(department?.name ?? '');
  const [startTime, setStartTime] = useState(department?.start_time ?? '');
  const [endTime, setEndTime] = useState(department?.end_time ?? '');
  const [selected, setSelected] = useState<number[]>(
    department?.roles.map((role) => role.id) ?? [],
  );
  const [roles, setRoles] = useState<RolesState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadRoles = useCallback(async (): Promise<void> => {
    setRoles({ status: 'loading' });
    try {
      setRoles({ status: 'ready', roles: await listRoles() });
    } catch (error) {
      setRoles({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const invalidField = errorText === null ? null : invalidFieldFor(errorText);
  const rolesReady = roles.status === 'ready';
  const inert = busy || !rolesReady;

  function toggleRole(id: number): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inert) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    const input = {
      name,
      start_time: startTime,
      end_time: endTime,
      // Порядок набора не важен: сервер схлопывает повторы и отдаёт роли по `id`.
      role_ids: [...selected].sort((left, right) => left - right),
    };
    try {
      if (mode === 'edit' && department !== undefined) {
        await updateDepartment(department.id, input);
      } else {
        await createDepartment(input);
      }
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="department-form"
      title={mode === 'create' ? 'Новый отдел' : 'Изменить отдел'}
      onClose={onClose}
      busy={busy}
      wide
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="department-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form="department-form"
            data-testid="department-form-submit"
            disabled={inert}
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <form
        className="dialog__form"
        id="department-form"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="field">
          <label className="field__label" htmlFor="department-form-name">
            Название
          </label>
          <input
            className="field__input"
            id="department-form-name"
            type="text"
            autoComplete="off"
            value={name}
            aria-invalid={invalidField === 'name'}
            onChange={(event) => setName(event.target.value)}
            data-testid="department-form-name"
          />
        </div>

        <div className="time-block">
          <div className="time-row">
            <div className="field">
              <label className="field__label" htmlFor="department-form-start">
                Время работы с
              </label>
              <input
                className="field__input"
                id="department-form-start"
                type="time"
                value={startTime}
                aria-invalid={invalidField === 'time'}
                onChange={(event) => setStartTime(event.target.value)}
                data-testid="department-form-start"
              />
            </div>
            <span className="time-row__dash" aria-hidden="true">
              —
            </span>
            <div className="field">
              <label className="field__label" htmlFor="department-form-end">
                по
              </label>
              <input
                className="field__input"
                id="department-form-end"
                type="time"
                value={endTime}
                aria-invalid={invalidField === 'time'}
                onChange={(event) => setEndTime(event.target.value)}
                data-testid="department-form-end"
              />
            </div>
          </div>
          <p className="field__hint">
            Если конец раньше начала, отдел работает через полночь.
          </p>
        </div>

        <div className="roles">
          <div className="roles__head">
            <span className="roles__title" id="department-form-roles">
              Роли
            </span>
            {rolesReady && (
              <span className="chip">
                Отмечено {selected.length} из {roles.roles.length}
              </span>
            )}
          </div>

          {roles.status === 'loading' && (
            <p className="state__line" aria-live="polite">
              Загрузка ролей…
            </p>
          )}

          {roles.status === 'error' && (
            <div className="state__error">
              <p className="error" data-testid="department-form-roles-error" role="alert">
                {roles.errorText}
              </p>
              <button
                className="btn"
                type="button"
                data-testid="department-form-roles-retry"
                onClick={() => void loadRoles()}
              >
                Повторить
              </button>
            </div>
          )}

          {roles.status === 'ready' && (
            <div
              className="roles__grid"
              role="group"
              aria-labelledby="department-form-roles"
              aria-invalid={invalidField === 'roles'}
            >
              {roles.roles.map((role) => (
                <label className="checkbox" key={role.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                    data-testid={`department-form-role-${role.code}`}
                  />
                  <span>{role.title}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="department-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
