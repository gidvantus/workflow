/**
 * Карта процесса: разбор документа в граф состояний — без React и без запросов.
 *
 * Документ процесса (`GET /api/departments/{id}/process`) — это таблица ступеней, а не
 * картинка. Карта строится из неё **целиком**: узлы-метки берутся из ключей, которые
 * встречаются у включённых ступеней в `when`, `put` или `drop`, узлы-ступени — из самих
 * включённых ступеней, рёбра — по каждому ключу. Своих значений карта не придумывает,
 * поэтому правка процесса в вебе меняет карту, а не расходится с ней.
 *
 * Что **не** становится узлом и ребром:
 *
 * - выключенная ступень (`enabled: false`) — диспетчер её пропускает, и на карте её нет;
 * - ключ, встречающийся только в `unless`: у отрицания нет состояния, в которое тикет
 *   входит, поэтому стрелкой оно не рисуется и уходит в список «Вне схемы» с причиной
 *   «только в „кроме“»;
 * - ключ, не встречающийся нигде, — «Вне схемы» с причиной «не используется».
 *
 * Подписи меток карта берёт из `document.labels`, подписи стражей — из каталога `guards`
 * того же `GET`, подписи ролей-резолверов и видов ступеней живут здесь и импортируются
 * экраном «Процесс»: двух копий этих подписей в продукте нет.
 */

import {
  PROCESS_LABEL_KEYS,
  type ProcessDocument,
  type ProcessGuard,
  type ProcessLabelKey,
  type ProcessStep,
  type ProcessStepKind,
} from './process';

/** Вид ступени словом: подпись одна на карту и на таблицу процесса. */
export const KIND_TITLES: Record<ProcessStepKind, string> = {
  session: 'сессия',
  route: 'маршрут',
  auto: 'авто',
};

/** Резолверы роли: их выбирает диспетчер, а не документ, но подпись нужна человеку. */
export const RESOLVER_TITLES: Record<string, string> = {
  'by-area': 'по половине работы',
  'by-findings': 'по замечаниям',
};

/** Вид ребра карты: что именно связывает метку и ступень. */
export type ProcessGraphEdgeKind = 'trigger' | 'put' | 'drop';

/**
 * Подписи видов рёбер: ими карта объясняет стрелки, не полагаясь на цвет. Оба текста одного
 * вида живут здесь, а не в разметке: легенда и `<title>` стрелки не расходятся молча.
 */
export type ProcessGraphEdgeTitle = {
  /** Строка легенды: чем этот вид ребра отличается от двух других. */
  legend: string;
  /** Полная фраза для `<title>`: кто, кого и что делает. */
  arrow: (label: string, step: string) => string;
};

export const EDGE_TITLES: Record<ProcessGraphEdgeKind, ProcessGraphEdgeTitle> = {
  trigger: {
    legend: 'метка включает ступень',
    arrow: (label, step) => `Метка «${label}» включает ступень «${step}»`,
  },
  put: {
    legend: 'ступень ставит метку',
    arrow: (label, step) => `Ступень «${step}» ставит метку «${label}»`,
  },
  drop: {
    legend: 'ступень снимает метку',
    arrow: (label, step) => `Ступень «${step}» снимает метку «${label}»`,
  },
};

/** Почему метка не попала в схему. */
export type ProcessGraphUnusedReason = 'unless' | 'unused';

/** Причины словами: их видит человек в строке «Вне схемы». */
export const UNUSED_REASON_TITLES: Record<ProcessGraphUnusedReason, string> = {
  unless: 'только в «кроме»',
  unused: 'не используется',
};

/** Узел-метка: ключ контракта и имя лейбла из документа. */
export type ProcessGraphState = {
  key: ProcessLabelKey;
  name: string;
};

