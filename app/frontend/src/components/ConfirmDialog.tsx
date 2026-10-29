/**
 * Подтверждение мягкого удаления проекта.
 *
 * Удаление необратимо через интерфейс: строка исчезает из списка и остаётся в базе
 * с отметкой, восстановить её экранами приложения нельзя — об этом прямо говорит текст
 * окна. Отказ сервера показывается здесь же дословно из `detail`.
 */

import { useId, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT, deleteProject, type Project } from '../api/projects';
import Dialog from './Dialog';

type ConfirmDialogProps = {
  project: Project;
  onClose: () => void;
  /** Успешное удаление: окно закрывается, список перечитывается с сервера. */
  onDeleted: () => void;
};

export default function ConfirmDialog({
  project,
  onClose,
  onDeleted,
}: ConfirmDialogProps): JSX.Element {
  const textId = useId();
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      await deleteProject(project.id);
      onDeleted();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="project-delete-confirm"
      title="Удалить проект?"
      describedBy={textId}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="project-delete-confirm-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--danger"
            type="button"
            data-testid="project-delete-confirm-submit"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? 'Удаляю…' : 'Удалить'}
          </button>
        </>
      }
    >
      <p className="dialog__text" id={textId}>
        Проект «{project.name}» исчезнет из списка. Восстановить его через интерфейс нельзя.
      </p>

      {errorText !== null && (
        <p className="error" data-testid="project-delete-confirm-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
