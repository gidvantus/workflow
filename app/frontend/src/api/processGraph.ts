/**
 * Карта процесса: разбор документа в граф ступеней — без React и без запросов.
 *
 * Документ процесса (`GET /api/departments/{id}/process`) — это таблица ступеней, а не
 * картинка. Узлы карты — **только ступени**; метки живут внутри узла, строками «вход»,
 * «выход» и «снимает». Так карта читается как конвейер, а не как справочник меток: между
 * двумя ступенями идёт провод, если одна ставит метку, а другая берёт её в `when`.
 *
 * Что узлом **не** становится и проводом **не** рисуется:
 *
 * - выключенная ступень (`enabled: false`) — диспетчер её пропускает, и на карте её нет
 *   вместе с её проводами;
 * - ключ, встречающийся только в `unless`: у отрицания нет состояния, в которое тикет
 *   входит, поэтому стрелкой оно не рисуется и уходит в список «Вне схемы» с причиной
 *   «только в „кроме“»;
 * - ключ, не встречающийся нигде, — «Вне схемы» с причиной «не используется».
 *
 * Подписи меток карта берёт из `document.tags` (`name` — метка на GitHub), подписи стражей —
 * из каталога `guards` того же `GET`, подписи ролей-резолверов и видов ступеней живут
 * здесь и импортируются экраном «Процесс»: двух копий этих подписей в продукте нет.
 */

