/**
 * Карточка «Расходы проекта» — единственный раздел денег проекта.
 *
 * До #72 деньги жили на двух вкладках: ручные записи в «Стоимости», смены в «Расходах»,
 * и одна и та же стоимость проекта стояла на экране дважды и по-разному. Теперь журнал
 * один: `GET /api/projects/{id}/expenses` отдаёт обе половины одним списком, строку
 * отличает `kind` — `manual` или `shift`. Вкладка «Стоимость» удалена, а второе число
 * осталось одно — в паспорте проекта, чтобы человек мог проверить первое.
 *
 * Что здесь читается и как показывается:
 *
 * - итог (`total`) и суммы строк (`amount`) — строки с шестью знаками, посчитанные
 *   сервером. Фронт их не складывает и не пересчитывает: `formatCost` выбирает, сколько
 *   знаков показать (`119,23 $`, а ненулевую мелочь — `0,0004 $`);
 * - цены проекта ($ за 1 000 000 токенов) печатаются строкой под шапкой; окно их правки
 *   живёт здесь же, потому что деньги проекта теперь в одном месте;
 * - различие половин — два признака, а не цвет: у смены есть вторая строка даты
 *   (интервал) и кнопка «Сессии», у ручной записи нет ни того, ни другого. Числа ручной
 *   записи и есть запись, раскрывать её некуда;
 * - детализация смены — прежний экран: возврат, итог смены и список сессий. Снимок цен
 *   смены (`rates`) не печатается: вторые цены на экране снова развели бы деньги на два
 *   прайса, а цена видна в строке цен.
 *
 * Состояния карточки: загрузка, пустой журнал, отказ с дословным текстом сервера и
 * «Повторить», «Проект не найден» (ни цен, ни итога — числа нет, а не ноль) и «цены не
 * заданы» (подпись красная, кнопка зовёт задать цены). Строка цен остаётся на месте и при
 * загрузке, и при отказе журнала: цены приходят с проектом, а не с журналом.
 */

import { useCallback, useRef, useState } from 'react';

import type { JournalEntry, JournalTokens } from '../api/expenses';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import type { Project } from '../api/projects';
import { loadShiftDetail, type UsageSession, type UsageShiftDetail } from '../api/usage';
import { formatCost, formatPrice, formatSpentOn, formatTokens } from '../format';

/**
 * Отказ «проекта нет»: в этом состоянии карточка не показывает ни цен, ни итога.
 * Текст сверяется дословно — он приходит от сервера и на экран уходит как есть.
 */
const PROJECT_NOT_FOUND_TEXT = 'Проект не найден';

/** Четыре вида токенов в порядке показа: две пары в двух колонках (`.journal-row__tokens`). */
const TOKEN_FIELDS: { key: keyof JournalTokens; label: string }[] = [
  { key: 'in', label: 'вход' },
  { key: 'out', label: 'выход' },
  { key: 'cacheRead', label: 'кэш-чтение' },
  { key: 'cacheWrite', label: 'кэш-запись' },
];

/** Две цифры: часы, минуты, дни и месяцы в журнале набраны одного размера. */
function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Время момента по местному времени браузера: `09:00`.
 *
 * Строку с датой фронт не разбирает вручную: сервер присылает ISO с часовым поясом, а
 * показывать смену человеку надо в его времени. Нечитаемая дата — пустая строка: рисовать
 * вместо неё выдуманное число хуже, чем не рисовать ничего.
 */
function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Момент в виде `19.11 09:00` — по местному времени браузера.
 *
 * Дата внутри дня печатается и у начала, и у конца смены: окно может перейти через
 * полночь, и тогда `22:00 → 03:00` без дат читалось бы как три часа вместо пяти.
 */
