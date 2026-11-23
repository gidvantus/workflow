/**
 * Карта процесса: карточка на странице отдела, полотно ступеней и панель правки ступени.
 *
 * Карточка — вход: числа документа и виды ступеней. Само полотно открывается поверх
 * страницы (`process-map-overlay`), потому что тринадцать ступеней со связями в карточку
 * не влезают. Полотно показывает **только ступени**: провода идут от ступени к ступени,
 * метки живут строками внутри узла — «вход», «выход», «снимает». Справочника меток слева
 * нет: карта читается как конвейер, а не как список лейблов.
 *
 * Компонент ничего не решает про содержимое карты: узлы, провода и «Вне схемы» приходят из
 * `buildProcessGraph`, координаты — из `layoutProcessGraph`, оба по документу процесса
 * (`GET /api/departments/{id}/process`). Своих чисел, подписей меток, ролей и стражей он не
 * держит — правка процесса в вебе меняет карту, а расхождения документа с полотном видны в
 * строке «Вне схемы».
 *
 * Клик по блоку открывает панель ступени: она правит не отдельное поле, а всю ступень и
 * сохраняет документ целиком одним `PUT` — как вкладка «Процесс». Правки копятся в
 * черновике; «Отмена», Esc и «Закрыть карту» при несохранённых правках спрашивают
 * подтверждение.
 *
 * Полотно — HTML-блоки над SVG-слоем проводов: текст остаётся текстом для скринридера,
 * блоки не сжимаются, а при узком экране полотно превращается в список ступеней.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';

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
} from '../api/process';
import {
  KIND_TITLES,
  RESOLVER_TITLES,
  UNUSED_REASON_TITLES,
  WIRE_RULE,
  buildProcessGraph,
  layoutProcessGraph,
  wireTitle,
  type PlacedStep,
  type ProcessGraph,
  type ProcessGraphLabel,
  type ProcessGraphStepNode,
} from '../api/processGraph';

/** Склонение по числу: на карточке видно «13 ступеней · 33 связи», а не «33 связей». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

/** Подпись метки: имя лейбла из документа, а если имени нет — ключ контракта. */
function labelText(item: ProcessGraphLabel): string {
  return item.name === '' ? item.key : item.name;
}

/* ---------- пиктограммы ---------- */

/**
 * Вид ступени пиктограммой: сессия — терминал, маршрут — развилка, авто — ярлык. Плитка
 * вокруг иконки различается тоже (тёмная / обводка / пунктир), поэтому цвет единственным
 * различием не остаётся; вид продублирован словом в легенде и `data-kind`.
 */
function KindIcon({ kind }: { kind: ProcessStepKind }): JSX.Element {
  if (kind === 'route') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="4.2" cy="12" r="1.6" />
        <circle cx="11.8" cy="4" r="1.6" />
        <circle cx="11.8" cy="12" r="1.6" />
        <path d="M4.2 10.4V7.4a2.4 2.4 0 0 1 2.4-2.4h3.6" />
        <path d="M6.6 12h3.6" />
      </svg>
    );
  }
  if (kind === 'auto') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M2.6 6.1h4.1l4.3 4.3-2.9 2.9L3.8 9V6.1z" />
        <circle cx="5" cy="8.1" r="0.9" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6" />
      <path d="M4.9 7.1l1.7 1.6-1.7 1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.4 10.4h2.4" strokeLinecap="round" />
    </svg>
  );
}

/** Страж — щит: так поле документа читается иконкой, а не ещё одной строкой. */
function ShieldIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M8 2.3l3.9 1.3v3.9c0 3.1-3.9 4.9-3.9 4.9S4.1 10.6 4.1 7.5V3.6z" strokeLinejoin="round" />
    </svg>
  );
}

/** Стрелка провода: сплошная, потому что вид у провода один — «ставит → берёт». */
function ArrowMarker({ id }: { id: string }): JSX.Element {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0 1.4 9 5 0 8.6z" fill="var(--muted)" />
    </marker>
  );
}

/* ---------- чтение документа ---------- */

/** Состояние карты: загрузка, отказ сервера и готовый документ — больше ничего нет. */
type MapState =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | {
      status: 'ready';
      document: ProcessDocument;
      /** `true` — своего процесса у отдела нет, карта построена по умолчаниям. */
      fromDefaults: boolean;
      guards: ProcessGuard[];
      roles: string[];
    };

