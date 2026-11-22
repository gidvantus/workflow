/**
 * Карточка «Расходы проекта»: итог журнала, список смен и детализация одной смены.
 *
 * Третья вкладка страницы проекта. Журнал — снимок закрытых смен: harness посчитал цену
 * сам и прислал смену с тарифами и сессиями, поэтому здесь нет ни формулы, ни курса, ни
 * пересчёта — только чтение четырёх ручек из `api/usage.ts`.
 *
 * Деньги фронт не складывает и не округляет до хранения: сумма проекта — `totals.cost_usd`
 * из ответа, сумма смены — `cost_usd` её строки, сумма сессии — её собственная `cost_usd`.
 * Округление до двух знаков — только вид (`12,34 $`), а не вычисление.
 *
 * Состояния: загрузка, пустой журнал («Пока нет данных о расходе»), отказ с «Повторить»
 * и недоступный `api` («Сервер не отвечает»). У детализации свои состояния: «Загрузка…»,
 * отказ с дословным текстом сервера (`404 Смена не найдена`) и возврат «← К проекту».
 *
 * `projectRef` — id проекта из реестра отдела: журнал живёт отдельно от справочника
 * `projects`. `rebuild` берёт для реестра `project.code or str(project.id)`
 * (`app/api/registry.py`), поэтому страница проекта передаёт сюда
 * `project.code ?? String(project.id)` — ту же пару, что попадает в документ реестра.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import {
  loadProjectUsage,
  loadShiftDetail,
  type ProjectUsage,
  type UsageSession,
  type UsageShift,
  type UsageShiftDetail,
  type UsageTokens,
} from '../api/usage';

/** Две цифры: часы, минуты, дни и месяцы в журнале набраны одного размера. */
function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Момент в виде `01.11 13:00` — по местному времени браузера.
 *
 * Строку с датой фронт не разбирает вручную: сервер присылает ISO с часовым поясом, а
 * показывать смену человеку надо в его времени. Нечитаемая дата — пустая строка: рисовать
 * вместо неё выдуманное число хуже, чем не рисовать ничего.
 */
function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Интервал смены: `01.11 13:00 → 02.11 04:00`. */
function formatPeriod(startedAt: string, endedAt: string): string {
  return `${formatMoment(startedAt)} → ${formatMoment(endedAt)}`;
}

/** Тысячи через пробел: `1234567` → `1 234 567`. */
function groupDigits(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Деньги для экрана: строка ответа с шестью знаками → `12,34 $`.
 *
 * Округление до копеек — вид, а не пересчёт: в хранилище и в ответах остаются те же
 * шесть знаков, и следующая смена их не «поправит». Нечисловая строка показывается как
 * есть — выдумывать за сервер сумму фронт не должен.
 */
function formatMoney(amount: string): string {
  const value = Number(amount.trim().replace(',', '.'));
  if (!Number.isFinite(value)) {
    return amount.trim();
  }
  const [whole = '0', fraction = '00'] = value.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${fraction} $`;
}

/** Токены одной парой чисел: журнал показывает их общим счётом, а не разбивкой. */
function tokensTotal(tokens: UsageTokens): number {
  return tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite;
}

/** Токены для экрана: `1 234 567`. */
function formatTokens(tokens: UsageTokens): string {
  return groupDigits(tokensTotal(tokens));
}

/** Причина закрытия смены по-русски; неизвестную показываем как есть. */
function reasonLabel(reason: string): string {
  if (reason === 'window') {
    return 'окно смены';
  }
  if (reason === 'manual') {
    return 'вручную';
  }
  return reason;
}

/** Ходы с правильным окончанием: «1 ход», «2 хода», «5 ходов». */
function turnsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} ход`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} хода`;
  }
  return `${count} ходов`;
}

/** Тикет сессии: «#57 Название», только номер или «без тикета». */
function issueLabel(session: UsageSession): string {
  if (session.issue_number === null) {
    return 'без тикета';
  }
  const number = `#${session.issue_number}`;
  if (session.issue_title === null || session.issue_title === '') {
    return number;
  }
  return `${number} ${session.issue_title}`;
}

type UsageState =
  | { status: 'loading' }
  | { status: 'ready'; usage: ProjectUsage }
  | { status: 'empty' }
  | { status: 'error'; errorText: string };

type DetailState =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'ready'; shift: UsageShiftDetail }
  | { status: 'error'; errorText: string };

