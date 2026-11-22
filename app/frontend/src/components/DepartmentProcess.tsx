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
 * **Сброс к умолчанию не ходит на сервер.** Документ по умолчанию приезжает в `defaults`
 * первого `GET`, кнопка заполняет им форму и оставляет документ «не сохранённым»: пока
 * человек не нажал «Сохранить», отдел работает по прежнему процессу, а `GET` покажет
 * именно сохранённое. Так «Сбросить» — это правка формы, а не тихая запись в реестр.
 *
 * **Ступень — не форма, а строка таблицы.** Полей много и они короткие, поэтому строка
 * таблицы и есть редактор: порядок, название, вид, входящие метки, «кроме», что ставит и
 * снимает, страж, роль, включена. Ключи меток в мультивыборах подписаны именами из блока
 * имён: переименование метки сразу видно в ступенях.
 */

import { useCallback, useEffect, useId, useState } from 'react';

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

/** Сохранённость формы: что показать в строке состояния над таблицей. */
type SavedState =
  | { kind: 'defaults' }
  | { kind: 'clean'; revision: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'failed'; text: string };

function sortSteps(document: ProcessDocument): ProcessDocument {
  return { ...document, steps: [...document.steps].sort((left, right) => left.priority - right.priority) };
}

function withStep(document: ProcessDocument, index: number, patch: Partial<ProcessStep>): ProcessDocument {
  return {
    ...document,
    steps: document.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)),
  };
}

/** Мультивыбор ключей меток: `select multiple` — самый короткий способ выбрать набор. */
function LabelPicker({
  testId,
  label,
  value,
  onChange,
  names,
}: {
  testId: string;
  label: string;
  value: ProcessLabelKey[];
  onChange: (keys: ProcessLabelKey[]) => void;
  names: Record<ProcessLabelKey, string>;
}): JSX.Element {
  const id = useId();
  return (
    <label className="proc-cell" htmlFor={id}>
      <span className="proc-cell__title">{label}</span>
      <select
        className="field__select proc-cell__select"
        id={id}
        multiple
        data-testid={testId}
        value={value}
        onChange={(event) => {
          const chosen = Array.from(event.target.selectedOptions, (option) => option.value);
          onChange(PROCESS_LABEL_KEYS.filter((key) => chosen.includes(key)));
        }}
      >
        {PROCESS_LABEL_KEYS.map((key) => (
          <option key={key} value={key}>
            {names[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function DepartmentProcess({ departmentId }: { departmentId: number }): JSX.Element {
  const [state, setState] = useState<ProcessState>({ status: 'loading' });
  const [document, setDocument] = useState<ProcessDocument | null>(null);
  const [saved, setSaved] = useState<SavedState>({ kind: 'defaults' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
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
      setSaved(body.document === null ? { kind: 'defaults' } : { kind: 'clean', revision: 0 });
    } catch (error) {
      const text = error instanceof ApiError ? error.message : UNREACHABLE_TEXT;
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
    if (document === null) {
      return;
    }
    setSaved({ kind: 'saving' });
    try {
      const body = await saveProcess(departmentId, document);
      setDocument(sortSteps(body.document));
      setSaved({ kind: 'clean', revision: body.revision });
    } catch (error) {
      const text = error instanceof ApiError ? error.message : UNREACHABLE_TEXT;
      setSaved({ kind: 'failed', text });
    }
  };

  const handleReset = () => {
    if (state.status !== 'ready') {
      return;
    }
    setDocument(sortSteps(state.defaults));
    setSaved({ kind: 'dirty' });
  };

  if (state.status === 'loading') {
    return (
      <p className="muted" data-testid="department-process">
        Загружаю процесс…
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
      <div className="proc-head">
        <div>
          <h2 className="form-section__title">Процесс отдела</h2>
          <p className="muted">
            Таблица переходов, которую исполняет диспетчер: ступень берёт тикет по входящим
            меткам, зовёт роль и ставит следующие метки. Порядок — колонка «порядок».
          </p>
        </div>
        <div className="proc-actions">
          <button className="btn" type="button" data-testid="process-reset" onClick={handleReset}>
            Сбросить к умолчанию
          </button>
          <button
            className="btn btn--primary"
            type="button"
            data-testid="process-save"
            onClick={() => void handleSave()}
            disabled={saved.kind === 'saving'}
          >
            {saved.kind === 'saving' ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>

      {saved.kind === 'defaults' && (
        <p className="proc-saved" data-testid="process-saved">
          У отдела нет своего процесса — показаны умолчания
        </p>
      )}
      {saved.kind === 'clean' && (
        <p className="proc-saved" data-testid="process-saved">
          {saved.revision > 0 ? `Сохранено: ревизия ${saved.revision}` : 'Заполнено умолчаниями — не сохранено'}
        </p>
      )}
      {saved.kind === 'dirty' && (
        <p className="proc-saved" data-testid="process-saved">
          Не сохранено
        </p>
      )}
      {saved.kind === 'saving' && (
        <p className="proc-saved" data-testid="process-saved">
          Сохраняю…
        </p>
      )}
      {saved.kind === 'failed' && (
        <p className="error" data-testid="process-error" role="alert">
          {saved.text}
        </p>
      )}

      <div className="proc-labels">
        <h3 className="proc-labels__title">Имена меток</h3>
        <p className="muted">
          Ступени ссылаются на ключи меток, а не на имена: переименование метки здесь не
          трогает ни одну ступень.
        </p>
        <div className="proc-labels__grid">
          {PROCESS_LABEL_KEYS.map((key) => {
            const id = `${key}-name`;
            return (
              <label className="proc-cell" key={key} htmlFor={id}>
                <span className="proc-cell__title">{LABEL_TITLES[key]}</span>
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
            {document.steps.map((step, index) => (
              <tr className="proc-row" key={step.id} data-testid="process-step-row" data-step-id={step.id}>
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
                <td>
                  <LabelPicker
                    testId="process-step-when"
                    label={`Входящие метки ступени «${step.title}»`}
                    value={step.when}
                    names={document.labels}
                    onChange={(keys) => edit(withStep(document, index, { when: keys }))}
                  />
                </td>
                <td>
                  <LabelPicker
                    testId="process-step-unless"
                    label={`Исключающие метки ступени «${step.title}»`}
                    value={step.unless}
                    names={document.labels}
                    onChange={(keys) => edit(withStep(document, index, { unless: keys }))}
                  />
                </td>
                <td>
                  <LabelPicker
                    testId="process-step-put"
                    label={`Ставит ступень «${step.title}»`}
                    value={step.put}
                    names={document.labels}
                    onChange={(keys) => edit(withStep(document, index, { put: keys }))}
                  />
                </td>
                <td>
                  <LabelPicker
                    testId="process-step-drop"
                    label={`Снимает ступень «${step.title}»`}
                    value={step.drop}
                    names={document.labels}
                    onChange={(keys) => edit(withStep(document, index, { drop: keys }))}
                  />
                </td>
                <td>
                  <select
                    className="field__select"
                    aria-label={`Страж ступени «${step.title}»`}
                    data-testid="process-step-guard"
                    value={step.guard ?? ''}
                    onChange={(event) =>
                      edit(withStep(document, index, { guard: event.target.value === '' ? null : event.target.value }))
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
                      edit(withStep(document, index, { role: event.target.value === '' ? null : event.target.value }))
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
                    onChange={(event) => edit(withStep(document, index, { enabled: event.target.checked }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
