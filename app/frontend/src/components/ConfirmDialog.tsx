/**
 * Подтверждение мягкого удаления — общее окно для «Проектов» и «Отделов».
 *
 * Сам текст подтверждения и вызов API остаются у вызывающей стороны: экран знает, что
 * именно исчезает и какой ручкой это удаляется, а окно отвечает только за поведение —
 * занятость кнопок, отказ сервера дословно из `detail` и закрытие после успеха.
 *
 * Удаление необратимо через интерфейс: строка исчезает из списка и остаётся в базе
 * с отметкой, восстановить её экранами приложения нельзя — об этом прямо говорит текст
 * окна, который передаёт вызывающая сторона.
 */

import { useId, useState, type ReactNode } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import Dialog from './Dialog';

type ConfirmDialogProps = {
  /** `data-testid` окна по контракту; ошибка получает `-error` к этому же имени. */
  testId: string;
  title: string;
  /** Текст подтверждения: что исчезнет и что восстановить нельзя. */
  text: ReactNode;
  /** Подпись основной кнопки в покое, например «Удалить». */
  submitLabel: string;
  /** Подпись основной кнопки, пока запрос в полёте, например «Удаляю…». */
  busyLabel: string;
  /** Запрос удаления; успех закрывает окно силами вызывающей стороны. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
};

export default function ConfirmDialog({
  testId,
  title,
  text,
  submitLabel,
  busyLabel,
  onConfirm,
  onClose,
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
      await onConfirm();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId={testId}
      title={title}
      describedBy={textId}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid={`${testId}-cancel`}
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--danger"
            type="button"
            data-testid={`${testId}-submit`}
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? busyLabel : submitLabel}
          </button>
        </>
      }
    >
      <p className="dialog__text" id={textId}>
        {text}
      </p>

      {errorText !== null && (
        <p className="error" data-testid={`${testId}-error`} role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
