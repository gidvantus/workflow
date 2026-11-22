/**
 * Вкладка «Процесс»: таблица переходов отдела, по которой диспетчер исполняет конвейер.
 *
 * Экран — редактор одного документа: 14 имён меток и строки ступеней. Имена меток и
 * ступени сохраняются **вместе**: таблица ссылается на ключи меток, поэтому половина
 * документа — документ, который никто не проверял. Отсюда одна пара `GET`/`PUT` и одна
 * кнопка «Сохранить» на весь экран.
 *
 * **Своих значений экран не придумывает.** Список стражей и ролей приходит с сервера тем
 * же ответом, что и документ; тексты отказов `422` показываются дословно, без
 * переписывания. Порядок ступеней — колонка `priority`: экран сортирует строки по ней,
 * чтобы таблица совпадала с порядком исполнения.
 *
 * **Метки в ячейке — ключи, а не имена.** В строке ступени видно ровно то, что уходит в
 * документ (`dev`, `areaBackend`), поэтому расхождение со ступенью видно глазами, а
 * человеческие имена живут в блоке имён ниже. Правятся метки списком галочек под строкой:
 * выбор одной метки не сбрасывает остальные, а `select multiple` делал именно это.
 *
 * **Сброс к умолчанию не ходит на сервер.** Документ по умолчанию приезжает в `defaults`
 * первого `GET`, кнопка заполняет им форму и оставляет документ «не сохранённым»: пока
 * человек не нажал «Сохранить», отдел работает по прежнему процессу, а `GET` покажет
 * именно сохранённое. Так «Сбросить» — это правка формы, а не тихая запись в реестр.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import {
  PROCESS_LABEL_KEYS,
  getProcess,
  saveProcess,
  type ProcessDocument,
  type ProcessGuard,
  type ProcessLabelKey,
  type ProcessStep,
  type ProcessStepKind,
  type ProcessStepRole,
} from '../api/process';

type ProcessState =
  | { status: 'loading' }
  | { status: 'ready'; document: ProcessDocument; defaults: ProcessDocument; roles: string[]; guards: ProcessGuard[] }
  | { status: 'error'; text: string };

/** Вид ступени в подписи выпадающего списка: срок в контракте — `session`/`route`/`auto`. */
const KIND_TITLES: Record<ProcessStepKind, string> = {
  session: 'сессия',
  route: 'маршрут',
  auto: 'метки',
};

/** Резолверы роли: их выбирает диспетчер, а не документ, но подпись нужна человеку. */
const RESOLVER_TITLES: Record<string, string> = {
  'by-area': 'по половине работы',
  'by-findings': 'по замечаниям',
};

/** Подписи ключей меток: ключ контракта — `dev`, подпись — по-русски. */
const LABEL_TITLES: Record<ProcessLabelKey, string> = {
  dev: 'К разработке',
  frontend: 'Фронтенд',
  areaBackend: 'Половина: бэкенд',
  areaFrontend: 'Половина: фронтенд',
  areaFullstack: 'Половина: полный стек',
  phaseFrontend: 'Фаза фронтенда',
  mockup: 'Нужен макет',
  mockupsReady: 'Макет готов',
  progress: 'В работе',
  review: 'На код-ревью',
  test: 'На тестирование',
  ok: 'Проверено',
  failed: 'Тест не прошёл',
  merged: 'Слито',
};

/** Четыре ячейки строки, которые правятся списком галочек. */
type PickerField = 'when' | 'unless' | 'put' | 'drop';

const CELL_TITLES: Record<PickerField, string> = {
  when: 'Входящие метки',
  unless: 'Кроме',
  put: 'Ставит',
  drop: 'Снимает',
};

const PICKER_TITLES: Record<PickerField, string> = {
  when: 'Входящие метки — тикет должен нести все',
  unless: 'Кроме — ни одной из этих',
  put: 'Ставит — эти метки появятся у тикета',
  drop: 'Снимает — эти метки уйдут у тикета',
};

/**
 * Сохранённость формы: что показать в строке состояния над таблицей.
 *
 * `saved` с `revision: null` — отдельное состояние, а не «не сохранено»: `GET` ревизию не
 * отдаёт по контракту, поэтому после перезагрузки страницы про сохранённый документ
 * известно только то, что он сохранён.
 */