/** Узел-ступень: ступень документа и её подписи, уже готовые к показу. */
export type ProcessGraphStepNode = {
  step: ProcessStep;
  /** Идентификатор узла на полотне: `step:<id>`. */
  nodeId: string;
  kindTitle: string;
  /** Роль строкой: «роль design», «роль: по замечаниям», «роли нет». */
  roleTitle: string;
  /** Название стража из каталога `GET`; `null` — ступень без стража. */
  guardTitle: string | null;
  /** Метки «кроме»: только строкой в узле, ребром не становятся. */
  unlessKeys: ProcessLabelKey[];
};

/** Ребро карты: `from` и `to` — идентификаторы узлов (`label:<ключ>` или `step:<id>`). */
export type ProcessGraphEdge = {
  kind: ProcessGraphEdgeKind;
  key: ProcessLabelKey;
  from: string;
  to: string;
};

/** Метка, которая в схеме не участвует, и причина. */
export type ProcessGraphUnused = {
  key: ProcessLabelKey;
  name: string;
  reason: ProcessGraphUnusedReason;
  reasonTitle: string;
};

/** Всё, что карта знает о документе; порядок узлов — порядок документа. */
export type ProcessGraph = {
  states: ProcessGraphState[];
  steps: ProcessGraphStepNode[];
  edges: ProcessGraphEdge[];
  unused: ProcessGraphUnused[];
};

/** Идентификатор узла-метки: метки и ступени делят одно пространство имён полотна. */
export function labelNodeId(key: ProcessLabelKey): string {
  return `label:${key}`;
}

/** Идентификатор узла-ступени. */
export function stepNodeId(stepId: string): string {
  return `step:${stepId}`;
}

/**
 * Роль ступени словами: у маршрута и авто роли нет, и это сказано, а не оставлено пустым.
 *
 * Резолвер (`by-area`, `by-findings`) — не код роли, а правило выбора, поэтому подписан
 * «роль: по замечаниям»: человеку важно, что роль решает код, а не документ.
 */
export function roleTitle(step: ProcessStep): string {
  if (step.role === null) {
    return step.kind === 'route' ? 'роли нет · решает маршрут' : 'роли нет';
  }
  const resolver = RESOLVER_TITLES[step.role];
  return resolver === undefined ? `роль ${step.role}` : `роль: ${resolver}`;
}

/**
 * Граф по документу: `states`, `steps`, `edges`, `unused`.
 *
 * `guards` — каталог стражей из того же `GET`: название стража приходит с сервера, своей
 * копии каталога фронт не держит. Без каталога в узле остаётся `id` стража — выдумывать
 * название нельзя.
 */
export function buildProcessGraph(
  document: ProcessDocument,
  guards: readonly ProcessGuard[] = [],
): ProcessGraph {
  // Выключенная ступень в конвейере не участвует — и на карте её нет: иначе карта
  // показывала бы больше, чем исполняет диспетчер.
  const enabled = [...document.steps]
    .filter((step) => step.enabled)
    .sort((left, right) => left.priority - right.priority);

  const used = new Set<ProcessLabelKey>();
  for (const step of enabled) {
    for (const key of [...step.when, ...step.put, ...step.drop]) {
      used.add(key);
    }
  }

  // «Кроме» состояния не создаёт, но и молча терять метку нельзя: она уходит в «Вне схемы»
  // с причиной, по которой стрелки у неё нет.
  const unlessOnly = new Set<ProcessLabelKey>();
  for (const step of enabled) {
    for (const key of step.unless) {
      if (!used.has(key)) {
        unlessOnly.add(key);
      }
    }
  }

  const guardTitles = new Map<string, string>();
  for (const guard of guards) {
    guardTitles.set(guard.id, guard.title);
  }

  const states: ProcessGraphState[] = PROCESS_LABEL_KEYS.filter((key) => used.has(key)).map(
    (key) => ({ key, name: document.labels[key] }),
  );

  const steps: ProcessGraphStepNode[] = enabled.map((step) => ({
    step,
    nodeId: stepNodeId(step.id),
    kindTitle: KIND_TITLES[step.kind],
    roleTitle: roleTitle(step),
    guardTitle: step.guard === null ? null : (guardTitles.get(step.guard) ?? step.guard),
    unlessKeys: [...step.unless],
  }));

  // Рёбра — по каждому ключу каждого поля: 17 «когда», 9 «ставит», 7 «снимает» у документа
  // умолчаний. Группировка по виду держит порядок полотна предсказуемым.
  const edges: ProcessGraphEdge[] = [];
  for (const step of enabled) {
    for (const key of step.when) {
      edges.push({ kind: 'trigger', key, from: labelNodeId(key), to: stepNodeId(step.id) });
    }
  }
  for (const step of enabled) {
    for (const key of step.put) {
      edges.push({ kind: 'put', key, from: stepNodeId(step.id), to: labelNodeId(key) });
    }
  }
  for (const step of enabled) {
    for (const key of step.drop) {
      edges.push({ kind: 'drop', key, from: stepNodeId(step.id), to: labelNodeId(key) });
    }
  }

  const unused: ProcessGraphUnused[] = PROCESS_LABEL_KEYS.filter((key) => !used.has(key)).map(
    (key) => {
      const reason: ProcessGraphUnusedReason = unlessOnly.has(key) ? 'unless' : 'unused';
      return {
        key,
        name: document.labels[key],
        reason,
        reasonTitle: UNUSED_REASON_TITLES[reason],
      };
    },
  );

  return { states, steps, edges, unused };
}

