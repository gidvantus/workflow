/**
 * Карта процесса: полотно меток и ступеней над вкладками страницы отдела.
 *
 * Компонент ничего не решает про содержимое карты: узлы, рёбра и «Вне схемы» приходят из
 * `buildProcessGraph`, координаты — из `layoutProcessGraph`, оба по документу процесса
 * (`GET /api/departments/{id}/process`). Своих чисел, подписей меток, ролей и стражей он
 * не держит — правка процесса в вебе меняет карту, а расхождения документа с полотном
 * видны в строке «Вне схемы».
 *
 * Три вида рёбер различаются без цвета: сплошная с залитой стрелкой — метка включает
 * ступень (`when`), сплошная с полой — ступень ставит метку (`put`), пунктир — снимает
 * (`drop`). Отрицание (`unless`) ребром не рисуется: у него нет состояния, в которое
 * тикет входит, поэтому такие метки попадают в «Вне схемы» с причиной.
 *
 * Полотно — один `<svg>` с блоками внутри, а не canvas: блок остаётся текстом для
 * скринридера, а `data-testid` даёт проверкам точки опоры. Блоки не сжимаются: при узкой
 * карточке полотно прокручивается вбок внутри своего блока, страница по горизонтали не
 * едет.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { getProcess } from '../api/process';
import {
  PROCESS_MAP_GEOMETRY,
  buildProcessGraph,
  layoutProcessGraph,
  type ProcessGraph,
  type ProcessGraphStepNode,
  type ProcessGraphState,
  type PlacedEdge,
} from '../api/processGraph';

/** «кроме: progress, review +6» — хвост списка сокращён, полный список остаётся в `<title>`. */
function summarizeKeys(keys: readonly string[], limit = 2): string {
  if (keys.length <= limit) {
    return keys.join(', ');
  }
  return `${keys.slice(0, limit).join(', ')} +${keys.length - limit}`;
}

/** Полное описание ступени для скринридера: на полотне оно сокращено до трёх строк. */
function stepDescription(node: ProcessGraphStepNode): string {
  const parts = [
    `${node.step.title} · ${node.kindTitle}`,
    `${node.step.id} · ${node.roleTitle}`,
    node.guardTitle === null ? 'без стража' : `страж: ${node.guardTitle}`,
  ];
  if (node.unlessKeys.length > 0) {
    parts.push(`кроме: ${node.unlessKeys.join(', ')}`);
  }
  return parts.join(' · ');
}

/** Склонение по числу: на карте видно «13 ступеней · 33 связи», а не «33 связей». */
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

/** Состояние карты: загрузка, отказ сервера и готовый граф — больше ничего нет. */
type MapState =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'ready'; graph: ProcessGraph; fromDefaults: boolean };

/** Узел-метка: имя лейбла из документа и ключ контракта рядом, моноширинным. */
function StateNode({ state, top }: { state: ProcessGraphState; top: number }): JSX.Element {
  const { labelX, labelW, labelH } = PROCESS_MAP_GEOMETRY;
  const name = state.name === '' ? state.key : state.name;
  return (
    <g data-testid="process-map-state" data-label-key={state.key}>
      <title>{`${name} (${state.key})`}</title>
      <rect className="proc-map__state-box" x={labelX} y={top} width={labelW} height={labelH} rx={10} />
      <text className="proc-map__state-name" x={labelX + 14} y={top + 19}>
        {name}
      </text>
      <text className="proc-map__state-key" x={labelX + 14} y={top + 33}>
        {state.key}
      </text>
    </g>
  );
}