type SavedState =
  | { kind: 'defaults' }
  | { kind: 'reset' }
  | { kind: 'dirty' }
  | { kind: 'saved'; revision: number | null };

function savedText(saved: SavedState): string {
  switch (saved.kind) {
    case 'defaults':
      return 'Умолчания, не сохранено';
    case 'reset':
      return 'Заполнено умолчаниями — не сохранено';
    case 'dirty':
      return 'Не сохранено';
    case 'saved':
      return saved.revision === null ? 'Сохранено' : `Сохранено: ревизия ${saved.revision}`;
  }
}

function pickerHint(field: PickerField, count: number): string {
  if (count === 0) {
    return field === 'when'
      ? 'Пусто — ступень не возьмёт ни одного тикета.'
      : 'Пусто — ступень ничего не меняет.';
  }
  if (field === 'when') {
    return `Выбрано ${count}: ступень возьмёт тикет со всеми этими метками.`;
  }
  return `Выбрано ${count}.`;
}

function sortSteps(document: ProcessDocument): ProcessDocument {
  return { ...document, steps: [...document.steps].sort((left, right) => left.priority - right.priority) };
}

function withStep(document: ProcessDocument, index: number, patch: Partial<ProcessStep>): ProcessDocument {
  return {
    ...document,
    steps: document.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)),
  };
}

/** Метки в наборе: порядок канонический, чтобы ячейка не переставляла ключи местами. */
function toggleKey(keys: ProcessLabelKey[], key: ProcessLabelKey, on: boolean): ProcessLabelKey[] {
  const next = on ? [...keys, key] : keys.filter((current) => current !== key);
  return PROCESS_LABEL_KEYS.filter((current) => next.includes(current));
}

/** Список галочек под строкой: подписи — ключи документа, как и в самой ячейке. */
function LabelPicker({
  id,
  testId,
  field,
  value,
  onChange,
  onClose,
}: {
  id: string;
  testId: string;
  field: PickerField;
  value: ProcessLabelKey[];
  onChange: (keys: ProcessLabelKey[]) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="proc-picker" id={id} role="group" aria-label={PICKER_TITLES[field]}>
      <p className="proc-picker__title">{PICKER_TITLES[field]}</p>
      <div className="proc-picker__grid">
        {PROCESS_LABEL_KEYS.map((key) => (
          <label className="checkbox" key={key}>
            <input
              type="checkbox"
              data-testid={`${testId}-${key}`}
              checked={value.includes(key)}
              onChange={(event) => onChange(toggleKey(value, key, event.target.checked))}
            />
            <span>{key}</span>
          </label>
        ))}
      </div>
      <div className="proc-picker__foot">
        <p className="proc-picker__hint">{pickerHint(field, value.length)}</p>
        <button className="btn" type="button" onClick={onClose}>
          Готово
        </button>
      </div>
    </div>
  );
}

