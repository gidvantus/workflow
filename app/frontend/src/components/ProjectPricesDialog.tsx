/**
 * Окно «Цены за токены» — единственное место, где цены вводятся.
 *
 * Открывается с вкладки «Расходы» кнопкой «Изменить» в строке цен: всё, что про деньги,
 * живёт на этой вкладке, а форма проекта (в списке проектов) деньгами не занимается.
 * `PATCH` отправляет ровно четыре поля — остальные поля проекта окно не трогает.
 *
 * Цены — доллары США за 1 000 000 токенов. Сервер отдаёт их строкой с шестью знаками
 * (`"0.270000"`), в поле печатается без хвостовых нулей (`0,27`): человек видит то, что
 * отправляет обратно. Пустое поле уходит нулём — «не тарифицируется». Запятая ввода
 * переводится в точку: в контракте запроса точка.
 *
 * Единица названа и здесь, и в строке цен: без неё четыре числа читались бы как деньги
 * вообще, а не как цена за миллион токенов.
 *
 * Тексты отказов — серверные, дословно. Подсветка поля под отказом считается по введённым
 * значениям: текст говорит, что не так, но не в каком поле, и своё поле окно находит само.
 * Это разметка, а не вторая проверка — отказ всё равно приходит с сервера.
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import { updateProjectPrices, type Project, type ProjectPrices } from '../api/projects';
import { formatPrice } from '../format';
import Dialog from './Dialog';

/** Четыре цены: порядок как в строке цен и в ответе API. */
const PRICE_FIELDS = [
  { key: 'price_input', label: 'Вход', testId: 'prices-form-price-input' },
  { key: 'price_output', label: 'Выход', testId: 'prices-form-price-output' },
  { key: 'price_cache_read', label: 'Кэш-чтение', testId: 'prices-form-price-cache-read' },
  { key: 'price_cache_write', label: 'Кэш-запись', testId: 'prices-form-price-cache-write' },
] as const;

type PriceKey = (typeof PRICE_FIELDS)[number]['key'];

/** Значения полей как их видит человек: с запятой, без хвостовых нулей. */
type Prices = Record<PriceKey, string>;

/** Цены проекта в поля окна: `"0.270000"` → `0,27`. */
function pricesOf(project: Project): Prices {
  return {
    price_input: formatPrice(project.price_input),
    price_output: formatPrice(project.price_output),
    price_cache_read: formatPrice(project.price_cache_read),
    price_cache_write: formatPrice(project.price_cache_write),
  };
}

/** Цена в теле запроса: пустое поле — ноль, запятая — точка. */
function priceValue(value: string): string {
  const text = value.trim().replace(',', '.');
  return text === '' ? '0' : text;
}

/** Какие поля подсветить под отказом сервера — по введённым значениям, не по тексту. */
function invalidPrices(text: string, prices: Prices): Set<PriceKey> {
  const lower = text.toLowerCase();
  const keys = PRICE_FIELDS.map((field) => field.key);
  if (lower.includes('отрицательн')) {
    return new Set(keys.filter((key) => Number(priceValue(prices[key])) < 0));
  }
  if (lower.includes('числом')) {
    return new Set(
      keys.filter((key) => {
        const value = priceValue(prices[key]);
        return !/^-?\d+(?:\.\d+)?$/.test(value);
      }),
    );
  }
  return new Set();
}

type ProjectPricesDialogProps = {
  project: Project;
  onClose: () => void;
  /** Сохранение прошло: окно закрывается, страница берёт проект из ответа. */
  onSaved: (project: Project) => void;
};

export default function ProjectPricesDialog({
  project,
  onClose,
  onSaved,
}: ProjectPricesDialogProps): JSX.Element {
  const formId = useId();
  const [prices, setPrices] = useState<Prices>(pricesOf(project));
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const invalid = errorText === null ? new Set<PriceKey>() : invalidPrices(errorText, prices);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    const input: ProjectPrices = {
      price_input: priceValue(prices.price_input),
      price_output: priceValue(prices.price_output),
      price_cache_read: priceValue(prices.price_cache_read),
      price_cache_write: priceValue(prices.price_cache_write),
    };
    try {
      onSaved(await updateProjectPrices(project.id, input));
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="prices-form"
      title="Цены за токены"
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="prices-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="prices-form-submit"
            disabled={busy}
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <form
        className="dialog__form"
        id={formId}
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
      >
        <p className="field__hint">В долларах США за 1 млн токенов.</p>

        <div className="form-grid">
          {PRICE_FIELDS.map(({ key, label, testId }) => (
            <div className="field field--price" key={key}>
              <label className="field__label" htmlFor={`${formId}-${key}`}>
                {label}
              </label>
              <input
                className="field__input"
                id={`${formId}-${key}`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={prices[key]}
                aria-invalid={invalid.has(key)}
                onChange={(event) =>
                  setPrices((current) => ({ ...current, [key]: event.target.value }))
                }
                data-testid={testId}
              />
            </div>
          ))}
        </div>

        <p className="field__hint">
          Ноль — «не тарифицируется». Цены применяются к новым записям; суммы, уже
          записанные в журнал, сами не пересчитываются — сумму строки меняет кнопка
          «Пересчитать».
        </p>
      </form>

      {errorText !== null && (
        <p className="error" role="alert" data-testid="prices-form-error">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
