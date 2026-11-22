/**
 * Карточка «Расходы проекта»: шапка с итогом и кнопкой «Добавить запись», строка цен за
 * токены, состояния загрузки, пустого журнала и ошибки загрузки, строки записей.
 *
 * Цены приходят с проектом, а не с журналом, поэтому строка цен на месте и пока журнал
 * читается. Ввод цен — отдельное окно (`ProjectPricesDialog`): здесь только чтение
 * четырёх чисел и одна кнопка «Изменить». Всё, что про деньги, живёт на этой вкладке.
 *
 * Сумму записи и итог фронт не считает: сервер отдаёт строки ровно с двумя знаками,
 * здесь они переставляются в вид `0,41 ₽` и `10,53 ₽`.
 *
 * Записи за один день — отдельные строки: группировки по дате нет, порядок задаёт сервер
 * (`spent_on DESC, id DESC`). Нулевые количества не печатаются: «вход 1 500 000» без
 * «выход 0» — это запись про один вид токенов, а не потеря данных.
 *
 * Правки и удаления записей в приложении нет: у журнала только чтение и добавление.
 */

import type { ProjectPrices } from '../api/projects';
import type { Expense } from '../api/expenses';
import { formatMoney, formatPrice, formatSpentOn, formatTokens } from '../format';

/**
 * Текст `404` этой ручки. Он же серверный: своих формулировок фронт не придумывает,
 * а по нему понимает, что проекта больше нет, — тогда и цен нет, потому что они часть
 * проекта (макет, кадр 6.5).
 */
const PROJECT_NOT_FOUND_TEXT = 'Проект не найден';

/** Количество записей с правильным окончанием: «1 запись», «2 записи», «6 записей». */
function expensesCount(count: number): string {
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

/** Подписи четырёх количеств: порядок совпадает с порядком в окне записи и в ответе API. */
const TOKEN_FIELDS: { key: keyof ExpenseTokens; label: string }[] = [
  { key: 'tokens_input', label: 'вход' },
  { key: 'tokens_output', label: 'выход' },
  { key: 'tokens_cache_read', label: 'кэш-чтение' },
  { key: 'tokens_cache_write', label: 'кэш-запись' },
];

type ExpenseTokens = Pick<
  Expense,
  'tokens_input' | 'tokens_output' | 'tokens_cache_read' | 'tokens_cache_write'
>;

function ExpenseRow({ expense }: { expense: Expense }): JSX.Element {
  return (
    <li className="expense-row" data-testid="expense-item">
      <p className="expense-row__date" data-testid="expense-item-date">
        {formatSpentOn(expense.spent_on)}
      </p>
      <p className="expense-row__tokens" data-testid="expense-item-tokens">
        {TOKEN_FIELDS.map(({ key, label }) =>
          expense[key] === 0 ? null : (
            <span className="tok" key={key}>
              <span className="tok__label">{label}</span>
              <span className="tok__value">{formatTokens(expense[key])}</span>
            </span>
          ),
        )}
      </p>
      <p className="expense-row__amount" data-testid="expense-item-amount">
        {formatMoney(expense.amount)}
      </p>
    </li>
  );
}

type ExpenseListProps = {
  /** Записи журнала: пустой массив — журнал прочитан и пуст. */
  expenses: Expense[];
  /** Итог проекта строкой с двумя знаками; `null` — журнал ещё не прочитан. */
  total: string | null;
  loading: boolean;
  /** Текст отказа дословно из `detail`; `null` — отказа нет. */
  errorText: string | null;
  prices: ProjectPrices;
  onRetry: () => void;
  onCreate: () => void;
  onEditPrices: () => void;
};

export default function ExpenseList({
  expenses,
  total,
  loading,
  errorText,
  prices,
  onRetry,
  onCreate,
  onEditPrices,
}: ExpenseListProps): JSX.Element {
  const ready = !loading && errorText === null;
  // Четыре нуля — допустимое состояние проекта, но запись с такими ценами сервер
  // отклонит, поэтому строка цен говорит об этом сама, до нажатия «Сохранить».
  const pricesUnset = [
    prices.price_input,
    prices.price_output,
    prices.price_cache_read,
    prices.price_cache_write,
  ].every((price) => Number(price) === 0);
  const pricesVisible = errorText !== PROJECT_NOT_FOUND_TEXT;

  return (
    <section className="card" aria-label="Журнал расходов проекта" data-testid="expenses-card">
      <div className="card__head">
        <h2 className="card__title">Расходы проекта</h2>
        <div className="card__tools">
          {ready && (
            <span className="card__meta" data-testid="expenses-count">
              {expensesCount(expenses.length)}
            </span>
          )}
          {ready && total !== null && (
            <div className="expenses-total">
              <span className="expenses-total__label">Итого</span>
              <span className="expenses-total__value" data-testid="expenses-total">
                {formatMoney(total)}
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
                Цены за токены <span className="prices__unit">· ₽ за 1 млн</span>
              </p>
              <ul className="prices__list">
                <li className="tok">
                  <span className="tok__label">вход</span>
                  <span className="tok__value">{formatPrice(prices.price_input)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">выход</span>
                  <span className="tok__value">{formatPrice(prices.price_output)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">кэш-чтение</span>
                  <span className="tok__value">{formatPrice(prices.price_cache_read)}</span>
                </li>
                <li className="tok">
                  <span className="tok__label">кэш-запись</span>
                  <span className="tok__value">{formatPrice(prices.price_cache_write)}</span>
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

      {loading && (
        <div className="card__body">
          <p className="state__line" aria-live="polite" data-testid="expenses-state">
            Загрузка…
          </p>
        </div>
      )}

      {errorText !== null && (
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

      {ready && expenses.length === 0 && (
        <div className="card__body" data-testid="expenses-empty">
          <p className="state__line">Пока нет записей</p>
          <p className="state__hint">
            Нажмите «Добавить запись» — она появится здесь, а сумма уйдёт в итог.
          </p>
        </div>
      )}

      {ready && expenses.length > 0 && (
        <ul className="table__body" data-testid="expenses-list">
          {expenses.map((expense) => (
            <ExpenseRow key={expense.id} expense={expense} />
          ))}
        </ul>
      )}
    </section>
  );
}
