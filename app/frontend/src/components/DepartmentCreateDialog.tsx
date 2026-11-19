/**
 * Окно создания отдела: единственное поле — вид из справочника.
 *
 * Имя отдела — это название вида на момент создания, поэтому вводить его нечего: выбор
 * вида задаёт и имя, и набор полей страницы правки. Справочник читается с сервера
 * (`GET /api/department-kinds`), кодов и названий фронт не зашивает.
 *
 * Второго отдела того же вида в проекте быть не может — имя занято, сервер отвечает
 * `409` и присылает текст. Он рисуется дословно и помечает набор вариантов
 * `aria-invalid`: отказ относится к выбору, а не к отдельному варианту. Пока справочник
 * не ответил, «Создать» неактивна, а «Отмена» работает всегда — окно должно закрываться.
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { createDepartment, listDepartmentKinds, type DepartmentKind } from '../api/departments';
import Dialog from './Dialog';

/**
 * Пояснение под вариантом выбора: что именно даёт вид. Это формулировка фронта, а не
 * контракт, поэтому для кода, которого здесь нет (третий вид из новой ревизии), варианта
 * не ломаем — пояснения просто не будет.
 */
const KIND_NOTES: Record<string, string> = {
  development:
    'Время работы, роли, шесть адресов отдела, лимит возврата и уведомления',
  marketing: 'Репозиторий, ветка и два рабочих пространства',
};

/** Состояние справочника видов: он либо грузится, либо прочитан, либо отказал. */
type KindsState =
  | { status: 'loading' }
  | { status: 'ready'; kinds: DepartmentKind[] }
  | { status: 'error'; errorText: string };

type DepartmentCreateDialogProps = {
  /** Проект, в котором создаётся отдел: путь ручки вложен в него. */
  projectId: number;
  onClose: () => void;
  /** Успешное создание: окно закрывается, список отделов перечитывается с сервера. */
  onSaved: () => void;
};

export default function DepartmentCreateDialog({
  projectId,
  onClose,
  onSaved,
}: DepartmentCreateDialogProps): JSX.Element {
  const formId = useId();
  const textId = useId();
  const kindsLabelId = useId();
  const [kinds, setKinds] = useState<KindsState>({ status: 'loading' });
  const [kindId, setKindId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  /** Справочник читается заново по «Повторить»: отказ не запоминается навсегда. */
  const loadKinds = useCallback(async (): Promise<void> => {
    setKinds({ status: 'loading' });
    try {
      const loaded = await listDepartmentKinds();
      setKinds({ status: 'ready', kinds: loaded });
    } catch (error) {
      setKinds({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void loadKinds();
  }, [loadKinds]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || kindId === null) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      await createDepartment(projectId, kindId);
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = kinds.status === 'ready' && kindId !== null && !busy;

  return (
    <Dialog
      testId="department-create-dialog"
      title="Новый отдел"
      describedBy={textId}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="department-create-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="department-create-submit"
            disabled={!canSubmit}
          >
            {busy ? 'Создаю…' : 'Создать'}
          </button>
        </>
      }
    >
      <form className="dialog__form" id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <p className="dialog__text" id={textId}>
          Отдел заводится видом: название отдела станет названием вида, а набор полей
          страницы вид и задаст.
        </p>

        <div className="field">
          <span className="field__label" id={kindsLabelId}>
            Вид отдела
          </span>

          {kinds.status === 'loading' && (
            <p className="state__line" aria-live="polite">
              Загрузка видов…
            </p>
          )}

          {kinds.status === 'error' && (
            <div className="state__error">
              <p className="error" data-testid="department-create-kinds-error" role="alert">
                {kinds.errorText}
              </p>
              <button
                className="btn"
                type="button"
                data-testid="department-create-kinds-retry"
                onClick={() => void loadKinds()}
              >
                Повторить
              </button>
            </div>
          )}

          {kinds.status === 'ready' && (
            <div
              className="kind-options"
              role="radiogroup"
              aria-labelledby={kindsLabelId}
              aria-invalid={errorText !== null}
            >
              {kinds.kinds.map((kind) => {
                const selected = kind.id === kindId;
                const note = KIND_NOTES[kind.code];
                return (
                  <label
                    key={kind.id}
                    className={selected ? 'kind-option kind-option--selected' : 'kind-option'}
                  >
                    <input
                      type="radio"
                      name={formId}
                      value={kind.id}
                      checked={selected}
                      data-testid={`department-create-kind-${kind.code}`}
                      onChange={() => {
                        setKindId(kind.id);
                        setErrorText(null);
                      }}
                    />
                    <span className="kind-option__title">{kind.title}</span>
                    {note !== undefined && <span className="kind-option__note">{note}</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {errorText !== null && (
          <p className="error" data-testid="department-create-error" role="alert">
            {errorText}
          </p>
        )}
      </form>
    </Dialog>
  );
}