type ShiftRowProps = {
  shift: UsageShift;
  onOpen: (shift: UsageShift) => void;
};

/** Строка журнала: интервал, причина, число сессий, токены, сумма и вход в детализацию. */
function ShiftRow({ shift, onOpen }: ShiftRowProps): JSX.Element {
  const period = formatPeriod(shift.started_at, shift.ended_at);
  return (
    <li className="expense-row" data-testid="expense-item">
      <p className="expense-row__date" data-testid="expense-item-period">
        {period}
      </p>
      <p className="expense-row__reason" data-testid="expense-item-reason">
        {reasonLabel(shift.reason)}
      </p>
      <p className="expense-row__count" data-testid="expense-item-sessions">
        {shift.sessions_count}
      </p>
      <p className="expense-row__tokens" data-testid="expense-item-tokens">
        {formatTokens(shift.tokens)}
      </p>
      <p className="expense-row__amount" data-testid="expense-item-cost">
        {formatMoney(shift.cost_usd)}
      </p>
      <div className="expense-row__open">
        {/* Доступное имя начинается с видимой подписи «Сессии» (WCAG 2.5.3, «Label in
            Name»): человек, управляющий голосом, произносит то, что видит, а скринридер
            читает то же действие. Период отличает строки между собой, но видимую подпись
            не подменяет. */}
        <button
          className="btn"
          type="button"
          data-testid="expense-open"
          aria-label={`Сессии смены ${period}`}
          onClick={() => onOpen(shift)}
        >
          Сессии
        </button>
      </div>
    </li>
  );
}

type SessionRowProps = {
  session: UsageSession;
};

/** Строка сессии: роль, тикет, ходы, токены и цена. */
function SessionRow({ session }: SessionRowProps): JSX.Element {
  return (
    <li className="expense-session" data-testid="expense-session">
      <p className="expense-session__role" data-testid="expense-session-role">
        {session.role}
      </p>
      <p className="expense-session__issue" data-testid="expense-session-issue">
        {issueLabel(session)}
      </p>
      <p className="expense-session__turns">{turnsLabel(session.turns)}</p>
      <p className="expense-session__tokens" data-testid="expense-session-tokens">
        {formatTokens(session.tokens)}
      </p>
      <p className="expense-session__amount" data-testid="expense-session-cost">
        {formatMoney(session.cost_usd)}
      </p>
    </li>
  );
}

type ProjectExpensesProps = {
  /** id проекта в реестре отдела (`project_ref` журнала). */
  projectRef: string;
};

