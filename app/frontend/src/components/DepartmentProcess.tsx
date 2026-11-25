/**
 * Вкладка «Процесс»: справочник тегов отдела и таблица переходов конвейера.
 *
 * Экран — редактор одного документа: 14 тегов проекта и строки ступеней. Теги и ступени
 * сохраняются **вместе**: таблица ссылается на ключи тегов, поэтому половина документа —
 * документ, который никто не проверял. Отсюда одна пара `GET`/`PUT` и одна кнопка
 * «Сохранить» на весь экран.
 *
 * **Тег, а не имя метки.** У каждого из 14 ключей — имя на GitHub, подпись для глаза и
 * агент. Агент выбирается на теге: ступень берёт его из своих входящих тегов, и если хоть
 * один входящий тег отдан включённому гостю, диспетчер ступень не берёт. Подписи тегов
 * приходят с сервера — своей таблицы подписей у фронта нет.
 *
 * **Своих значений экран не придумывает.** Список стражей и ролей приходит с сервера тем
 * же ответом, что и документ; агенты — отдельной ручкой `GET /api/agents`. Тексты отказов
 * `422` показываются дословно, без переписывания. Порядок ступеней — колонка `priority`:
 * экран сортирует строки по ней, чтобы таблица совпадала с порядком исполнения.
 *
 * **Сброс к умолчанию не ходит на сервер.** Документ по умолчанию приезжает в `defaults`
 * первого `GET`, кнопка заполняет им форму и оставляет документ «не сохранённым»: пока
 * человек не нажал «Сохранить», отдел работает по прежнему процессу, а `GET` покажет
 * именно сохранённое. Так «Сбросить» — это правка формы, а не тихая запись в реестр.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import { listAgents, type Agent } from '../api/agents';
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
  type ProcessTag,
} from '../api/process';
import { KIND_TITLES, RESOLVER_TITLES } from '../api/processGraph';

type ProcessState =
  | { status: 'loading' }
  | {
      status: 'ready';
      document: ProcessDocument;
      defaults: ProcessDocument;
      roles: string[];
      guards: ProcessGuard[];
      agents: Agent[];
    }
  | { status: 'error'; text: string };

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

/** Подписи полей ступени в блоке на узком экране (≤900): шапки таблицы там нет. */
const CELL_LABELS: Record<PickerField, string> = {
  when: 'Входящие',
  unless: 'Кроме',
  put: 'Ставит',
  drop: 'Снимает',
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
    return `Выбрано ${count}: ступень возьмёт тикет со всеми этими тегами.`;
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

function withTag(document: ProcessDocument, key: ProcessLabelKey, patch: Partial<ProcessTag>): ProcessDocument {
  return {
    ...document,
    tags: document.tags.map((tag) => (tag.key === key ? { ...tag, ...patch } : tag)),
  };
}

/** Метки в наборе: порядок канонический, чтобы ячейка не переставляла ключи местами. */
function toggleKey(keys: ProcessLabelKey[], key: ProcessLabelKey, on: boolean): ProcessLabelKey[] {
  const next = on ? [...keys, key] : keys.filter((current) => current !== key);
  return PROCESS_LABEL_KEYS.filter((current) => next.includes(current));
}

/** Подпись тега с кодом агента: то, что видно в ячейке и в списке галочек. */
function tagText(tag: ProcessTag | undefined, key: string): string {
  const title = tag !== undefined && tag.title !== '' ? tag.title : key;
  return tag?.agent !== null && tag?.agent !== undefined ? `${title} · ${tag.agent}` : title;
}

/** Владельцы входящих тегов: только живые включённые гости, как у диспетчера и API. */
function incomingAgents(
  step: ProcessStep,
  tags: Map<ProcessLabelKey, ProcessTag>,
  agents: Agent[],
): string[] {
  const live = new Map(agents.map((agent) => [agent.code, agent]));
  const owners: string[] = [];
  for (const key of step.when) {
    const code = tags.get(key)?.agent ?? null;
    if (code !== null && code !== 'dsh' && live.get(code)?.enabled && !owners.includes(code)) {
      owners.push(code);
    }
  }
  return owners;
}

/** Список галочек под строкой: подписи — подпись тега и код агента. */
function LabelPicker({
  id,
  testId,
  field,
  value,
  tags,
  onChange,
  onClose,
}: {
  id: string;
  testId: string;
  field: PickerField;
  value: ProcessLabelKey[];
  tags: Map<ProcessLabelKey, ProcessTag>;
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
            <span>{tagText(tags.get(key), key)}</span>
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

/** Ячейка с тегами: в покое это подписи, нажатие раскрывает список галочек. */
function LabelCell({
  testId,
  field,
  step,
  value,
  tags,
  open,
  panelId,
  onToggle,
}: {
  testId: string;
  field: PickerField;
  step: ProcessStep;
  value: ProcessLabelKey[];
  tags: Map<ProcessLabelKey, ProcessTag>;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}): JSX.Element {
  const shown = value.map((key) => tagText(tags.get(key), key));
  return (
    /* Ячейка — обычный `table-cell`: `display: flex` на самом `td` выбрасывает его из
       раскладки таблицы, и одиннадцать колонок перестают совпадать с шапкой. Столбик из
       кнопки собирает `.proc-cell` внутри. */
    <td className={`proc-cell-cell proc-cell--${field}`} data-label={CELL_LABELS[field]}>
      <div className="proc-cell">
        {/* Имя кнопки начинается с видимых подписей: скринридер называет то же, что видно
            глазами (`label-content-name-mismatch`, WCAG 2.5.3). Пустая ячейка говорит
            «нет меток» — прочерк сам по себе ничего не называет. */}
        <button
          className="proc-cell__pick"
          type="button"
          data-testid={testId}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${CELL_TITLES[field]} ступени «${step.title}»: ${
            shown.length === 0 ? '— нет меток' : shown.join(', ')
          }`}
          onClick={onToggle}
        >
          {value.length === 0 ? (
            <span className="proc-cell__none">—</span>
          ) : (
            value.map((key, index) => (
              /* Запятая — текст внутри токена, а не `::after`: имя кнопки выше обязано
                 содержать видимый текст целиком (WCAG 2.5.3). */
              <span className="lbl" key={key} data-agent={tags.get(key)?.agent ?? ''}>
                {tagText(tags.get(key), key)}
                {index < value.length - 1 ? <span className="lbl__sep">, </span> : null}
              </span>
            ))
          )}
        </button>
      </div>
    </td>
  );
}

export default function DepartmentProcess({
  departmentId,
  onProcessSaved,
}: {
  departmentId: number;
  /** Сохранение прошло: карта процесса над вкладками пересобирается по новому документу. */
  onProcessSaved?: () => void;
}): JSX.Element {
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
      const [body, agents] = await Promise.all([getProcess(departmentId), listAgents()]);
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
        agents,
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
      onProcessSaved?.();
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

  const tags = useMemo(
    () => new Map((document?.tags ?? []).map((tag) => [tag.key, tag])),
    [document],
  );

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

  const { roles, guards, agents } = state;
  const roleOptions: ProcessStepRole[] = [null, ...roles, 'by-area', 'by-findings'];
  const agentOptions = agents.filter((agent) => agent.code !== 'dsh');

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
              <th scope="col">Агент</th>
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
              const owners = incomingAgents(step, tags, agents);
              const assignedOwners = [
                ...new Set(
                  step.when
                    .map((key) => tags.get(key)?.agent ?? null)
                    .filter((code): code is string => code !== null && code !== 'dsh'),
                ),
              ];
              const conflict = owners.length > 1;
              const activeOwner = owners.length === 1 ? owners[0] : null;
              const ownerNotes = assignedOwners
                .filter((code) => !owners.includes(code))
                .map((code) => agents.some((agent) => agent.code === code)
                  ? `${code} выключен`
                  : `${code} не найден`);
              return (
                <Fragment key={step.id}>
                  <tr
                    className={
                      !step.enabled
                        ? 'proc-row proc-row--off'
                        : conflict
                          ? 'proc-row proc-row--conflict'
                          : 'proc-row'
                    }
                    data-testid="process-step-row"
                    data-step-id={step.id}
                  >
                    <td className="proc-col proc-col--priority" data-label="Порядок">
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
                    <td className="proc-col proc-col--title" data-label="Ступень">
                      <input
                        className="field__input"
                        aria-label={`Название ступени ${step.id}`}
                        data-testid="process-step-title"
                        value={step.title}
                        onChange={(event) => edit(withStep(document, index, { title: event.target.value }))}
                      />
                      <span className="proc-row__id">{step.id}</span>
                    </td>
                    <td className="proc-col proc-col--kind" data-label="Вид">
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
                        tags={tags}
                        open={open === field}
                        panelId={`process-picker-${step.id}-${field}`}
                        onToggle={() => togglePicker(step.id, field)}
                      />
                    ))}
                    <td className="proc-col proc-col--agent" data-label="Агент">
                      <span
                        className={conflict ? 'proc-agent proc-agent--conflict' : 'proc-agent'}
                        data-testid="process-step-agent"
                      >
                        {conflict
                          ? `разные агенты: ${owners.join(', ')}`
                          : activeOwner !== null
                            ? activeOwner
                            : ownerNotes.length > 0
                              ? `диспетчер (dsh) · ${ownerNotes.join(', ')}`
                              : 'диспетчер (dsh)'}
                      </span>
                    </td>
                    <td className="proc-col proc-col--guard" data-label="Страж">
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
                    <td className="proc-col proc-col--role" data-label="Роль">
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
                    <td className="proc-col proc-col--enabled" data-label="Включена">
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
                      <td colSpan={11}>
                        <LabelPicker
                          id={`process-picker-${step.id}-${open}`}
                          testId={`process-step-${open}`}
                          field={open}
                          value={step[open]}
                          tags={tags}
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

      <div className="proc-tags form-section" data-testid="process-tags">
        <h3 className="proc-labels__title">Справочник тегов проекта</h3>
        <p className="muted">
          Слева ключ — то, что стоит в ступенях. Имя — метка на GitHub, подпись — то, что
          видно на экране, агент забирает ступень из своих входящих тегов. Тег без агента
          берёт диспетчер; выключенный агент возвращает тег диспетчеру.
        </p>
        {error !== null && (
          <p className="error" data-testid="process-tags-error" role="alert">
            {error}
          </p>
        )}
        <div className="proc-tags__grid">
          {PROCESS_LABEL_KEYS.map((key) => {
            const tag = tags.get(key);
            const agent = agents.find((item) => item.code === tag?.agent);
            return (
              <div className="proc-tags__row" key={key} data-testid={`process-label-${key}`}>
                <span className="proc-cell__title">
                  <code>{key}</code>
                </span>
                <div className="field">
                  <label className="field__label" htmlFor={`${key}-name`}>
                    Метка в GitHub
                  </label>
                  <input
                    className="field__input"
                    id={`${key}-name`}
                    data-testid={`tag-${key}-name`}
                    value={tag?.name ?? ''}
                    onChange={(event) => edit(withTag(document, key, { name: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${key}-title`}>
                    Подпись для глаза
                  </label>
                  <input
                    className="field__input"
                    id={`${key}-title`}
                    maxLength={100}
                    data-testid={`tag-${key}-title`}
                    value={tag?.title ?? ''}
                    onChange={(event) => edit(withTag(document, key, { title: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${key}-agent`}>
                    Агент
                  </label>
                  <select
                    className="field__select"
                    id={`${key}-agent`}
                    data-testid={`tag-${key}-agent`}
                    value={tag?.agent ?? ''}
                    onChange={(event) =>
                      edit(withTag(document, key, { agent: event.target.value === '' ? null : event.target.value }))
                    }
                  >
                    <option value="">диспетчер (dsh)</option>
                    {tag?.agent === 'dsh' && <option value="dsh">диспетчер (dsh)</option>}
                    {agentOptions.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.title} ({item.code}){item.enabled ? '' : ' — выключен'}
                      </option>
                    ))}
                    {tag?.agent !== null && tag?.agent !== undefined && tag.agent !== 'dsh' && agent === undefined && (
                      <option value={tag.agent}>{tag.agent} — не найден</option>
                    )}
                  </select>
                  <span className="field__hint">
                    {tag?.agent === null || tag?.agent === undefined
                      ? 'его берёт диспетчер'
                      : agent === undefined
                        ? 'агента нет в справочнике — ступень возьмёт диспетчер'
                        : agent.enabled
                          ? `ступень берёт ${agent.title}`
                          : 'агент выключен — ступень вернётся диспетчеру'}
                  </span>
                </div>
              </div>
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