import {
  PROCESS_LABEL_KEYS,
  tagNameOf,
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

/**
 * Вид ступени с пояснением: чем вид отличается для человека. Текст один на легенду карточки
 * (`mockups/75`, кадр 1) — второй копии этих пояснений в разметке нет.
 */
export const KIND_HINTS: Record<ProcessStepKind, string> = {
  session: '— запускает агента в роли',
  route: '— решает роль по работе',
  auto: '— переносит метки, без агента',
};

/** Резолверы роли: их выбирает диспетчер, а не документ, но подпись нужна человеку. */
export const RESOLVER_TITLES: Record<string, string> = {
  'by-area': 'по половине работы',
  'by-findings': 'по замечаниям',
};

/**
 * Правило провода одним предложением: его читает человек в легенде карты и в подсказке
 * панели. Второго текста того же правила в разметке нет.
 */
export const WIRE_RULE =
  'Провод соединяет две ступени: одна ставит метку, другая берёт её в «когда».';

/** Почему метка не попала в схему. */
export type ProcessGraphUnusedReason = 'unless' | 'unused';

/** Причины словами: их видит человек в строке «Вне схемы». */
export const UNUSED_REASON_TITLES: Record<ProcessGraphUnusedReason, string> = {
  unless: 'только в «кроме»',
  unused: 'не используется',
};

/** Метка в узле ступени: ключ контракта, имя лейбла из документа и откуда метка берётся. */
export type ProcessGraphLabel = {
  key: ProcessLabelKey;
  /** Имя тега из `document.tags`; пустая строка — имени в документе нет. */
  name: string;
  /**
   * `true` — метку ставит включённая ступень, то есть на карте у неё есть источник;
   * `false` — метку ставит роль или человек вне документа, и точка входа рисуется кольцом.
   */
  fromStep: boolean;
};

/** Узел-ступень: ступень документа и её подписи, уже готовые к показу. */
export type ProcessGraphStepNode = {
  step: ProcessStep;
  kindTitle: string;
  /** Роль строкой: «роль design», «роль: по замечаниям», «роли нет». */
  roleTitle: string;
  /** Название стража из каталога `GET`; `null` — ступень без стража. */
  guardTitle: string | null;
  whenLabels: ProcessGraphLabel[];
  putLabels: ProcessGraphLabel[];
  dropLabels: ProcessGraphLabel[];
  /** Метки «кроме»: строкой в узле, проводом не становятся. */
  unlessLabels: ProcessGraphLabel[];
  /** Сколько проводов входит в ступень и выходит из неё — строка «на карте» в панели. */
  wiresIn: number;
  wiresOut: number;
};

/**
 * Провод карты: ступень `from` ставит метку `key`, ступень `to` берёт её в `when`.
 * Названия ступеней продублированы здесь, чтобы подпись провода строилась из одного
 * объекта и не расходилась с узлами при переименовании.
 */
export type ProcessWire = {
  /** Идентификатор провода: `wire:<from>-><to>:<key>`. */
  id: string;
  key: ProcessLabelKey;
  labelName: string;
  from: string;
  to: string;
  fromTitle: string;
  toTitle: string;
};

/** Подпись провода для `<title>` и для панели: кто ставит, какой меткой и кто её берёт. */
export function wireTitle(wire: ProcessWire): string {
  return `«${wire.fromTitle}» ставит метку «${wire.labelName}», её берёт «${wire.toTitle}»`;
}

/** Метка, которая в схеме не участвует, и причина. */
export type ProcessGraphUnused = {
  key: ProcessLabelKey;
  name: string;
  reason: ProcessGraphUnusedReason;
  reasonTitle: string;
};

/** Сколько связей в документе по полям: их называет чип чисел на карточке. */
export type ProcessGraphLinks = {
  when: number;
  put: number;
  drop: number;
  total: number;
};

/** Всё, что карта знает о документе; порядок узлов — порядок документа (`priority`). */
export type ProcessGraph = {
  steps: ProcessGraphStepNode[];
  wires: ProcessWire[];
  unused: ProcessGraphUnused[];
  links: ProcessGraphLinks;
};

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
 * Граф по документу: `steps`, `wires`, `unused`, `links`.
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

  const guardTitles = new Map<string, string>();
  for (const guard of guards) {
    guardTitles.set(guard.id, guard.title);
  }

  // Какие метки ставит хоть одна включённая ступень: у таких меток на карте есть источник,
  // и точка входа залита. Остальные приходят извне карты — точка входа рисуется кольцом.
  const putByStep = new Set<ProcessLabelKey>();
  for (const step of enabled) {
    for (const key of step.put) {
      putByStep.add(key);
    }
  }

  const label = (key: ProcessLabelKey): ProcessGraphLabel => ({
    key,
    name: tagNameOf(document, key),
    fromStep: putByStep.has(key),
  });

  const links: ProcessGraphLinks = {
    when: enabled.reduce((sum, step) => sum + step.when.length, 0),
    put: enabled.reduce((sum, step) => sum + step.put.length, 0),
    drop: enabled.reduce((sum, step) => sum + step.drop.length, 0),
    total: 0,
  };
  links.total = links.when + links.put + links.drop;

  // Провода: `put` одной ступени ∩ `when` другой. Пара считается один раз на метку: две
  // ступени, ставящие одну метку, дают по проводу в каждую, кто её берёт.
  const wires: ProcessWire[] = [];
  const seen = new Set<string>();
  for (const source of enabled) {
    if (source.put.length === 0) {
      continue;
    }
    for (const target of enabled) {
      if (target.id === source.id) {
        // Ступень, которая берёт собственную метку, проводом не рисуется: петля на полотне
        // не читается, а в документе это почти наверняка не задумано.
        continue;
      }
      for (const key of source.put) {
        if (!target.when.includes(key)) {
          continue;
        }
        const id = `wire:${source.id}->${target.id}:${key}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        wires.push({
          id,
          key,
          labelName: tagNameOf(document, key),
          from: source.id,
          to: target.id,
          fromTitle: source.title,
          toTitle: target.title,
        });
      }
    }
  }

  const wiresIn = new Map<string, number>();
  const wiresOut = new Map<string, number>();
  for (const wire of wires) {
    wiresOut.set(wire.from, (wiresOut.get(wire.from) ?? 0) + 1);
    wiresIn.set(wire.to, (wiresIn.get(wire.to) ?? 0) + 1);
  }

  const nodes: ProcessGraphStepNode[] = enabled.map((step) => ({
    step,
    kindTitle: KIND_TITLES[step.kind],
    roleTitle: roleTitle(step),
    guardTitle: step.guard === null ? null : (guardTitles.get(step.guard) ?? step.guard),
    whenLabels: step.when.map(label),
    putLabels: step.put.map(label),
    dropLabels: step.drop.map(label),
    unlessLabels: step.unless.map(label),
    wiresIn: wiresIn.get(step.id) ?? 0,
    wiresOut: wiresOut.get(step.id) ?? 0,
  }));

  // «Кроме» узлом не становится, но и молча терять метку нельзя: она уходит в «Вне схемы»
  // с причиной, по которой провода у неё нет.
  // Метка «на карте», если она стоит у включённой ступени хоть в одном из трёх полей:
  // «вне схемы» — это про метки, которых на полотне не видно вообще.
  const used = new Set<ProcessLabelKey>(putByStep);
  for (const step of enabled) {
    for (const key of [...step.when, ...step.drop]) {
      used.add(key);
    }
  }
  const unlessOnly = new Set<ProcessLabelKey>();
  for (const step of enabled) {
    for (const key of step.unless) {
      if (!used.has(key)) {
        unlessOnly.add(key);
      }
    }
  }

  const unused: ProcessGraphUnused[] = PROCESS_LABEL_KEYS.filter((key) => !used.has(key)).map(
    (key) => {
      const reason: ProcessGraphUnusedReason = unlessOnly.has(key) ? 'unless' : 'unused';
      return {
        key,
        name: tagNameOf(document, key),
        reason,
        reasonTitle: UNUSED_REASON_TITLES[reason],
      };
    },
  );

  return { steps: nodes, wires, unused, links };
}

/* ---------- раскладка полотна ---------- */

/**
 * Геометрия полотна в пикселях. Блоки не зависят от ширины экрана: всю адаптацию делает
 * CSS — прокрутка, пока полотно шире карточки, и список блоков на узком экране.
 *
 * Колонки идут по четыре блока в порядке `priority`, поэтому все провода направлены
 * вправо: документ читается слева направо, как конвейер.
 */
export const PROCESS_MAP_GEOMETRY = {
  blockW: 296,
  blockH: 160,
  /** Просвет между колонками: в нём живут провода. */
  colGap: 104,
  rowGap: 20,
  pad: 12,
  perColumn: 4,
  /**
   * Строки блока, на которых живут порты: вход — строка «ВХОД» (её видно по точке у метки),
   * выход — строка «ВЫХОД». Провод поэтому выходит и входит на уровне своей строки, как в макете.
   */
  inRow: 73,
  outRow: 99,
  /** Точка провода у блока не сливается с рамкой. */
  portInset: 8,
  /** Гребёнка портов: шаг между проводами, приходящими в один блок. */
  portStep: 6.5,
} as const;

/** Минимальное колено кривой: без него короткий провод читается как отрезок. */
const MIN_BEND = 28;

/** Ступень на полотне: сам узел и его координаты. */
export type PlacedStep = {
  node: ProcessGraphStepNode;
  /** Порядковый номер в документе: по нему считается колонка и строка. */
  index: number;
  column: number;
  x: number;
  y: number;
};

/** Точка на полотне. */
export type MapPoint = { x: number; y: number };

/** Провод с готовым путём: `d` — то, что уходит в атрибут `path`. */
export type PlacedWire = {
  wire: ProcessWire;
  from: MapPoint;
  to: MapPoint;
  d: string;
};

/** Готовое полотно: размеры, блоки с координатами и пути проводов. */
export type ProcessGraphLayout = {
  width: number;
  height: number;
  steps: PlacedStep[];
  wires: PlacedWire[];
};

/** Число в атрибуте пути: без хвостов плавающей точки, чтобы разметка не «дрожала». */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Кривая провода: колено строится по половине просвета между блоками, поэтому линия
 * выходит из «выхода» горизонтально и так же входит в следующий блок.
 */
function curvePath(from: MapPoint, to: MapPoint): string {
  const bend = Math.max(MIN_BEND, (to.x - from.x) * 0.45);
  return `M${num(from.x)} ${num(from.y)}C${num(from.x + bend)} ${num(from.y)} ${num(
    to.x - bend,
  )} ${num(to.y)} ${num(to.x)} ${num(to.y)}`;
}

/**
 * Раскладка полотна: блоки колонками по четыре, провода — от «выхода» источника к гребёнке
 * портов на левом краю цели. Порты раздвинуты: семь проводов в одну точку слиплись бы в
 * одну стрелку, и карта показывала бы одну связь вместо семи.
 *
 * Неполная последняя колонка центрируется по высоте: одинокая ступень «Продолжение взятой
 * работы» стоит посередине, как в макете, а не прилипает к верхнему краю.
 */
export function layoutProcessGraph(graph: ProcessGraph): ProcessGraphLayout {
  const G = PROCESS_MAP_GEOMETRY;
  const count = graph.steps.length;
  const columns = Math.max(1, Math.ceil(count / G.perColumn));
  const rows = Math.max(1, Math.min(G.perColumn, count));

  const width = G.pad * 2 + columns * G.blockW + (columns - 1) * G.colGap;
  const height = G.pad * 2 + rows * G.blockH + (rows - 1) * G.rowGap;

  // Сколько блоков в каждой колонке: по нему считается вертикальный отступ центрирования.
  const inColumn = new Array<number>(columns).fill(0);
  for (let index = 0; index < count; index += 1) {
    const column = Math.floor(index / G.perColumn);
    inColumn[column] = (inColumn[column] ?? 0) + 1;
  }

  const placed: PlacedStep[] = graph.steps.map((node, index) => {
    const column = Math.floor(index / G.perColumn);
    const row = index % G.perColumn;
    const free = rows - (inColumn[column] ?? 0);
    return {
      node,
      index,
      column,
      x: G.pad + column * (G.blockW + G.colGap),
      y: G.pad + (free * (G.blockH + G.rowGap)) / 2 + row * (G.blockH + G.rowGap),
    };
  });

  const byId = new Map<string, PlacedStep>();
  for (const step of placed) {
    byId.set(step.node.step.id, step);
  }

  const incoming = new Map<string, number>();
  for (const wire of graph.wires) {
    incoming.set(wire.to, (incoming.get(wire.to) ?? 0) + 1);
  }

  // Счётчик уже размещённых проводов на цель: он задаёт место точки в гребёнке.
  const taken = new Map<string, number>();
  const wires: PlacedWire[] = [];
  for (const wire of graph.wires) {
    const from = byId.get(wire.from);
    const to = byId.get(wire.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const total = incoming.get(wire.to) ?? 1;
    const position = taken.get(wire.to) ?? 0;
    taken.set(wire.to, position + 1);
    const spread = total > 1 ? G.portStep * (position - (total - 1) / 2) : 0;
    const end = { x: to.x - G.portInset, y: to.y + G.inRow + spread };

    if (to.column > from.column) {
      // Обычный провод: из «выхода» источника в гребёнку входа цели, слева направо.
      const start = { x: from.x + G.blockW, y: from.y + G.outRow };
      wires.push({ wire, from: start, to: end, d: curvePath(start, end) });
      continue;
    }

    // Колонка цели не правее источника: ступень возвращает работу назад (метку ставит
    // ступень ниже по `priority`, а берёт её ступень выше). Провод выходит из левого края
    // источника и входит в левый порт цели, контрольные точки прижаты к краю полотна, чтобы
    // линия не ушла за него. Блоки промежуточных колонок такой провод не обходит: слой
    // проводов лежит под блоками, и на длинном возврате середина линии скрыта блоками —
    // случай редкий (в умолчаниях возвратов нет), но он намеренно остаётся видимым в
    // данных и в подписи, а не молча пропадает с полотна.
    const start = { x: from.x, y: from.y + G.outRow };
    const bend = Math.max(2, Math.min(MIN_BEND, Math.min(start.x, end.x) - 1));
    const d =
      `M${num(start.x)} ${num(start.y)}` +
      `C${num(Math.max(1, start.x - bend))} ${num(start.y)} ` +
      `${num(Math.max(1, end.x - bend))} ${num(end.y)} ${num(end.x)} ${num(end.y)}`;
    wires.push({ wire, from: start, to: end, d });
  }

  return { width, height, steps: placed, wires };
}
