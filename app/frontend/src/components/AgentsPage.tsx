/**
 * Раздел «Агенты»: справочник исполнителей ступеней конвейера.
 *
 * Агент не принадлежит отделу и не выбирается на ступени: он стоит на **теге** проекта
 * (вкладка «Процесс»), а ступень берёт его из своих входящих тегов. Поэтому здесь только
 * справочник — «агент / среда / на связи / действия» — и heartbeat последнего сообщения.
 *
 * **На связи.** `status.state` и тикет — последний heartbeat: `busy` значит, что агент
 * работает над тикетом, `idle` — что свободен. `seen_at: null` — агент ещё не выходил на
 * связь. Показываем словами; цвет несёт только точка, чтобы состояние читалось и без цвета.
 *
 * **Код.** Задаётся при создании и не меняется: по нему приходит heartbeat. В строке он
 * стоит моноширинно рядом с названием, а не отдельным полем правки.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  RUNTIME_SHORT,
  deleteAgent,
  listAgents,
  type Agent,
} from '../api/agents';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import AgentFormDialog from './AgentFormDialog';
import ConfirmDialog from './ConfirmDialog';

const MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

/** Время heartbeat в виде «24 ноя, 18:36»: без ICU и без секунд. */
function formatSeen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = MONTHS[date.getMonth()] ?? '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${month}, ${hours}:${minutes}`;
}

/** Состояние агента словами: слово + тикет + время. */
function statusText(agent: Agent): string {
  const { state, issue_number: issue, seen_at: seenAt } = agent.status;
  if (seenAt === null) {
    return 'не выходил на связь';
  }
  const when = formatSeen(seenAt);
  if (state === 'busy') {
    return issue === null ? `работает · ${when}` : `работает над #${issue} · ${when}`;
  }
  if (state === 'idle') {
    return `свободен · ${when}`;
  }
  return `не сообщал состояние · ${when}`;
}

/** «1 агент», «2 агента», «5 агентов». */
function agentsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} агент`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} агента`;
  }
  return `${count} агентов`;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; agents: Agent[] }
  | { status: 'error'; errorText: string };

type DialogState = { kind: 'create' } | { kind: 'edit'; agent: Agent } | { kind: 'delete'; agent: Agent } | null;

export default function AgentsPage({
  onCountChange,
}: {
  /** Число живых агентов для счётчика меню; `null` — раздел ещё не прочитан. */
  onCountChange?: (count: number | null) => void;
}): JSX.Element {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async (): Promise<void> => {
    setList({ status: 'loading' });
    onCountChange?.(null);
    try {
      const agents = await listAgents();
      setList({ status: 'ready', agents });
      onCountChange?.(agents.length);
    } catch (error) {
      setList({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
      onCountChange?.(null);
    }
  }, [onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  function closeDialog(): void {
    setDialog(null);
  }

  const agents = list.status === 'ready' ? list.agents : null;

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">Агенты</span>
        </p>
      </header>

      <main className="content" data-testid="agents-page">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Агенты</h1>
            <p className="page-head__sub">
              Исполнители ступеней конвейера. Агент выбирается на теге проекта, а ступень
              берёт его из своих входящих тегов; выключенный агент возвращает ступени
              диспетчеру.
            </p>
          </div>
          <button
            className="btn btn--dark"
            type="button"
            data-testid="agent-create"
            onClick={() => setDialog({ kind: 'create' })}
          >
            Добавить агента
          </button>
        </div>

        <section className="card">
          <div className="card__head">
            <h2 className="card__title">Справочник агентов</h2>
            <span className="card__meta">{agents === null ? '' : agentsCount(agents.length)}</span>
          </div>

          {list.status === 'loading' && (
            <div className="card__body">
              <p className="state__line" data-testid="agents-state">
                Загрузка…
              </p>
            </div>
          )}

          {list.status === 'error' && (
            <div className="card__body">
              <div className="state__error">
                <p className="error" data-testid="agents-error" role="alert">
                  {list.errorText}
                </p>
                <button
                  className="btn"
                  type="button"
                  data-testid="agents-retry"
                  onClick={() => void load()}
                >
                  Повторить
                </button>
              </div>
            </div>
          )}

          {agents !== null && agents.length === 0 && (
            <div className="card__body">
              <p className="state__line" data-testid="agents-empty">
                Агентов пока нет
              </p>
              <p className="state__hint">
                Пока агентов нет, все ступени берёт диспетчер. Агент заводится кнопкой
                «Добавить агента», а ступень отдаётся ему тегом на вкладке «Процесс».
              </p>
            </div>
          )}

          {agents !== null && agents.length > 0 && (
            <>
              <div className="table__head table__head--agent" role="presentation">
                <span>Агент</span>
                <span>Среда</span>
                <span>На связи</span>
                <span>Действия</span>
              </div>
              <ul className="table__body" data-testid="agents-list">
                {agents.map((agent) => (
                  <li
                    className={agent.enabled ? 'row row--agent' : 'row row--agent row--off'}
                    key={agent.id}
                    data-testid="agent-item"
                    data-agent-code={agent.code}
                  >
                    <div className="row__main">
                      <p className="row__name">{agent.title}</p>
                      <p className="row__desc row__code">{agent.code}</p>
                    </div>
                    <p className="row__date">{RUNTIME_SHORT[agent.runtime]}</p>
                    <p className="agent-status" data-testid="agent-status">
                      <span
                        className={
                          agent.status.state === 'busy'
                            ? 'agent-dot agent-dot--busy'
                            : agent.status.state === 'idle'
                              ? 'agent-dot agent-dot--idle'
                              : 'agent-dot'
                        }
                        aria-hidden="true"
                      />
                      {statusText(agent)}
                      {!agent.enabled && <span className="agent-off"> · выключен</span>}
                    </p>
                    <div className="row__actions">
                      <button
                        className="btn"
                        type="button"
                        data-testid="agent-edit"
                        onClick={() => setDialog({ kind: 'edit', agent })}
                      >
                        Изменить
                      </button>
                      <button
                        className="btn btn--danger"
                        type="button"
                        data-testid="agent-delete"
                        onClick={() => setDialog({ kind: 'delete', agent })}
                      >
                        Удалить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>

      {dialog !== null && dialog.kind === 'create' && (
        <AgentFormDialog
          mode="create"
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void load();
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'edit' && (
        <AgentFormDialog
          mode="edit"
          agent={dialog.agent}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void load();
          }}
        />
      )}

      {dialog !== null && dialog.kind === 'delete' && (
        <ConfirmDialog
          testId="agent-delete-confirm"
          title="Удалить агента?"
          text={`Агент «${dialog.agent.title}» исчезнет из списка, а его теги перестанут отдавать ступени гостю — их снова возьмёт диспетчер. Код останется занятым навсегда.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteAgent(dialog.agent.id);
            closeDialog();
            void load();
          }}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