function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${formatClock(value)}`;
}

/** Интервал смены для детализации: `19.11 09:00 → 19.11 17:00`. */
function formatPeriod(startedAt: string, endedAt: string): string {
  return `${formatMoment(startedAt)} → ${formatMoment(endedAt)}`;
}

/** Интервал смены в строке журнала: `09:00 → 17:00` — дата уже стоит слева. */
function formatClockRange(startedAt: string, endedAt: string): string {
  return `${formatClock(startedAt)} → ${formatClock(endedAt)}`;
}

/** Смена в русском счёте: «1 смена», «2 смены», «5 смен». */
function shiftsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} смена`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} смены`;
  }
  return `${count} смен`;
}

/** Запись в русском счёте: «1 запись», «2 записи», «7 записей». */
function entriesLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} запись`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} записи`;
  }
  return `${count} записей`;
}

/** Ручная запись в русском счёте: «1 ручная запись», «4 ручные записи», «5 ручных записей». */
function manualLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} ручная запись`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} ручные записи`;
  }
  return `${count} ручных записей`;
}

/** Сессия в русском счёте для подписи под меткой смены: «3 сессии». */
function sessionsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} сессия`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} сессии`;
  }
  return `${count} сессий`;
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

/** Счётчик записей: «7 записей · 3 смены и 4 ручные записи» — по половинам журнала. */
function journalCount(entries: JournalEntry[]): string {
  const shifts = entries.filter((entry) => entry.kind === 'shift').length;
  const manual = entries.length - shifts;
  const base = entriesLabel(entries.length);
  if (shifts === 0 || manual === 0) {
    return base;
  }
  return `${base} · ${shiftsLabel(shifts)} и ${manualLabel(manual)}`;
}

/** Сумма токенов строки для итога смены: складывается только для показа. */
function tokensTotal(tokens: JournalTokens): number {
  return tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite;
}

type DetailState =
  | { status: 'closed' }
  | { status: 'loading'; shiftId: number }
  | { status: 'ready'; shift: UsageShiftDetail }
  | { status: 'error'; errorText: string };

type JournalRowProps = {
  entry: JournalEntry;
  onOpen: (shiftId: number) => void;
};

/**
 * Строка журнала: пять колонок вместо трёх у ручной записи и шести у смены.
 *
 * Источник — общий признак строки, а не повод рисовать вторую вкладку, поэтому у обеих
 * половин одна сетка `when · source · tokens · amount · open`. Пустые виды токенов не
 * печатаются: ноль в этой ведомости не факт, а отсутствие факта.
 */
function JournalRow({ entry, onOpen }: JournalRowProps): JSX.Element {
  const isShift = entry.kind === 'shift';
  const spentOn = formatSpentOn(entry.spent_on);
  const period =
    entry.started_at !== undefined && entry.ended_at !== undefined
      ? formatClockRange(entry.started_at, entry.ended_at)
      : null;
  return (
    <li className="journal-row" data-testid="expense-item">
      <div className="journal-row__when">
        <p className="journal-row__date" data-testid="expense-item-date">
          {spentOn}
        </p>
        {period !== null && <p className="journal-row__period">{period}</p>}
      </div>
      <div className="journal-row__source">
        <p className="journal-row__source-label" data-testid="expense-item-source">
          {isShift ? 'смена' : 'ручная запись'}
        </p>
        {isShift && entry.sessions_count !== undefined && entry.reason !== undefined && (
          <p className="journal-row__source-note">
            {sessionsLabel(entry.sessions_count)} · {reasonLabel(entry.reason)}
          </p>
        )}
      </div>
      <p className="journal-row__tokens" data-testid="expense-item-tokens">
        {TOKEN_FIELDS.map(({ key, label }) =>
          entry.tokens[key] === 0 ? null : (
            <span className="tok" key={key}>
              <span className="tok__label">{label}</span>
              <span className="tok__value">{formatTokens(entry.tokens[key])}</span>
            </span>
          ),
        )}
      </p>
      <p className="journal-row__amount" data-testid="expense-item-amount">
        {formatCost(entry.amount)}
      </p>
      {isShift && (
        <div className="journal-row__open">
          {/* Доступное имя начинается с видимой подписи «Сессии» (WCAG 2.5.3, «Label in
              Name»): человек, управляющий голосом, произносит то, что видит, а скринридер
              читает то же действие. Дата и интервал отличают строки между собой, но
              видимую подпись не подменяют. */}
          <button
            className="btn"
            type="button"
            data-testid="expense-open"
            aria-label={`Сессии смены ${spentOn} с ${
              entry.started_at === undefined ? '' : formatClock(entry.started_at)
            } до ${entry.ended_at === undefined ? '' : formatClock(entry.ended_at)}`}
            onClick={() => onOpen(entry.id)}
          >
            Сессии
          </button>
        </div>
      )}
    </li>
  );
}

type SessionRowProps = {
  session: UsageSession;
};

/** Строка сессии: роль, тикет, ходы, токены и цена. Суммы пришли записанными. */
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
        {formatTokens(tokensTotal(session.tokens))}
      </p>
      <p className="expense-session__amount" data-testid="expense-session-cost">
        {formatCost(session.cost_usd)}
      </p>
    </li>
  );
}

type ProjectExpensesProps = {
  /** Карточка целиком: по ней печатаются цены строки цен и суммы не трогаются. */
  project: Project;
  /** Обе половины журнала: пустой массив — журнал прочитан и пуст. */
  entries: JournalEntry[];
  /** Итог проекта строкой с шестью знаками; `null` — журнал ещё не прочитан. */
  total: string | null;
  loading: boolean;
  /** Текст отказа дословно из `detail`; `null` — отказа нет. */
  errorText: string | null;
  onRetry: () => void;
  onCreate: () => void;
  onEditPrices: () => void;
};

export default function ProjectExpenses({
  project,
  entries,
  total,
  loading,
  errorText,
  onRetry,
  onCreate,
  onEditPrices,
}: ProjectExpensesProps): JSX.Element {
  const [detail, setDetail] = useState<DetailState>({ status: 'closed' });
  // Номер последнего запроса детализации: ответ, пришедший после возврата к журналу, на
  // экран не попадает. Без него «← К проекту», нажатое во время загрузки, открывало бы
  // чужую смену на месте уже закрытой карточки.
  const detailRequest = useRef(0);
  const ready = !loading && errorText === null;
  // Четыре нуля — допустимое состояние проекта, но запись с такими ценами сервер
  // отклонит, поэтому строка цен говорит об этом сама, до нажатия «Сохранить».
  const pricesUnset = [
    project.price_input,
    project.price_output,
    project.price_cache_read,
    project.price_cache_write,
  ].every((price) => Number(price) === 0);
  const pricesVisible = errorText !== PROJECT_NOT_FOUND_TEXT;

  const closeDetail = useCallback((): void => {
    detailRequest.current += 1;
    setDetail({ status: 'closed' });
  }, []);

  const openShift = useCallback((shiftId: number): void => {
    detailRequest.current += 1;
    const request = detailRequest.current;
    setDetail({ status: 'loading', shiftId });
    void (async (): Promise<void> => {
      try {
        const loaded = await loadShiftDetail(shiftId);
        if (detailRequest.current === request) {
          setDetail({ status: 'ready', shift: loaded });
        }
      } catch (error) {
        if (detailRequest.current === request) {
          setDetail({
            status: 'error',
            errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
          });
        }
      }
    })();
  }, []);

  if (detail.status === 'ready') {
    const { shift } = detail;
    return (
      <section className="card" data-testid="expense-detail" aria-label="Смена">
        <div className="card__head">
          <h2 className="card__title">
            Смена ·{' '}
            <span data-testid="expense-detail-period">
              {formatPeriod(shift.started_at, shift.ended_at)}
            </span>
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

        <div className="card__body card__body--tight">
          <p className="expenses-total expenses-total--left">
            {'Сессий: '}
            <span className="expenses-total__value">{shift.sessions_count}</span>
            {' · токенов: '}
            {formatTokens(tokensTotal(shift.tokens))}
            {' · сумма: '}
            <span className="expenses-total__value" data-testid="expense-detail-cost">
              {formatCost(shift.cost_usd)}
            </span>
          </p>
        </div>

        <ul className="table__body">
          {shift.sessions.map((session) => (
            <SessionRow key={session.session} session={session} />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="card card--journal" aria-label="Расходы проекта" data-testid="expenses-card">
      <div className="card__head">
        <h2 className="card__title">Расходы проекта</h2>
        <div className="card__tools">
          {ready && (
            <span className="card__meta" data-testid="expenses-count">
              {journalCount(entries)}
            </span>
          )}
          {ready && total !== null && (
            <div className="cost-sum">
              <span className="cost-sum__label">Итого</span>
              <span className="cost-sum__value" data-testid="expenses-total">
                {formatCost(total)}
              </span>
            </div>
          )}
          <button
            className="btn btn--dark"
            type="button"
            data-testid="expense-create"
            onClick={onCreate}
          >
            Добавить запись
          </button>
        </div>
      </div>

      {pricesVisible && (
        <div
          className={pricesUnset ? 'card__prices card__prices--unset' : 'card__prices'}
          data-testid="expenses-prices"
        >
          {pricesUnset ? (
            <>
              <p className="prices__label">Цены не заданы</p>
              <p className="prices__note">
                Пока все четыре цены нули, сервер отклонит любую запись.
              </p>
            </>
          ) : (
            <>
              <p className="prices__label">
                Цены за токены <span className="prices__unit">· $ за 1 млн</span>
              </p>
              <ul className="prices__list">
                <li className="tok">
                  <span className="tok__label">вход</span>
                  <span className="tok__value">{formatPrice(project.price_input)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">выход</span>
                  <span className="tok__value">{formatPrice(project.price_output)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">кэш-чтение</span>
                  <span className="tok__value">{formatPrice(project.price_cache_read)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">кэш-запись</span>
                  <span className="tok__value">{formatPrice(project.price_cache_write)}</span>
                </li>
              </ul>
            </>
          )}
          <button
            className={pricesUnset ? 'btn btn--dark' : 'btn'}
            type="button"
            data-testid="expenses-prices-edit"
            onClick={onEditPrices}
          >
            {pricesUnset ? 'Задать цены' : 'Изменить'}
          </button>
        </div>
      )}

      {detail.status === 'loading' && (
        <div className="card__body">
          <p className="state__line" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {detail.status === 'error' && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" role="alert">
              {detail.errorText}
            </p>
            <button className="btn" type="button" onClick={closeDetail}>
              ← К проекту
            </button>
          </div>
        </div>
      )}

      {detail.status === 'closed' && loading && (
        <div className="card__body">
          <p className="state__line" data-testid="expenses-state" aria-live="polite">
            Загрузка…
          </p>
        </div>
      )}

      {detail.status === 'closed' && errorText !== null && (
        <div className="card__body">
          <div className="state__error">
            <p className="error" role="alert" data-testid="expenses-error">
              {errorText}
            </p>
            <button className="btn" type="button" data-testid="expenses-retry" onClick={onRetry}>
              Повторить
            </button>
          </div>
        </div>
      )}

      {detail.status === 'closed' && ready && entries.length === 0 && (
        <div className="card__body" data-testid="expenses-empty">
          <p className="state__line">Пока нет записей</p>
          <p className="state__hint">
            Смены приходят сами, когда отдел закрывает смену проекта. Ручную запись добавьте
            кнопкой «Добавить запись».
          </p>
        </div>
      )}

      {detail.status === 'closed' && ready && entries.length > 0 && (
        <ul className="table__body" data-testid="expenses-list">
          {entries.map((entry) => (
            <JournalRow key={`${entry.kind}-${entry.id}`} entry={entry} onOpen={openShift} />
          ))}
        </ul>
      )}
    </section>
  );
}