/* ---------- раскладка полотна ---------- */

/**
 * Геометрия полотна в координатах `viewBox`. Блоки не зависят от ширины экрана: всю
 * адаптацию делает CSS — масштаб, пока карточка шире полотна, и прокрутка, когда она уже.
 */
export const PROCESS_MAP_GEOMETRY = {
  width: 1000,
  padY: 20,
  labelX: 16,
  labelW: 250,
  labelH: 44,
  stepX: 600,
  stepW: 384,
  stepH: 62,
  stepPitch: 78,
} as const;

/** Куда именно на блоке приходит стрелка: порты не дают стрелкам слипнуться в точку. */
const PORTS = {
  triggerTarget: 0.26,
  putSource: 0.62,
  putTarget: 0.34,
  dropSource: 0.86,
  dropTarget: 0.72,
} as const;

/** Шаг между стрелками, приходящими в один блок: гребёнка вместо одной точки. */
const ARROW_SPREAD = 5;

/**
 * Просвет между блоками меток по вертикали. Метки не привязаны к ступеням шагом: ступеней
 * может быть одна, а меток у неё три, и тогда шаг полотна задают именно метки.
 */
const LABEL_GAP = 12;

/** Узел-метка на полотне: сам узел и его верхняя граница. */
export type PlacedState = { state: ProcessGraphState; top: number };

/** Узел-ступень на полотне. */
export type PlacedStep = { node: ProcessGraphStepNode; top: number };

/** Ребро с готовым путём: `d` — то, что уходит в атрибут `path`. */
export type PlacedEdge = { edge: ProcessGraphEdge; d: string };

/** Готовое полотно: размеры `viewBox`, узлы с координатами и пути рёбер. */
export type ProcessGraphLayout = {
  width: number;
  height: number;
  states: PlacedState[];
  steps: PlacedStep[];
  edges: PlacedEdge[];
};

/** Одна точка с одним знаком после запятой: координаты читаемы, разметка не пухнет. */
function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Кривая от порта к порту: горизонтальные касательные, поэтому стрелки идут слева направо. */
function curvePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const bend = Math.max(24, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  return `M${fmt(from.x)} ${fmt(from.y)}C${fmt(from.x + bend * direction)} ${fmt(from.y)} ${fmt(
    to.x - bend * direction,
  )} ${fmt(to.y)} ${fmt(to.x)} ${fmt(to.y)}`;
}

/**
 * Раскладка графа: метки — вдоль полотна слева, ступени — столбцом справа, в порядке
 * проверки диспетчером. Своих порядков раскладка не вводит: ступени идут в порядке
 * документа, метки — в порядке ключей.
 *
 * Высоту задаёт более высокая колонка, а не одни ступени: у документа с одной ступенью и
 * тремя метками шаг задают метки, иначе они встают в одну точку друг на друга. Пока
 * ступени выше, метки идут против них — первая против первой, последняя против последней.
 */