/** Подпись источника: откуда взялся документ, по которому построена карта. */
function sourceText(fromDefaults: boolean): string {
  return fromDefaults ? 'Процесс по умолчанию — в вебе не сохранён' : 'По сохранённому процессу';
}

/** Полное имя ступени для скринридера: на полотне текст сокращён до трёх строк. */
function stepDescription(node: ProcessGraphStepNode): string {
  const parts = [
    `${node.step.title} · ${node.kindTitle}`,
    `${node.step.id} · ${node.roleTitle}`,
    node.guardTitle === null ? 'без стража' : `страж: ${node.guardTitle}`,
    `вход: ${node.whenLabels.map((item) => labelText(item)).join(', ') || 'нет'}`,
    `выход: ${node.putLabels.map((item) => labelText(item)).join(', ') || 'метки не меняет'}`,
  ];
  if (node.dropLabels.length > 0) {
    parts.push(`снимает: ${node.dropLabels.map((item) => labelText(item)).join(', ')}`);
  }
  if (node.unlessLabels.length > 0) {
    parts.push(`кроме: ${node.unlessLabels.map((item) => labelText(item)).join(', ')}`);
  }
  return parts.join(' · ');
}

/* ---------- блок ступени ---------- */

/** Строка меток в блоке: подпись поля, точки входа и сами метки. */
function LabelRow({
  title,
  labels,
  empty,
  struck = false,
}: {
  title: string;
  labels: ProcessGraphLabel[];
  empty?: string;
  struck?: boolean;
}): JSX.Element {
  return (
    <span className="proc-map__row">
      <span className="proc-map__row-title">{title}</span>
      {labels.length === 0 ? (
        <span className="proc-map__row-empty">{empty ?? '—'}</span>
      ) : (
        labels.map((item) => (
          <span
            className={`proc-map__label${struck ? ' proc-map__label--struck' : ''}`}
            key={item.key}
            data-label-key={item.key}
          >
            {!struck && (
              <span
                className={`proc-map__dot proc-map__dot--${item.fromStep ? 'step' : 'outside'}`}
                aria-hidden="true"
              />
            )}
            {labelText(item)}
          </span>
        ))
      )}
    </span>
  );
}

/** Один узел полотна: вид, название, вход, выход, что снимает, исключения и страж. */
function StepBlock({
  placed,
  expanded,
  onOpen,
  onToggleExceptions,
}: {
  placed: PlacedStep;
  expanded: boolean;
  onOpen: () => void;
  onToggleExceptions: () => void;
}): JSX.Element {
  const { node } = placed;
  const { step } = node;
  return (
    <article
      className={`proc-map__step proc-map__step--${step.kind}`}
      style={
        {
          '--pm-x': `${placed.x}px`,
          '--pm-y': `${placed.y}px`,
        } as CSSProperties
      }
      data-testid="process-map-step"
      data-step-id={step.id}
      data-kind={step.kind}
      aria-label={stepDescription(node)}
    >
      <button
        className="proc-map__step-open"
        type="button"
        data-testid="process-map-step-open"
        data-step-id={step.id}
        onClick={onOpen}
      >
        <span className="proc-map__step-top">
          <span className={`proc-map__tile proc-map__tile--${step.kind}`} aria-hidden="true">
            <KindIcon kind={step.kind} />
          </span>
          <span className="proc-map__step-names">
            <span className="proc-map__step-title">{step.title}</span>
            <span className="proc-map__step-meta">
              <code>{step.id}</code> · {node.roleTitle}
            </span>
          </span>
        </span>
        <span className="proc-map__step-rows">
          <LabelRow title="Вход" labels={node.whenLabels} />
          <LabelRow title="Выход" labels={node.putLabels} empty="метки не меняет" />
          {node.dropLabels.length > 0 && <LabelRow title="Снимает" labels={node.dropLabels} struck />}
        </span>
      </button>

      <div className="proc-map__step-foot">
        {node.unlessLabels.length > 0 && (
          <button
            className="proc-map__exceptions"
            type="button"
            data-testid="process-map-exceptions"
            data-step-id={step.id}
            aria-expanded={expanded}
            onClick={onToggleExceptions}
          >
            исключения ({node.unlessLabels.length}) <span aria-hidden="true">›</span>
          </button>
        )}
        {node.guardTitle !== null && (
          <span className="proc-map__guard" data-testid="process-map-guard" title={`Страж: ${node.guardTitle}`}>
            <ShieldIcon />
            {node.guardTitle}
          </span>
        )}
      </div>

      {/* Раскрытые исключения ложатся поверх самого блока: высота блока задана раскладкой, и
          растущий блок сдвинул бы соседей и провода. Отрицание проводом не рисуется —
          поэтому оно читается списком, а не стрелкой. */}
      {expanded && (
        <div className="proc-map__pop" data-testid="process-map-exceptions-list" data-step-id={step.id}>
          <div className="proc-map__pop-head">
            <p className="proc-map__pop-title">Пока метка стоит, ступень не берётся</p>
            <button
              className="proc-map__pop-x"
              type="button"
              aria-label="Свернуть исключения"
              data-testid="process-map-exceptions-close"
              onClick={onToggleExceptions}
            >
              ×
            </button>
          </div>
          <span className="proc-map__chips">
            {node.unlessLabels.map((item) => (
              <span
                className="proc-map__label proc-map__label--struck"
                key={item.key}
                data-label-key={item.key}
              >
                {labelText(item)}
              </span>
            ))}
          </span>
        </div>
      )}
    </article>
  );
}

