/**
 * Одно окно на создание и правку проекта (`mode`).
 *
 * Экран отправляет только тело запроса; текст отказа рисуется здесь же дословно из
 * `detail`, своих формулировок нет. Пока запрос в полёте, кнопки неактивны и окно
 * не закрывается — иначе исход сохранения был бы не виден пользователю.
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { createProject, updateProject, type Project } from '../api/projects';
import Dialog from './Dialog';

type ProjectFormDialogProps = {
  mode: 'create' | 'edit';
  /** Текущее значение полей при правке. */
  project?: Project;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, список перечитывается с сервера. */
  onSaved: () => void;
};

/** Поле, к которому относится текст отказа — нужно только для `aria-invalid`. */
type InvalidField = 'name' | 'description' | 'repo' | 'code' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('код проекта')) {
    return 'code';
  }
  if (lower.includes('назван')) {
    return 'name';
  }
  if (lower.includes('описан')) {
    return 'description';
  }
  if (lower.includes('репозитор') || lower.includes('ссылк')) {
    return 'repo';
  }
  return null;
}

/** Подсказка под полем кода: что это и почему после сохранения не меняется. */
const CODE_HINT =
  'Служебный идентификатор в реестре отдела; латиница, цифры, дефис; после сохранения не меняется';

export default function ProjectFormDialog({
  mode,
  project,
  onClose,
  onSaved,
}: ProjectFormDialogProps): JSX.Element {
  const formId = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [repoUrl, setRepoUrl] = useState(project?.repo_url ?? '');
  const [code, setCode] = useState(project?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Заданный код неизменяем: смена кода сменила бы `id` проекта в реестре отдела.
  // Поэтому в правке у проекта с кодом поле только для чтения, и `code` в тело
  // запроса не попадает вовсе — иначе `PATCH` вернул бы «Код проекта не меняется».
  const codeLocked = mode === 'edit' && (project?.code ?? '') !== '';

  const invalidField = errorText === null ? null : invalidFieldFor(errorText);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    const input = { name, description, repo_url: repoUrl, code: codeLocked ? undefined : code };
    try {
      if (mode === 'edit' && project !== undefined) {
        await updateProject(project.id, input);
      } else {
        await createProject(input);
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
      testId="project-form"
      title={mode === 'create' ? 'Новый проект' : 'Изменить проект'}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="project-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="project-form-submit"
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
            data-testid="project-form-name"
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
            data-testid="project-form-description"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-repo`}>
            Адрес репозитория
          </label>
          <input
            className="field__input"
            id={`${formId}-repo`}
            type="text"
            autoComplete="off"
            value={repoUrl}
            aria-invalid={invalidField === 'repo'}
            onChange={(event) => setRepoUrl(event.target.value)}
            data-testid="project-form-repo"
          />
          <span className="field__hint">Ссылка или вид owner/repo</span>
        </div>

        {/* Код проекта: при создании необязателен, в правке у заданного кода только
            для чтения. Пустое значение — «код не задан»: проект остаётся в реестре
            под числовым `id`, а заполнить код можно один раз. */}
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-code`}>
            Код проекта
          </label>
          <input
            className="field__input"
            id={`${formId}-code`}
            type="text"
            autoComplete="off"
            value={code}
            readOnly={codeLocked}
            aria-invalid={invalidField === 'code'}
            onChange={(event) => setCode(event.target.value)}
            data-testid="project-form-code"
          />
          <span className="field__hint" data-testid="project-form-code-hint">
            {codeLocked ? 'Код не меняется' : CODE_HINT}
          </span>
        </div>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="project-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