/** Ячейка с метками: в покое это текст из ключей, нажатие раскрывает список галочек. */
function LabelCell({
  testId,
  field,
  step,
  value,
  open,
  panelId,
  onToggle,
}: {
  testId: string;
  field: PickerField;
  step: ProcessStep;
  value: ProcessLabelKey[];
  open: boolean;
  panelId: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <td className={`proc-cell proc-cell--${field}`}>
      <button
        className="proc-cell__pick"
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${CELL_TITLES[field]} ступени «${step.title}»`}
        onClick={onToggle}
      >
        {value.length === 0 ? (
          <span className="proc-cell__none">—</span>
        ) : (
          value.map((key) => (
            <span className="lbl" key={key}>
              {key}
            </span>
          ))
        )}
      </button>
    </td>
  );
}

export default function DepartmentProcess({ departmentId }: { departmentId: number }): JSX.Element {
  const [state, setState] = useState<ProcessState>({ status: 'loading' });
  const [document, setDocument] = useState<ProcessDocument | null>(null);
  const [saved, setSaved] = useState<SavedState>({ kind: 'defaults' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<{ stepId: string; field: PickerField } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    setError(null);
    try {
      const body = await getProcess(departmentId);
      // Своего процесса нет — форма заполняется умолчаниями: пустая таблица не даёт
      // человеку ничего, а умолчания — это то, что отдел исполняет прямо сейчас.
      const shown = body.document ?? body.defaults;
      setDocument(shown);
      setState({
        status: 'ready',
        document: shown,
        defaults: body.defaults,
        roles: body.roles,
        guards: body.guards,
      });
      // Сохранённый документ — «Сохранено», а не «не сохранено»: ревизию `GET` не отдаёт,
      // поэтому номер остаётся неизвестным до первого сохранения.
      setSaved(body.document === null ? { kind: 'defaults' } : { kind: 'saved', revision: null });
    } catch (failure) {
      const text = failure instanceof ApiError ? failure.message : UNREACHABLE_TEXT;
      setState({ status: 'error', text });
    }
  }, [departmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (next: ProcessDocument) => {
    setDocument(sortSteps(next));
    setSaved({ kind: 'dirty' });
  };

  const handleSave = async () => {
    if (document === null || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = await saveProcess(departmentId, document);
      setDocument(sortSteps(body.document));
      setSaved({ kind: 'saved', revision: body.revision > 0 ? body.revision : null });
    } catch (failure) {
      // Отказ висит до следующего сохранения, введённое не сбрасывается.
      setError(failure instanceof ApiError ? failure.message : UNREACHABLE_TEXT);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (state.status !== 'ready') {
      return;
    }
    setDocument(sortSteps(state.defaults));
    setSaved({ kind: 'reset' });
  };

  const togglePicker = (stepId: string, field: PickerField) => {
    setOpenPicker((current) =>
      current !== null && current.stepId === stepId && current.field === field ? null : { stepId, field },
    );
  };

  if (state.status === 'loading') {
    return (
      <p className="muted" data-testid="department-process">
        Загрузка…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <p className="error" data-testid="department-process" role="alert">
        {state.text}
      </p>
    );
  }
  if (document === null) {
    return <></>;
  }

  const { roles, guards } = state;
  const roleOptions: ProcessStepRole[] = [null, ...roles, 'by-area', 'by-findings'];

  return (
    <section className="card proc" data-testid="department-process" aria-label="Процесс отдела">
      <div className="card__head">
        <div>
          <h2 className="card__title">Ступени конвейера</h2>
          <p className="card__meta">
            Диспетчер проверяет таблицу раз в 5 минут и берёт первый подходящий тикет.
            Процесс сохранён в отделе — здесь, а не в коде.
          </p>
        </div>
      </div>

      {error !== null && (
        <p className="error proc-error" data-testid="process-error" role="alert">
          {error}
        </p>
      )}

      {document.steps.length === 0 && (
        <div className="proc-empty" data-testid="process-empty">
          <p className="proc-empty__title">Ступеней нет</p>
          <p className="proc-empty__hint">
            Диспетчер не возьмёт ни одного тикета, пока в таблице пусто. «Сбросить к
            умолчанию» вернёт 13 ступеней.
          </p>
        </div>
      )}

      {document.steps.length > 0 && (
        <div className="proc-table-wrap">
        <table className="proc-table">
          <thead>
            <tr>
              <th scope="col">Порядок</th>
              <th scope="col">Ступень</th>
              <th scope="col">Вид</th>
              <th scope="col">Входящие метки</th>
              <th scope="col">Кроме</th>
              <th scope="col">Ставит</th>
              <th scope="col">Снимает</th>
              <th scope="col">Страж</th>
              <th scope="col">Роль</th>
              <th scope="col">Включена</th>
            </tr>
          </thead>
          <tbody>
            {document.steps.map((step, index) => {
              const open = openPicker !== null && openPicker.stepId === step.id ? openPicker.field : null;
              const changeLabels = (field: PickerField, keys: ProcessLabelKey[]) => {
                const patch: Partial<ProcessStep> = {};
                patch[field] = keys;
                edit(withStep(document, index, patch));
              };
              return (
                <Fragment key={step.id}>
                  <tr
                    className={step.enabled ? 'proc-row' : 'proc-row proc-row--off'}
                    data-testid="process-step-row"
                    data-step-id={step.id}
                  >
                    <td>
                      <input
                        className="field__input proc-cell__input"
                        type="number"
                        min={1}
                        max={999}
                        aria-label={`Порядок ступени «${step.title}»`}
                        data-testid="process-step-priority"
                        value={step.priority}
                        onChange={(event) =>
                          edit(withStep(document, index, { priority: Number(event.target.value) || 0 }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="field__input"
                        aria-label={`Название ступени ${step.id}`}
                        data-testid="process-step-title"
                        value={step.title}
                        onChange={(event) => edit(withStep(document, index, { title: event.target.value }))}
                      />
                      <span className="proc-row__id">{step.id}</span>
                    </td>
                    <td>
                      <select
                        className="field__select"
                        aria-label={`Вид ступени «${step.title}»`}
                        data-testid="process-step-kind"
                        value={step.kind}
                        onChange={(event) =>
                          edit(withStep(document, index, { kind: event.target.value as ProcessStepKind }))
                        }
                      >
                        {(Object.keys(KIND_TITLES) as ProcessStepKind[]).map((kind) => (
                          <option key={kind} value={kind}>
                            {KIND_TITLES[kind]}
                          </option>
                        ))}
                      </select>
                    </td>
                    {(['when', 'unless', 'put', 'drop'] as PickerField[]).map((field) => (
                      <LabelCell
                        key={field}
                        testId={`process-step-${field}`}
                        field={field}
                        step={step}
                        value={step[field]}
                        open={open === field}
                        panelId={`process-picker-${step.id}-${field}`}
                        onToggle={() => togglePicker(step.id, field)}
                      />
                    ))}
                    <td>
                      <select
                        className="field__select"
                        aria-label={`Страж ступени «${step.title}»`}
                        data-testid="process-step-guard"
                        value={step.guard ?? ''}
                        onChange={(event) =>
                          edit(
                            withStep(document, index, {
                              guard: event.target.value === '' ? null : event.target.value,
                            }),
                          )
                        }
                      >
                        <option value="">— нет —</option>
                        {guards.map((guard) => (
                          <option key={guard.id} value={guard.id}>
                            {guard.title}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="field__select"
                        aria-label={`Роль ступени «${step.title}»`}
                        data-testid="process-step-role"
                        value={step.role ?? ''}
                        onChange={(event) =>
                          edit(
                            withStep(document, index, {
                              role: event.target.value === '' ? null : event.target.value,
                            }),
                          )
                        }
                      >
                        {roleOptions.map((role) => (
                          <option key={role ?? 'none'} value={role ?? ''}>
                            {role === null ? '— нет —' : (RESOLVER_TITLES[role] ?? role)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Ступень «${step.title}» включена`}
                        data-testid="process-step-enabled"
                        checked={step.enabled}
                        onChange={(event) =>
                          edit(withStep(document, index, { enabled: event.target.checked }))
                        }
                      />
                    </td>
                  </tr>
                  {open !== null && (
                    <tr className="proc-picker-row">
                      <td colSpan={10}>
                        <LabelPicker
                          id={`process-picker-${step.id}-${open}`}
                          testId={`process-step-${open}`}
                          field={open}
                          value={step[open]}
                          onChange={(keys) => changeLabels(open, keys)}
                          onClose={() => setOpenPicker(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      <div className="proc-labels form-section">
        <h3 className="proc-labels__title">Справочник лейблов</h3>
        <p className="muted">
          Слева ключ — то, что стоит в ступенях, справа имя лейбла на GitHub: переименовали
          лейбл — ступени не трогали.
        </p>
        <div className="proc-labels__grid">
          {PROCESS_LABEL_KEYS.map((key) => {
            const id = `${key}-name`;
            return (
              <label className="proc-cell" key={key} htmlFor={id}>
                <span className="proc-cell__title">
                  {LABEL_TITLES[key]} · <code>{key}</code>
                </span>
                <input
                  className="field__input"
                  id={id}
                  data-testid={`process-label-${key}`}
                  value={document.labels[key]}
                  onChange={(event) =>
                    edit({ ...document, labels: { ...document.labels, [key]: event.target.value } })
                  }
                />
              </label>
            );
          })}
        </div>
      </div>

      <div className="form-foot">
        <p className="form-foot__note">
          Сохранение сразу пересобирает документ реестра: диспетчер увидит новую таблицу при
          следующей синхронизации, в пределах 5 минут.
        </p>
        <div className="form-actions">
          <p className="proc-saved" data-testid="process-saved" aria-live="polite">
            {savedText(saved)}
          </p>
          <button
            className="btn"
            type="button"
            data-testid="process-reset"
            onClick={handleReset}
            disabled={saving}
          >
            Сбросить к умолчанию
          </button>
          <button
            className="btn btn--dark"
            type="button"
            data-testid="process-save"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </section>
  );
}
