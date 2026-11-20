/**
 * Одно окно на создание и правку роли (`mode`).
 *
 * Код роли вводится только при создании: это имя каталога пресета DSH, и после сохранения
 * он не меняется — при правке поле показано, но изменить его нельзя, а в тело `PATCH`
 * `code` не попадает вовсе (сервер отвечает на него отказом «Код роли не меняется»).
 *
 * Экран отправляет только тело запроса; текст отказа рисуется дословно из `detail`, своих
 * формулировок здесь нет. Пока запрос в полёте, кнопки неактивны и окно не закрывается.
 * Пределы длины полей стоят на самих полях (`maxLength`): сервер отказывает тем же
 * пределом `422`-м, но длинный текст человек обычно видит, уже отправив форму.
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { createRole, updateRole, type Role } from '../api/roles';
import Dialog from './Dialog';

/** Пределы полей роли — те же, что у валидаторов `app/api/roles.py`. */
const CODE_MAX_LENGTH = 50;
const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 2000;

type RoleFormDialogProps = {
  mode: 'create' | 'edit';
  /** Текущие значения при правке. */
  role?: Role;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, вызывающая сторона обновляет данные. */
  onSaved: (role: Role) => void;
};

/** Поле, к которому относится текст отказа — нужно только для `aria-invalid`. */
type InvalidField = 'code' | 'title' | 'description' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('код')) {
    return 'code';
  }
  if (lower.includes('назван')) {
    return 'title';
  }
  if (lower.includes('описан')) {
    return 'description';
  }
  return null;
}

export default function RoleFormDialog({
  mode,
  role,
  onClose,
  onSaved,
}: RoleFormDialogProps): JSX.Element {
  const formId = useId();
  const editing = mode === 'edit' && role !== undefined;
  const [code, setCode] = useState(role?.code ?? '');
  const [title, setTitle] = useState(role?.title ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const invalidField = errorText === null ? null : invalidFieldFor(errorText);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const saved =
        editing && role !== undefined
          ? await updateRole(role.id, { title, description })
          : await createRole({ code, title, description });
      onSaved(saved);
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="role-form"
      title={editing ? 'Изменить роль' : 'Новая роль'}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="role-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="role-form-submit"
            disabled={busy}
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <form className="dialog__form" id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <div className="field field--machine">
          <label className="field__label" htmlFor={`${formId}-code`}>
            Код
          </label>
          <input
            className="field__input"
            id={`${formId}-code`}
            type="text"
            autoComplete="off"
            maxLength={CODE_MAX_LENGTH}
            value={code}
            readOnly={editing}
            aria-invalid={invalidField === 'code'}
            onChange={(event) => setCode(event.target.value)}
            data-testid="role-form-code"
          />
          <span className="field__hint">
            {editing
              ? 'Код не меняется: это имя каталога пресета DSH.'
              : 'Латиница, цифры и дефис. Код станет именем каталога пресета DSH и не изменится.'}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-title`}>
            Название
          </label>
          <input
            className="field__input"
            id={`${formId}-title`}
            type="text"
            autoComplete="off"
            maxLength={TITLE_MAX_LENGTH}
            value={title}
            aria-invalid={invalidField === 'title'}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="role-form-title"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-description`}>
            Описание
          </label>
          <textarea
            className="field__textarea"
            id={`${formId}-description`}
            rows={3}
            maxLength={DESCRIPTION_MAX_LENGTH}
            value={description}
            aria-invalid={invalidField === 'description'}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="role-form-description"
          />
          <span className="field__hint">Описание попадает в «preset.yml» роли.</span>
        </div>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="role-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