export default function ProjectExpenses({ projectRef }: ProjectExpensesProps): JSX.Element {
  const listTitleId = useId();
  const detailTitleId = useId();
  const [usage, setUsage] = useState<UsageState>({ status: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ status: 'closed' });
  /** id смены, ответ на которую сейчас ждём: чужие ответы отбрасываются. */
  const pendingShift = useRef<number | null>(null);

  /** Журнал проекта всегда читается с сервера: «Повторить» — это повторный запрос. */
  const loadUsage = useCallback(async (): Promise<void> => {
    setUsage({ status: 'loading' });
    try {
      const loaded = await loadProjectUsage(projectRef);
      // `null` — `404`: смен ещё нет. Это пустой журнал, а не отказ.
      if (loaded === null || loaded.shifts.length === 0) {
        setUsage({ status: 'empty' });
        return;
      }
      setUsage({ status: 'ready', usage: loaded });
    } catch (error) {
      setUsage({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, [projectRef]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  /**
   * Детализация читается отдельным запросом: в списке сессий нет.
   *
   * Открыть смену, вернуться и открыть другую можно быстрее, чем придёт первый ответ
   * (таймаут запроса — 5 с). Без памяти о том, чей ответ ждём, опоздавший ответ первой
   * смены подменил бы экран второй, поэтому `pendingShift` хранит последний запрошенный
   * id, а чужие ответы отбрасываются — и данные, и отказ.
   */
  const loadDetail = useCallback(async (shiftId: number): Promise<void> => {
    pendingShift.current = shiftId;
    setDetail({ status: 'loading' });
    try {
      const loaded = await loadShiftDetail(shiftId);
      if (pendingShift.current !== shiftId) {
        return;
      }
      setDetail({ status: 'ready', shift: loaded });
    } catch (error) {
      if (pendingShift.current !== shiftId) {
        return;
      }
      setDetail({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  /** Возврат к журналу: запрошенная смена забывается, опоздавший ответ уже не нужен. */
  function closeDetail(): void {
    pendingShift.current = null;
    setDetail({ status: 'closed' });
  }

  function handleOpen(shift: UsageShift): void {
    void loadDetail(shift.id);
  }

  /**
   * Состояния карточки одной смены. Возврат есть в каждом из них: иначе отказ `404 Смена
   * не найдена` запирал бы человека в детализации без выхода.
   */
  if (detail.status !== 'closed') {
    const shift = detail.status === 'ready' ? detail.shift : null;
    return (
      <section className="card" data-testid="expense-detail" aria-labelledby={detailTitleId}>
        <div className="card__head">
          <h2 className="card__title" id={detailTitleId}>
            {'Смена'}
            {shift !== null && (
              <>
                {' · '}
                <span data-testid="expense-detail-period">
                  {formatPeriod(shift.started_at, shift.ended_at)}
                </span>
              </>
            )}
          </h2>
          <button
            className="btn"
            type="button"
            data-testid="expense-detail-back"
            onClick={closeDetail}
          >
            ← К проекту
          </button>
        </div>

        {detail.status === 'loading' && (
          <div className="card__body">
            <p className="state__line" data-testid="expense-detail-state" aria-live="polite">
              Загрузка…
            </p>
          </div>
        )}

        {detail.status === 'error' && (
          <div className="card__body">
            <p className="error" data-testid="expense-detail-error" role="alert">
              {detail.errorText}
            </p>
          </div>
        )}

        {shift !== null && (
          <>
            <div className="card__body card__body--tight">
              <p className="expenses-total expenses-total--left">
                {'Сессий: '}
                <span className="expenses-total__value">{shift.sessions.length}</span>
                {' · токенов: '}
                {formatTokens(shift.tokens)}
                {' · сумма: '}
                <span className="expenses-total__value" data-testid="expense-detail-cost">
                  {formatMoney(shift.cost_usd)}
                </span>
              </p>
            </div>
            {shift.sessions.length === 0 ? (
              <div className="card__body">
                <p className="state__line" data-testid="expense-detail-empty">
                  В этой смене нет сессий
                </p>
              </div>
            ) : (
              <ul className="table__body" data-testid="expense-session-list">
                {shift.sessions.map((session) => (
                  <SessionRow key={session.session} session={session} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby={listTitleId}>
      <div className="card__head">
        <h2 className="card__title" id={listTitleId}>
          Расходы проекта
        </h2>
        {usage.status === 'ready' && (
          // Итог — только когда есть хотя бы одна смена: нулевую сумму за пустой журнал
          // экран не рисует, «Пока нет данных о расходе» и есть ответ.
          <p className="expenses-total" data-testid="expense-total">
            {'Смен: '}
            <span data-testid="expense-total-shifts">{usage.usage.totals.shifts}</span>
            {' · сессий: '}
            <span data-testid="expense-total-sessions">{usage.usage.totals.sessions}</span>
            {' · токенов: '}
            {formatTokens(usage.usage.totals.tokens)}
            {' · сумма: '}
            <span className="expenses-total__value" data-testid="expense-total-cost">
              {formatMoney(usage.usage.totals.cost_usd)}
            </span>
          </p>
        )}
      </div>

      {usage.status === 'loading' && (
        <div className="card__body">
          <p className="state__line" data-testid="expenses-state" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {usage.status === 'error' && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" data-testid="expense-error" role="alert">
              {usage.errorText}
            </p>
            <button
              className="btn"
              type="button"
              data-testid="expenses-retry"
              onClick={() => void loadUsage()}
            >
              Повторить
            </button>
          </div>
        </div>
      )}

      {usage.status === 'empty' && (
        <div className="card__body">
          <p className="state__line" data-testid="expenses-empty">
            Пока нет данных о расходе
          </p>
          <p className="state__hint">
            Журнал пополнится, когда смена проекта закроется и пришлёт свой расход.
          </p>
          {/* Ссылку журнала видно глазами: `404` у смен не отличается от «журнал пуст», и
              при расхождении id проекта веба и id реестра отдела это единственный признак,
              что смотрим не на тот проект. */}
          <p className="state__hint" data-testid="expenses-ref">
            {`Запрошен журнал проекта «${projectRef}»`}
          </p>
        </div>
      )}

      {usage.status === 'ready' && (
        <ul className="table__body" data-testid="expenses-list">
          {usage.usage.shifts.map((shift) => (
            <ShiftRow key={shift.id} shift={shift} onOpen={handleOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}