/* ---------- легенда и «вне схемы» ---------- */

function MapLegend(): JSX.Element {
  return (
    <div className="proc-map__legend" data-testid="process-map-legend">
      <p className="proc-map__legend-row">
        <span className="proc-map__legend-wire">
          <svg width="38" height="10" viewBox="0 0 38 10" aria-hidden="true">
            <path d="M1 5h28" stroke="var(--muted)" strokeWidth="1.3" fill="none" />
            <path d="M28 1.6 36 5l-8 3.4z" fill="var(--muted)" />
          </svg>
          {WIRE_RULE}
        </span>
      </p>
      <p className="proc-map__legend-row">
        <span className="proc-map__legend-item">
          <span className="proc-map__dot proc-map__dot--step" aria-hidden="true" />
          метку ставит ступень
        </span>
        <span className="proc-map__legend-item">
          <span className="proc-map__dot proc-map__dot--outside" aria-hidden="true" />
          метку ставит кто-то вне карты
        </span>
        <span className="proc-map__legend-item">
          <span className="proc-map__legend-struck">метка</span> — снимает
        </span>
        <span className="proc-map__legend-item">исключения — метки «кроме»</span>
      </p>
    </div>
  );
}

/** Строка «Вне схемы»: метки, которых на полотне нет, с причиной. */
function UnusedLine({ graph }: { graph: ProcessGraph }): JSX.Element | null {
  if (graph.unused.length === 0) {
    return null;
  }
  return (
    <p className="proc-map__unused" data-testid="process-map-unused">
      <span className="proc-map__unused-title">Вне схемы:</span>
      {graph.unused.map((item) => (
        <span className="proc-map__unused-item" key={item.key} data-label-key={item.key}>
          <b>{item.name === '' ? item.key : item.name}</b> <code>{item.key}</code> —{' '}
          {UNUSED_REASON_TITLES[item.reason]}
        </span>
      ))}
    </p>
  );
}

/* ---------- панель ступени ---------- */

/** Поля ступени, которые правятся списком меток. */
type LabelField = 'when' | 'put' | 'drop' | 'unless';

const LABEL_FIELD_TITLES: Record<LabelField, string> = {
  when: 'Вход — метки «когда»',
  put: 'Выход — метки «ставит»',
  drop: 'Снимает',
  unless: 'Кроме — метки «исключения»',
};

const LABEL_FIELD_HINTS: Partial<Record<LabelField, string>> = {
  unless: 'Пока метка стоит, ступень не берётся. Проводом «кроме» не становится: у отрицания нет узла.',
};