/** Узел-ступень: название, `id`, роль, страж и «кроме» — ровно поля документа. */
function StepNode({ node, top }: { node: ProcessGraphStepNode; top: number }): JSX.Element {
  const { stepX, stepW, stepH } = PROCESS_MAP_GEOMETRY;
  const note = [
    node.guardTitle === null ? null : `страж: ${node.guardTitle}`,
    node.unlessKeys.length === 0 ? null : `кроме: ${summarizeKeys(node.unlessKeys)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <g data-testid="process-map-step" data-step-id={node.step.id} data-kind={node.step.kind}>
      <title>{stepDescription(node)}</title>
      <rect
        className={`proc-map__step-box proc-map__step-box--${node.step.kind}`}
        x={stepX}
        y={top}
        width={stepW}
        height={stepH}
        rx={10}
      />
      <rect
        className={`proc-map__tile-svg proc-map__tile-svg--${node.step.kind}`}
        x={stepX + 14}
        y={top + 12}
        width={11}
        height={11}
        rx={3}
      />
      <text className="proc-map__step-title" x={stepX + 33} y={top + 22}>
        {node.step.title}
      </text>
      <text className="proc-map__step-meta" x={stepX + 14} y={top + 37}>
        <tspan className="proc-map__mono">{node.step.id}</tspan>
        <tspan>{` · ${node.roleTitle}`}</tspan>
      </text>
      {note === '' ? null : (
        <text className="proc-map__step-note" x={stepX + 14} y={top + 52}>
          {note}
        </text>
      )}
    </g>
  );
}

/** Полотно: рёбра под узлами, чтобы стрелки не закрывали текст блоков. */
function MapCanvas({
  graph,
  titleId,
  descriptionId,
}: {
  graph: ProcessGraph;
  titleId: string;
  descriptionId: string;
}): JSX.Element {
  const layout = useMemo(() => layoutProcessGraph(graph), [graph]);

  const labelNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const state of graph.states) {
      names.set(state.key, state.name === '' ? state.key : state.name);
    }
    return names;
  }, [graph.states]);

  const stepNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const node of graph.steps) {
      names.set(node.nodeId, node.step.title);
    }
    return names;
  }, [graph.steps]);

  const edgeTitle = (edge: PlacedEdge['edge']): string => {
    const label = labelNames.get(edge.key) ?? edge.key;
    const step = stepNames.get(edge.kind === 'trigger' ? edge.to : edge.from) ?? edge.from;
    if (edge.kind === 'trigger') {
      return `Метка «${label}» включает ступень «${step}»`;
    }
    if (edge.kind === 'put') {
      return `Ступень «${step}» ставит метку «${label}»`;
    }
    return `Ступень «${step}» снимает метку «${label}»`;
  };

  return (
    <svg
      className="proc-map__canvas"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <title id={titleId}>Карта процесса отдела</title>
      <desc id={descriptionId}>
        Граф состояний: метки слева, ступени справа. Стрелки показывают, какая метка включает
        ступень и что ступень ставит или снимает.
      </desc>
      <defs>
        <marker
          id="proc-map-arrow-filled"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6.5}
          markerHeight={6.5}
          orient="auto-start-reverse"
        >
          <path d="M0 1.4 9 5 0 8.6z" className="proc-map__arrow--filled" />
        </marker>
        <marker
          id="proc-map-arrow-open"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6.5}
          markerHeight={6.5}
          orient="auto-start-reverse"
        >
          <path d="M0 1.4 9 5 0 8.6z" className="proc-map__arrow--open" />
        </marker>
      </defs>

      <g className="proc-map__edges">
        {layout.edges.map(({ edge, d }) => (
          <path
            key={`${edge.kind}-${edge.key}-${edge.from}-${edge.to}`}
            className={`proc-map__edge proc-map__edge--${edge.kind}`}
            data-testid="process-map-edge"
            data-kind={edge.kind}
            data-label-key={edge.key}
            data-from={edge.from}
            data-to={edge.to}
            d={d}
            markerEnd={
              edge.kind === 'trigger' ? 'url(#proc-map-arrow-filled)' : 'url(#proc-map-arrow-open)'
            }
          >
            <title>{edgeTitle(edge)}</title>
          </path>
        ))}
      </g>

      <g className="proc-map__states">
        {layout.states.map((placed) => (
          <StateNode key={placed.state.key} state={placed.state} top={placed.top} />
        ))}
      </g>

      <g className="proc-map__steps">
        {layout.steps.map((placed) => (
          <StepNode key={placed.node.nodeId} node={placed.node} top={placed.top} />
        ))}
      </g>
    </svg>
  );
}

/** Легенда: виды ступеней и виды рёбер словами — цвет в ней не участвует. */
function MapLegend(): JSX.Element {
  return (
    <div className="proc-map__legend" data-testid="process-map-legend">
      <p className="proc-map__legend-row">
        <span className="proc-map__legend-kind">
          <span className="proc-map__tile proc-map__tile--session" aria-hidden="true" />
          <b>сессия</b>
          <span>— запускает агента в роли</span>
        </span>
        <span className="proc-map__legend-kind">
          <span className="proc-map__tile proc-map__tile--route" aria-hidden="true" />
          <b>маршрут</b>
          <span>— решает роль по работе</span>
        </span>
        <span className="proc-map__legend-kind">
          <span className="proc-map__tile proc-map__tile--auto" aria-hidden="true" />
          <b>авто</b>
          <span>— переносит метки, без агента</span>
        </span>
      </p>
      <p className="proc-map__legend-row">
        <span className="proc-map__legend-item">
          <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
            <path d="M0 4h9" className="proc-map__legend-line" />
            <path d="M9 1 15 4 9 7Z" className="proc-map__legend-arrow-filled" />
          </svg>
          метка включает ступень (when)
        </span>
        <span className="proc-map__legend-item">
          <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
            <path d="M0 4h9" className="proc-map__legend-line" />
            <path d="M9 1 15 4 9 7Z" className="proc-map__legend-arrow-open" />
          </svg>
          ступень ставит метку (put)
        </span>
        <span className="proc-map__legend-item">
          <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
            <path d="M0 4h9" className="proc-map__legend-line proc-map__legend-line--drop" />
            <path d="M9 1 15 4 9 7Z" className="proc-map__legend-arrow-open" />
          </svg>
          ступень снимает метку (drop)
        </span>
      </p>
    </div>
  );
}

/** «Вне схемы»: метки, которых на полотне нет, и причина — по строке на метку. */
function UnusedLine({ graph }: { graph: ProcessGraph }): JSX.Element | null {
  if (graph.unused.length === 0) {
    return null;
  }
  return (
    <p className="proc-map__unused" data-testid="process-map-unused">
      <span className="proc-map__unused-item">Вне схемы:</span>
      {graph.unused.map((item) => (
        <span className="proc-map__unused-item" key={item.key}>
          <b>{item.name === '' ? item.key : item.name}</b> <code>({item.key})</code> —{' '}
          {item.reasonTitle}
        </span>
      ))}
    </p>
  );
}

export default function DepartmentProcessMap({
  departmentId,
  refreshKey,
}: {
  departmentId: number;
  /** Меняется после сохранения процесса: карта перечитывает документ, страница — нет. */
  refreshKey: number;
}): JSX.Element {
  const [state, setState] = useState<MapState>({ status: 'loading' });
  const titleId = useId();
  const descriptionId = useId();

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const body = await getProcess(departmentId);
      // Своего процесса нет — карта строится по умолчанию: это то, что отдел исполняет
      // прямо сейчас, и подпись источника говорит об этом словами.
      const document = body.document ?? body.defaults;
      setState({
        status: 'ready',
        graph: buildProcessGraph(document, body.guards),
        fromDefaults: body.document === null,
      });
    } catch (failure) {
      setState({
        status: 'error',
        text: failure instanceof ApiError ? failure.message : UNREACHABLE_TEXT,
      });
    }
  }, [departmentId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const ready = state.status === 'ready' ? state : null;
  const counts =
    ready === null
      ? null
      : `${ready.graph.steps.length} ${plural(
          ready.graph.steps.length,
          'ступень',
          'ступени',
          'ступеней',
        )} · ${ready.graph.edges.length} ${plural(
          ready.graph.edges.length,
          'связь',
          'связи',
          'связей',
        )}`;

  return (
    <section className="card proc-map" data-testid="department-process-map" aria-labelledby={titleId}>
      <div className="card__head proc-map__head">
        <div className="proc-map__intro">
          <h2 className="card__title" id={titleId}>
            Карта процесса
          </h2>
          <p className="card__meta">
            Что каждая ступень берёт на входе, что ставит на выходе и кто на ней работает. Порядок
            ступеней — порядок проверки диспетчером, а не ход тикета.
          </p>
        </div>
        {ready === null ? null : (
          <div className="card__tools proc-map__tools">
            <span className="chip" data-testid="process-map-counts">
              {counts}
            </span>
            <p className="proc-map__source" data-testid="process-map-source">
              {ready.fromDefaults
                ? 'Процесс по умолчанию — в вебе не сохранён'
                : 'По сохранённому процессу'}
            </p>
          </div>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="proc-map__loading" data-testid="process-map-loading" aria-busy="true">
          Загрузка…
        </p>
      )}

      {state.status === 'error' && (
        <div className="proc-map__error" data-testid="process-map-error" role="alert">
          <p className="error">{state.text}</p>
          <p className="muted">Полотно не рисуется: документ процесса не пришёл.</p>
        </div>
      )}

      {ready !== null && ready.graph.steps.length === 0 && (
        <div className="proc-map__empty" data-testid="process-map-empty">
          <p className="proc-map__empty-title">Схемы нет</p>
          <p className="proc-map__empty-hint">
            Ни одной включённой ступени в документе нет. Карта вернётся, когда на вкладке
            «Процесс» появится первая.
          </p>
        </div>
      )}

      {ready !== null && ready.graph.steps.length > 0 && (
        <>
          <div className="proc-map__scroll">
            <MapCanvas
              graph={ready.graph}
              titleId={`${titleId}-canvas`}
              descriptionId={`${descriptionId}-canvas`}
            />
          </div>
          <p className="proc-map__scroll-hint">
            Схема прокручивается вбок: она шире экрана и не сжимается.
          </p>
          <MapLegend />
          <UnusedLine graph={ready.graph} />
        </>
      )}
    </section>
  );
}
