/**
 * Клиент раздела «Агенты»: справочник агентов и их heartbeat.
 *
 * Агент — исполнитель ступени конвейера. Ступень агента не выбирает: агент стоит на
 * **теге** проекта (вкладка «Процесс»), а ступень берёт его из своих входящих тегов.
 * Поэтому здесь только справочник: `GET`, `POST`, `PATCH`, `DELETE`.
 *
 * **Код неизменяем.** `code` задаётся при создании и дальше не меняется: по нему приходит
 * машинный heartbeat, и смена кода молча отвязала бы агента от тегов. В тело `PATCH`
 * `code` не попадает вовсе.
 *
 * **Heartbeat.** `status.state` — `idle`/`busy`, `status.issue_number` — тикет, над
 * которым агент работает, `status.seen_at` — время последнего сообщения. `state: null` —
 * агент ещё не выходил на связь. Пишет его сам агент через `PUT /api/agents/{code}/status`,
 * фронт только читает.
 *
 * Тексты отказов — часть контракта: сервер присылает их в `detail`, и они показываются
 * дословно, своих формулировок фронт не придумывает.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';

const AGENTS_URL = '/api/agents';

/** Среда исполнения агента: второй рантайм диспетчер пока не запускает. */
export type AgentRuntime = 'dsh' | 'opencode' | 'http';

/** Подписи сред для карточек окна «Новый агент». */
export const RUNTIME_TITLES: Record<AgentRuntime, string> = {
  dsh: 'dsh — диспетчер',
  opencode: 'opencode',
  http: 'http',
};

/** Подписи сред для таблицы. */
export const RUNTIME_SHORT: Record<AgentRuntime, string> = {
  dsh: 'dsh',
  opencode: 'opencode',
  http: 'http',
};

export const RUNTIME_OPTIONS: AgentRuntime[] = ['dsh', 'opencode', 'http'];

/** Последний heartbeat агента. */
export type AgentStatus = {
  /** `idle`/`busy`; `null` — агент ещё не сообщал. */
  state: 'idle' | 'busy' | null;
  /** Тикет, над которым идёт работа; `null` — тикета нет. */
  issue_number: number | null;
  /** Время последнего сообщения ISO; `null` — не сообщал. */
  seen_at: string | null;
};

/** Агент в ответах `/api/agents`. */
export type Agent = {
  id: number;
  /** Слаг: по нему приходит heartbeat. Задаётся при создании и не меняется. */
  code: string;
  title: string;
  runtime: AgentRuntime;
  /** Выключенный агент возвращает свои ступени диспетчеру. */
  enabled: boolean;
  status: AgentStatus;
};

/** Тело `POST /api/agents`. */
export type AgentCreateInput = {
  code: string;
  title: string;
  runtime: AgentRuntime;
  enabled: boolean;
};

/** Тело `PATCH /api/agents/{id}`: кода здесь нет — он не меняется. */
export type AgentUpdateInput = {
  title: string;
  runtime: AgentRuntime;
  enabled: boolean;
};

function readRuntime(value: unknown): AgentRuntime | null {
  return value === 'dsh' || value === 'opencode' || value === 'http' ? value : null;
}

function readStatus(value: unknown): AgentStatus {
  if (!isRecord(value)) {
    return { state: null, issue_number: null, seen_at: null };
  }
  const state = value.state === 'idle' || value.state === 'busy' ? value.state : null;
  return {
    state,
    issue_number: typeof value.issue_number === 'number' ? value.issue_number : null,
    seen_at: typeof value.seen_at === 'string' ? value.seen_at : null,
  };
}

function readAgent(payload: unknown): Agent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const runtime = readRuntime(payload.runtime);
  const { id, code, title, enabled } = payload;
  if (
    typeof id !== 'number' ||
    typeof code !== 'string' ||
    typeof title !== 'string' ||
    typeof enabled !== 'boolean' ||
    runtime === null
  ) {
    return null;
  }
  return { id, code, title, runtime, enabled, status: readStatus(payload.status) };
}

async function readAgentBody(response: Response): Promise<Agent> {
  const agent = readAgent(await readJson(response));
  if (agent === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return agent;
}

/** `GET /api/agents` — только живые агенты, порядок задаёт сервер (по `id`). */
export async function listAgents(): Promise<Agent[]> {
  const response = await send(AGENTS_URL, { method: 'GET' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const agents: Agent[] = [];
  for (const item of payload) {
    const agent = readAgent(item);
    if (agent === null) {
      throw new ApiError(UNREACHABLE_TEXT);
    }
    agents.push(agent);
  }
  return agents;
}

/** `POST /api/agents` — `201` и созданный агент; занятый код — `409`. */
export async function createAgent(input: AgentCreateInput): Promise<Agent> {
  const response = await send(AGENTS_URL, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readAgentBody(response);
}

/** `PATCH /api/agents/{id}` — `200` и обновлённый агент; `code` не отправляется. */
export async function updateAgent(id: number, patch: AgentUpdateInput): Promise<Agent> {
  const response = await send(`${AGENTS_URL}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  return readAgentBody(response);
}

/** `DELETE /api/agents/{id}` — `204` без тела: мягкое удаление, код занят навсегда. */
export async function deleteAgent(id: number): Promise<void> {
  const response = await send(`${AGENTS_URL}/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
}