/** Список меток поля с крестиком у каждой и пунктирным «+ метка» в конце. */
function LabelEditor({
  field,
  keys,
  document,
  onChange,
}: {
  field: LabelField;
  keys: ProcessLabelKey[];
  document: ProcessDocument;
  onChange: (keys: ProcessLabelKey[]) => void;
}): JSX.Element {
  const free = PROCESS_LABEL_KEYS.filter((key) => !keys.includes(key));
  return (
    <div className="proc-map__field">
      <p className="proc-map__field-label">{LABEL_FIELD_TITLES[field]}</p>
      <div className="proc-map__chips" data-testid={`process-map-field-${field}`}>
        {keys.map((key) => (
          <span className="proc-map__chip" key={key} data-label-key={key}>
            {document.labels[key] === '' ? key : document.labels[key]}
            <button
              className="proc-map__chip-x"
              type="button"
              aria-label={`Убрать метку ${key}`}
              data-testid={`process-map-remove-${field}-${key}`}
              onClick={() => onChange(keys.filter((current) => current !== key))}
            >
              ×
            </button>
          </span>
        ))}
        {free.length > 0 && (
          <select
            className="proc-map__chip-add"
            value=""
            aria-label={`Добавить метку: ${LABEL_FIELD_TITLES[field]}`}
            data-testid={`process-map-add-${field}`}
            onChange={(event) => {
              const value = event.target.value;
              if (value === '') {
                return;
              }
              const key = value as ProcessLabelKey;
              if (!keys.includes(key)) {
                onChange([...keys, key]);
              }
            }}
          >
            <option value="">+ метка</option>
            {free.map((key) => (
              <option key={key} value={key}>
                {document.labels[key] === '' ? key : `${document.labels[key]} · ${key}`}
              </option>
            ))}
          </select>
        )}
      </div>
      {LABEL_FIELD_HINTS[field] !== undefined && (
        <p className="proc-map__field-hint">{LABEL_FIELD_HINTS[field]}</p>
      )}
    </div>
  );
}

/**
 * Панель ступени: все поля документа, кроме `id`, которым ступень и находится. Правки идут
 * в черновик, сохранение — одно, на всю ступень.
 */
