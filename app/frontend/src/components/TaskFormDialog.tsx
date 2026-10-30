/**
 * Окно создания задачи: «Название», «Описание» и «Стоимость».
 *
 * Стоимость — необязательное поле. Пустое или состоящее из пробелов значение уходит
 * как `cost: null` («стоимость не указана»), а не `""` и не `0`: ноль значит
 * «бесплатно», и подменять им «неизвестно» нельзя. Привычную запятую фронт переводит
 * в точку — сервер принимает обе записи, но в контракте запроса точка.
 *
 * Текст отказа рисуется дословно из `detail`, своих формулировок здесь нет. Пока
 * запрос в полёте, кнопки неактивны и окно не закрывается — иначе исход сохранения
 * был бы не виден пользователю. Правки задачи в приложении нет, поэтому `mode` не нужен.
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { createTask, type TaskInput } from '../api/tasks';
import Dialog from './Dialog';

type TaskFormDialogProps = {
  /** Проект, в который создаётся задача: путь ручки вложен в него. */
  projectId: number;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, список задач перечитывается с сервера. */
  onSaved: () => void;
};

/** Поле, к которому относится текст отказа — нужно только для `aria-invalid`. */
type InvalidField = 'name' | 'description' | 'cost' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('назван')) {
    return 'name';
  }
  if (lower.includes('описан')) {
    return 'description';
  }
  if (lower.includes('стоимост')) {
    return 'cost';
  }
  return null;
}

export default function TaskFormDialog({
  projectId,
  onClose,
  onSaved,
}: TaskFormDialogProps): JSX.Element {
  const formId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
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
    const trimmedCost = cost.trim();
    const input: TaskInput = {
      name,
      description,
      // Пустое поле — «не указана», а не ноль: `null` уходит в JSON как `null`.
      cost: trimmedCost === '' ? null : trimmedCost.replaceAll(',', '.'),
    };
    try {
      await createTask(projectId, input);
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="task-form"
      title="Новая задача"
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="task-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="task-form-submit"
            disabled={busy}
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <form className="dialog__form" id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-name`}>
            Название
          </label>
          <input
            className="field__input"
            id={`${formId}-name`}
            type="text"
            autoComplete="off"
            value={name}
            aria-invalid={invalidField === 'name'}
            onChange={(event) => setName(event.target.value)}
            data-testid="task-form-name"
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
            value={description}
            aria-invalid={invalidField === 'description'}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="task-form-description"
          />
        </div>

        <div className="field field--cost">
          <label className="field__label" htmlFor={`${formId}-cost`}>
            Стоимость
          </label>
          <input
            className="field__input"
            id={`${formId}-cost`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={cost}
            aria-invalid={invalidField === 'cost'}
            onChange={(event) => setCost(event.target.value)}
            data-testid="task-form-cost"
          />
          <span className="field__hint">Необязательно. В рублях, например 1250.00</span>
        </div>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="task-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