export function layoutProcessGraph(graph: ProcessGraph): ProcessGraphLayout {
  const { padY, labelX, labelW, labelH, stepX, stepH, stepPitch, width } = PROCESS_MAP_GEOMETRY;

  const stepsCount = graph.steps.length;
  const labelsCount = graph.states.length;
  const stepSpan = stepsCount === 0 ? 0 : (stepsCount - 1) * stepPitch + stepH;
  // Высота, которая нужна меткам, чтобы стоять вплотную друг к другу и не наезжать.
  const labelSpan = labelsCount === 0 ? 0 : labelsCount * (labelH + LABEL_GAP) - LABEL_GAP;
  const span = Math.max(stepSpan, labelSpan, labelH);
  const height = padY * 2 + span;

  const stepTops = new Map<string, number>();
  // Столбец ступеней стоит по центру полотна: когда высоту задали метки, ступень не липнет
  // к верхнему краю, а метки читаются против неё.
  const stepOffset = padY + (span - stepSpan) / 2;
  graph.steps.forEach((node, index) => {
    stepTops.set(node.nodeId, stepOffset + index * stepPitch);
  });

  // Метки выше ступеней — они и задают полотно: первая метка у верхнего края, последняя у
  // нижнего. Иначе первая метка стоит против первой ступени, последняя — против последней:
  // карта читается как «какая метка включает какую ступень», а не как ход тикета.
  const labelsOwnHeight = labelSpan > stepSpan;
  const first = labelsOwnHeight ? padY : padY + (stepH - labelH) / 2;
  const last = labelsOwnHeight
    ? padY + labelSpan - labelH
    : stepsCount === 0
      ? first
      : padY + stepSpan - stepH + (stepH - labelH) / 2;
  const states: PlacedState[] = graph.states.map((state, index) => ({
    state,
    top:
      labelsCount <= 1 ? (first + last) / 2 : first + ((last - first) * index) / (labelsCount - 1),
  }));

  const labelTops = new Map<string, number>();
  for (const placed of states) {
    labelTops.set(labelNodeId(placed.state.key), placed.top);
  }

  // Стрелки в один и тот же блок приходят гребёнкой: иначе семь «progress» сливаются в одну.
  const totals = new Map<string, number>();
  for (const edge of graph.edges) {
    const group = `${edge.kind}|${edge.to}`;
    totals.set(group, (totals.get(group) ?? 0) + 1);
  }
  const seen = new Map<string, number>();

  const edges: PlacedEdge[] = graph.edges.map((edge) => {
    const group = `${edge.kind}|${edge.to}`;
    const total = totals.get(group) ?? 1;
    const index = seen.get(group) ?? 0;
    seen.set(group, index + 1);
    const shift = (index - (total - 1) / 2) * ARROW_SPREAD;

    const stepTop = (nodeId: string): number => stepTops.get(nodeId) ?? padY;
    const labelTop = (nodeId: string): number => labelTops.get(nodeId) ?? padY;

    let from: { x: number; y: number };
    let to: { x: number; y: number };
    if (edge.kind === 'trigger') {
      from = { x: labelX + labelW, y: labelTop(edge.from) + labelH / 2 };
      to = { x: stepX, y: stepTop(edge.to) + stepH * PORTS.triggerTarget + shift };
    } else {
      const source = edge.kind === 'put' ? PORTS.putSource : PORTS.dropSource;
      const target = edge.kind === 'put' ? PORTS.putTarget : PORTS.dropTarget;
      from = { x: stepX, y: stepTop(edge.from) + stepH * source };
      to = { x: labelX + labelW, y: labelTop(edge.to) + labelH * target + shift };
    }

    return { edge, d: curvePath(from, to) };
  });

  return {
    width,
    height,
    states,
    steps: graph.steps.map((node) => ({ node, top: stepTops.get(node.nodeId) ?? padY })),
    edges,
  };
}