function StepPanel({
  draft,
  preview,
  document,
  unusedCount,
  roles,
  guards,
  error,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  draft: ProcessStep;
  preview: ProcessGraphStepNode | null;
  document: ProcessDocument;
  unusedCount: number;
  roles: string[];
  guards: ProcessGuard[];
  error: string | null;
  saving: boolean;
  onChange: (patch: Partial<ProcessStep>) => void;
  onClose: () => void;
  onSave: () => void;
}): JSX.Element {
  const setField = (field: LabelField) => (keys: ProcessLabelKey[]) => onChange({ [field]: keys });
  return (
    <aside className="proc-map__panel" data-testid="process-map-step-panel" aria-label={`Поля ступени «${draft.title}»`}>
      <div className="proc-map__panel-head">
        <div>
          <p className="proc-map__panel-eyebrow">Ступень · {KIND_TITLES[draft.kind]}</p>
          <p className="proc-map__panel-title">{draft.title}</p>
          <p className="proc-map__panel-id">
            <code>{draft.id}</code> · priority {draft.priority}
          </p>
        </div>
        <button
          className="proc-map__panel-x"
          type="button"
          aria-label="Закрыть панель"
          data-testid="process-map-step-close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="proc-map__panel-body">
        <label className="proc-map__field">
          <span className="proc-map__field-label">Название</span>
          <input
            className="field__input"
            type="text"
            value={draft.title}
            data-testid="process-map-field-title"
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>

        <div className="proc-map__field-pair">
          <div className="proc-map__field">
            <p className="proc-map__field-label">Вид ступени</p>
            <div className="proc-map__seg" role="group" aria-label="Вид ступени">
              {(['session', 'route', 'auto'] as ProcessStepKind[]).map((kind) => (
                <button
                  key={kind}
                  className={`proc-map__seg-btn${draft.kind === kind ? ' proc-map__seg-btn--on' : ''}`}
                  type="button"
                  aria-pressed={draft.kind === kind}
                  data-testid={`process-map-kind-${kind}`}
                  onClick={() => onChange({ kind, role: kind === 'session' ? draft.role : null })}
                >
                  {KIND_TITLES[kind]}
                </button>
              ))}
            </div>
          </div>
          <label className="proc-map__field proc-map__field--narrow">
            <span className="proc-map__field-label">Приоритет</span>
            <input
              className="field__input"
              type="number"
              min={1}
              max={999}
              value={draft.priority}
              data-testid="process-map-field-priority"
              onChange={(event) => {
                const parsed = Number(event.target.value);
                onChange({ priority: Number.isFinite(parsed) ? parsed : draft.priority });
              }}
            />
          </label>
        </div>

        <div className="proc-map__field-pair">
          <label className="proc-map__field">
            <span className="proc-map__field-label">Роль</span>
            <select
              className="field__select"
              value={draft.role ?? ''}
              disabled={draft.kind !== 'session'}
              data-testid="process-map-field-role"
              onChange={(event) => onChange({ role: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">— нет роли</option>
              {Object.entries(RESOLVER_TITLES).map(([code, title]) => (
                <option key={code} value={code}>
                  роль: {title}
                </option>
              ))}
              {roles.map((role) => (
                <option key={role} value={role}>
                  роль {role}
                </option>
              ))}
            </select>
          </label>
          <label className="proc-map__field">
            <span className="proc-map__field-label">Страж</span>
            <select
              className="field__select"
              value={draft.guard ?? ''}
              data-testid="process-map-field-guard"
              onChange={(event) => onChange({ guard: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">— нет стража</option>
              {guards.map((guard) => (
                <option key={guard.id} value={guard.id}>
                  {guard.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="proc-map__field-hint">
          Роль уходит в задание агенту, резолвер выбирает её по работе. У маршрута и авто роли нет — поле
          гаснет.
        </p>

        <label className="proc-map__field proc-map__field--row">
          <span className="proc-map__field-label">Включена</span>
          <input
            type="checkbox"
            checked={draft.enabled}
            data-testid="process-map-field-enabled"
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
        </label>

        <LabelEditor
          field="when"
          keys={draft.when}
          document={document}
          onChange={setField('when')}
        />
        <LabelEditor field="put" keys={draft.put} document={document} onChange={setField('put')} />
        <LabelEditor field="drop" keys={draft.drop} document={document} onChange={setField('drop')} />
        <LabelEditor
          field="unless"
          keys={draft.unless}
          document={document}
          onChange={setField('unless')}
        />

        <p className="proc-map__panel-stat" data-testid="process-map-panel-stat">
          <span>
            На карте: <b>{preview?.wiresIn ?? 0}</b> проводов на вход, <b>{preview?.wiresOut ?? 0}</b> на
            выход
          </span>
          <span>
            Меток вне схемы: <b>{unusedCount}</b>
          </span>
        </p>
        {error !== null && (
          <p className="error" data-testid="process-map-panel-error">
            {error}
          </p>
        )}
      </div>

      <div className="proc-map__panel-foot">
        <button
          className="btn"
          type="button"
          data-testid="process-map-step-cancel"
          onClick={onClose}
          disabled={saving}
        >
          Отмена
        </button>
        <button
          className="btn btn--dark"
          type="button"
          data-testid="process-map-step-save"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </aside>
  );
}

/* ---------- проверка черновика ---------- */

/** Что мешает сохранить ступень. Пустая строка — всё в порядке. */
function validateDraft(draft: ProcessStep, document: ProcessDocument): string | null {
  const title = draft.title.trim();
  if (title === '') {
    return 'Название ступени не может быть пустым.';
  }
  if (document.steps.some((step) => step.id !== draft.id && step.title.trim() === title)) {
    return 'Ступень с таким названием уже есть в документе.';
  }
  if (draft.when.length === 0) {
    return 'У ступени пустой вход: без метки в «когда» диспетчер её не возьмёт.';
  }
  if (draft.kind === 'session' && draft.role === null) {
    return 'У сессии должна быть роль: без неё ступень некому исполнять.';
  }
  return null;
}

/** Отпечаток ступени: по нему видно, есть ли в панели несохранённые правки. */
function stepSignature(step: ProcessStep): string {
  return [
    step.title,
    step.kind,
    step.role ?? '',
    step.guard ?? '',
    String(step.priority),
    step.enabled ? '1' : '0',
    step.when.join(','),
    step.put.join(','),
    step.drop.join(','),
    step.unless.join(','),
  ].join('|');
}

/** Копия ступени для черновика: правка панели не должна менять документ до сохранения. */
function copyStep(step: ProcessStep): ProcessStep {
  return {
    ...step,
    when: [...step.when],
    put: [...step.put],
    drop: [...step.drop],
    unless: [...step.unless],
  };
}

/** Документ с подменённой ступенью: по нему видно, что даст сохранение, ещё до него. */
function withDraft(document: ProcessDocument, id: string, draft: ProcessStep): ProcessDocument {
  return {
    ...document,
    steps: document.steps.map((step) => (step.id === id ? draft : step)),
  };
}

/* ---------- карта ---------- */

type Props = {
  departmentId: number;
  /** Меняется после сохранения документа — карта перечитывает его без перезагрузки страницы. */
  refreshKey?: number;
  /** Сообщить странице, что документ сохранён: таблица процесса тоже перечитывает его. */
  onProcessSaved?: () => void;
};

/** Что делать, если в панели есть несохранённые правки, а её просят закрыть. */
type DiscardAsk = null | 'panel' | 'map';

export default function DepartmentProcessMap({
  departmentId,
  refreshKey = 0,
  onProcessSaved,
}: Props): JSX.Element {
  const [state, setState] = useState<MapState>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: ProcessStep } | null>(null);
  const [discard, setDiscard] = useState<DiscardAsk>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fit, setFit] = useState(false);
  const [viewport, setViewport] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const baseId = useId();
  const arrowId = `pm-arrow-${baseId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const cardTitleId = `${baseId}-title`;
  const overlayTitleId = `${baseId}-overlay`;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const body = await getProcess(departmentId);
        if (cancelled) {
          return;
        }
        setState({
          status: 'ready',
          // Документа нет — карта строится по умолчаниям: это то, что отдел исполняет
          // прямо сейчас, и молчать об этом нельзя, поэтому подпись источника честная.
          document: body.document ?? body.defaults,
          fromDefaults: body.document === null,
          guards: body.guards,
          roles: body.roles,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          status: 'error',
          text: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [departmentId, refreshKey]);

  const graph = useMemo(
    () => (state.status === 'ready' ? buildProcessGraph(state.document, state.guards) : null),
    [state],
  );
  const layout = useMemo(() => (graph === null ? null : layoutProcessGraph(graph)), [graph]);

  /** Узел выбранной ступени: строка «на карте» считается на лету, с учётом черновика. */
  const previewNode = useMemo(() => {
    if (state.status !== 'ready' || editing === null) {
      return null;
    }
    const preview = buildProcessGraph(
      withDraft(state.document, editing.id, editing.draft),
      state.guards,
    );
    return preview.steps.find((node) => node.step.id === editing.id) ?? null;
  }, [state, editing]);

  const previewUnused = useMemo(() => {
    if (state.status !== 'ready' || editing === null) {
      return 0;
    }
    return buildProcessGraph(withDraft(state.document, editing.id, editing.draft), state.guards)
      .unused.length;
  }, [state, editing]);

  // Ширина полотна нужна кнопке «Вписать»: масштаб считается от контейнера, а не от окна.
  useEffect(() => {
    if (!open) {
      return;
    }
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    const measure = () => setViewport(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, state.status]);

  const dirty = useMemo(() => {
    if (editing === null || state.status !== 'ready') {
      return false;
    }
    const original = state.document.steps.find((step) => step.id === editing.id);
    return original !== undefined && stepSignature(original) !== stepSignature(editing.draft);
  }, [editing, state]);

  const finishClose = useCallback(() => {
    setOpen(false);
    setEditing(null);
    setDiscard(null);
    setExpanded(null);
    setFit(false);
  }, []);

  const closeOverlay = useCallback(() => {
    if (dirty) {
      setDiscard('map');
      return;
    }
    finishClose();
  }, [dirty, finishClose]);

  const closePanel = useCallback(() => {
    if (dirty) {
      setDiscard('panel');
      return;
    }
    setEditing(null);
    setDiscard(null);
  }, [dirty]);

  const confirmDiscard = useCallback(() => {
    const target = discard;
    setDiscard(null);
    setEditing(null);
    setPanelError(null);
    if (target === 'map') {
      finishClose();
    }
  }, [discard, finishClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (discard !== null) {
        setDiscard(null);
        return;
      }
      if (editing !== null) {
        closePanel();
        return;
      }
      finishClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, discard, editing, closePanel, finishClose]);

  // Фокус уходит в окно и возвращается на «Открыть картой». Окно живёт порталом в
  // `document.body`, но `aria-modal="true"` обещает, что страница под ним инертна: без
  // переноса фокуса Tab из шапки окна уходил бы в карточку под полотном.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const screen = overlayRef.current;
    (screen?.querySelector<HTMLElement>('button') ?? screen)?.focus();
    return () => {
      if (previous !== null) {
        previous.focus();
      }
    };
  }, [open]);

  const updateDraft = (patch: Partial<ProcessStep>) => {
    setEditing((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch } }));
    setPanelError(null);
  };

  const handleSave = async () => {
    if (state.status !== 'ready' || editing === null) {
      return;
    }
    const refusal = validateDraft(editing.draft, state.document);
    if (refusal !== null) {
      setPanelError(refusal);
      return;
    }
    const next = withDraft(state.document, editing.draft.id, editing.draft);
    setSaving(true);
    setPanelError(null);
    try {
      const saved = await saveProcess(departmentId, next);
      setState((current) =>
        current.status === 'ready'
          ? { ...current, document: saved.document, fromDefaults: false }
          : current,
      );
      setEditing(null);
      setDiscard(null);
      onProcessSaved?.();
    } catch (error) {
      setPanelError(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setSaving(false);
    }
  };

  const ready = state.status === 'ready' ? state : null;
  const scale = fit && layout !== null && viewport > 0 ? Math.min(1, viewport / layout.width) : 1;

  return (
    <section
      className="card proc-map"
      data-testid="department-process-map"
      // Пока окно открыто, карточка перестаёт быть контейнером (`index.css`, `.proc-map`):
      // containment делал её containing block'ом для окна, и `.card` режет окно своей коробкой.
      data-overlay={open ? 'open' : undefined}
      aria-labelledby={cardTitleId}
    >
      <div className="card__head proc-map__head">
        <div className="proc-map__intro">
          <h2 className="card__title" id={cardTitleId}>
            Карта процесса
          </h2>
          <p className="card__meta">Ступени документа и метки, которыми они связаны.</p>
        </div>
        <div className="card__tools proc-map__tools">
          {ready !== null && (
            <p className="proc-map__source" data-testid="process-map-source">
              {sourceText(ready.fromDefaults)}
            </p>
          )}
          {graph !== null && (
            <p className="chip proc-map__counts" data-testid="process-map-counts">
              {`${graph.steps.length} ${plural(graph.steps.length, 'ступень', 'ступени', 'ступеней')} · ${graph.links.total} ${plural(graph.links.total, 'связь', 'связи', 'связей')}`}
            </p>
          )}
        </div>
      </div>

      {state.status === 'loading' && (
        <p className="proc-map__loading" data-testid="process-map-loading">
          Загрузка…
        </p>
      )}

      {state.status === 'error' && (
        <div className="proc-map__error" data-testid="process-map-error">
          <p className="error">{state.text}</p>
          <p className="muted">Документ процесса не пришёл: сеть, остановленный контейнер или отказ сервера.</p>
        </div>
      )}

      {ready !== null && graph !== null && graph.steps.length === 0 && (
        <div className="proc-map__empty" data-testid="process-map-empty">
          <p className="proc-map__empty-title">Схемы нет</p>
          <p className="proc-map__empty-hint">
            Ни одной включённой ступени в документе нет. Карта вернётся, когда на вкладке «Процесс»
            появится первая.
          </p>
        </div>
      )}

      {ready !== null && graph !== null && graph.steps.length > 0 && (
        <>
          <div className="proc-map__teaser" data-testid="process-map-teaser">
            <p className="proc-map__kinds">
              {(['session', 'route', 'auto'] as ProcessStepKind[]).map((kind) => (
                <span className="proc-map__kind" key={kind}>
                  <span className={`proc-map__tile proc-map__tile--${kind}`} aria-hidden="true">
                    <KindIcon kind={kind} />
                  </span>
                  {KIND_TITLES[kind]}
                </span>
              ))}
            </p>
            <div className="proc-map__cta">
              <button
                className="btn btn--dark"
                type="button"
                data-testid="process-map-open"
                onClick={() => setOpen(true)}
              >
                Открыть картой
              </button>
              <span className="muted">
                {`${graph.wires.length} ${plural(graph.wires.length, 'провод', 'провода', 'проводов')} между ступенями`}
              </span>
            </div>
          </div>
          <UnusedLine graph={graph} />
        </>
      )}

      {/* Окно рисовано порталом в `document.body`. Внутри карточки его держать нельзя:
          `.proc-map` — `container-type: inline-size`, а контейнер по спецификации становится
          containing block'ом для `position: fixed` потомков, и `.card` режет их своим
          `overflow: hidden`. Портал снимает обоих: окно занимает окно браузера целиком. */}
      {open &&
        ready !== null &&
        graph !== null &&
        layout !== null &&
        createPortal(
        <div
          ref={overlayRef}
          tabIndex={-1}
          className="proc-map__screen"
          role="dialog"
          aria-modal="true"
          aria-labelledby={overlayTitleId}
          data-testid="process-map-overlay"
        >
          <header className="proc-map__bar">
            <div className="proc-map__bar-head">
              <p className="proc-map__bar-title" id={overlayTitleId}>
                Карта процесса
              </p>
              <p className="proc-map__bar-sub">
                {editing === null
                  ? `Ступени в порядке проверки. ${WIRE_RULE}`
                  : 'Ступень выбрана: справа её поля, слева — место ступени в карте.'}
              </p>
            </div>
            <div className="proc-map__bar-tools">
              {/* У источника два места — карточка и шапка окна, и это два элемента, а не
                  один: у каждого свой testid, иначе `getByTestId` падает на strict mode. */}
              <p className="proc-map__source" data-testid="process-map-overlay-source">
                {sourceText(ready.fromDefaults)}
              </p>
              <button
                className="btn"
                type="button"
                data-testid="process-map-fit"
                aria-pressed={fit}
                onClick={() => setFit((current) => !current)}
              >
                {fit ? 'Обычный масштаб' : 'Вписать'}
              </button>
              <button className="btn btn--dark" type="button" data-testid="process-map-close" onClick={closeOverlay}>
                Закрыть
              </button>
            </div>
          </header>

          <div className="proc-map__work">
            <div className="proc-map__main">
              <div className="proc-map__scroll" ref={scrollRef}>
                <div
                  className="proc-map__frame"
                  style={{ width: layout.width * scale, height: layout.height * scale }}
                >
                  <div
                    className="proc-map__canvas"
                    style={{
                      width: layout.width,
                      height: layout.height,
                      transform: scale === 1 ? undefined : `scale(${scale})`,
                    }}
                  >
                    <svg
                      className="proc-map__wires"
                      width={layout.width}
                      height={layout.height}
                      aria-hidden="true"
                    >
                      <defs>
                        <ArrowMarker id={arrowId} />
                      </defs>
                      {layout.wires.map((placed) => (
                        <g
                          key={placed.wire.id}
                          data-testid="process-map-edge"
                          data-kind="wire"
                          data-label-key={placed.wire.key}
                          data-from={placed.wire.from}
                          data-to={placed.wire.to}
                        >
                          {/* Фраза провода — из модуля, а не своя копия: подпись в `<title>`
                              обязана меняться вместе с `wireTitle`. */}
                          <title>{wireTitle(placed.wire)}</title>
                          <path className="proc-map__wire" d={placed.d} markerEnd={`url(#${arrowId})`} />
                          <circle className="proc-map__wire-dot" cx={placed.to.x} cy={placed.to.y} r={2.2} />
                        </g>
                      ))}
                    </svg>
                    {layout.steps.map((placed) => (
                      <StepBlock
                        key={placed.node.step.id}
                        placed={placed}
                        expanded={expanded === placed.node.step.id}
                        onOpen={() => {
                          setEditing({ id: placed.node.step.id, draft: copyStep(placed.node.step) });
                          setPanelError(null);
                          setDiscard(null);
                        }}
                        onToggleExceptions={() =>
                          setExpanded((current) =>
                            current === placed.node.step.id ? null : placed.node.step.id,
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="proc-map__foot">
                <MapLegend />
                <UnusedLine graph={graph} />
              </div>
            </div>

            {editing !== null && (
              <StepPanel
                draft={editing.draft}
                preview={previewNode}
                document={ready.document}
                unusedCount={previewUnused}
                roles={ready.roles}
                guards={ready.guards}
                error={panelError}
                saving={saving}
                onChange={updateDraft}
                onClose={closePanel}
                onSave={() => void handleSave()}
              />
            )}
          </div>

          {discard !== null && (
            <div className="proc-map__confirm" role="alertdialog" aria-label="Несохранённые правки" data-testid="process-map-step-confirm">
              <p>Есть несохранённые правки ступени. Закрыть без сохранения?</p>
              <div className="proc-map__confirm-actions">
                <button className="btn" type="button" data-testid="process-map-step-continue" onClick={() => setDiscard(null)}>
                  Продолжить правку
                </button>
                <button className="btn btn--danger" type="button" data-testid="process-map-step-discard" onClick={confirmDiscard}>
                  Отменить правки
                </button>
              </div>
            </div>
          )}
        </div>,
          document.body,
        )}
    </section>
  );
}
