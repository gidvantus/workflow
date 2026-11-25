/**
 * Одно окно на создание и правку агента (`mode`).
 *
 * Код вводится только при создании: по нему приходит машинный heartbeat, и смена кода
 * молча отвязала бы работающего агента от тегов. При правке поле показано, но изменить его
 * нельзя, а в тело `PATCH` `code` не попадает вовсе (сервер отвечает «Код агента не
 * меняется»).
 *
 * Среда выбирается карточками `.kind-option`, а не выпадающим списком: вариантов три, и
 * пояснение у каждого важнее компактности. Экран отправляет только тело запроса, текст
 * отказа рисуется дословно из `detail`.
 */

import { useId, useState, type FormEvent } from 'react';

import {
  RUNTIME_OPTIONS,
  RUNTIME_TITLES,
  createAgent,
  updateAgent,
  type Agent,
  type AgentRuntime,
} from '../api/agents';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import Dialog from './Dialog';

const CODE_MAX_LENGTH = 50;
const TITLE_MAX_LENGTH = 100;

/** Пояснение под карточкой среды: что значит среда для конвейера. */
const RUNTIME_NOTES: Record<AgentRuntime, string> = {
  dsh: 'Сам диспетчер. Тег с этим агентом остаётся за диспетчером.',
  opencode: 'Гость opencode: ступень ждёт его, диспетчер её не берёт.',
  http: 'Внешний агент через HTTP: получает ступень и сообщает состояние сам.',
};

type AgentFormDialogProps = {
  mode: 'create' | 'edit';
  /** Текущие значения при правке. */
  agent?: Agent;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, список перечитывается. */
  onSaved: (agent: Agent) => void;
};

type InvalidField = 'code' | 'title' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('код')) {
    return 'code';
  }
  if (lower.includes('назван')) {
    return 'title';
  }
  return null;
}

export default function AgentFormDialog({
  mode,
  agent,
  onClose,
  onSaved,
}: AgentFormDialogProps): JSX.Element {
  const formId = useId();
  const runtimeLabelId = useId();
  const editing = mode === 'edit' && agent !== undefined;
  const [code, setCode] = useState(agent?.code ?? '');
  const [title, setTitle] = useState(agent?.title ?? '');
  const [runtime, setRuntime] = useState<AgentRuntime>(agent?.runtime ?? 'http');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
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
        editing && agent !== undefined
          ? await updateAgent(agent.id, { title, runtime, enabled })
          : await createAgent({ code, title, runtime, enabled });
      onSaved(saved);
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="agent-form"
      title={editing ? 'Изменить агента' : 'Новый агент'}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="agent-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="agent-form-submit"
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
            data-testid="agent-form-code"
          />
          <span className="field__hint">
            {editing
              ? 'Код не меняется: по нему приходит heartbeat.'
              : 'Латиница, цифры и дефис. По коду агент сообщает состояние и не меняет его.'}
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
            data-testid="agent-form-title"
          />
        </div>

        <div className="field">
          <span className="field__label" id={runtimeLabelId}>
            Среда
          </span>
          <div
            className="kind-options"
            role="radiogroup"
            aria-labelledby={runtimeLabelId}
            data-testid="agent-form-runtime"
          >
            {RUNTIME_OPTIONS.map((option) => (
              <label
                key={option}
                className={option === runtime ? 'kind-option kind-option--selected' : 'kind-option'}
              >
                <input
                  type="radio"
                  name={`${formId}-runtime`}
                  value={option}
                  checked={option === runtime}
                  data-testid={`agent-form-runtime-${option}`}
                  onChange={() => setRuntime(option)}
                />
                <span className="kind-option__title">{RUNTIME_TITLES[option]}</span>
                <span className="kind-option__note">{RUNTIME_NOTES[option]}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="checkbox checkbox--field">
          <input
            type="checkbox"
            checked={enabled}
            data-testid="agent-form-enabled"
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            Включён
            <span className="field__hint">
              Выключенный агент возвращает свои ступени диспетчеру.
            </span>
          </span>
        </label>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="agent-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
