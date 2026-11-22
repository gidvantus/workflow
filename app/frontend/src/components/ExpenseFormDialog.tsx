/**
 * Окно записи в объединённый журнал: дата и четыре количества токенов.
 *
 * Половину журнала выбирать не нужно: это всегда ручная запись (`kind: "manual"`) —
 * смену пишет отдел сам. Суммы в окне нет: её считает сервер по ценам проекта ($ за
 * 1 000 000 токенов) и возвращает снимком в записи. Пустое количество уходит нулём — это
 * «таких токенов не было», а не пропуск поля: обязательных к заполнению чисел в журнале
 * нет, зато запись без единого отличного от нуля количества сервер отклонит своим текстом.
 *
 * Тексты отказов рисуются дословно из `detail`, своих формулировок здесь нет. Единственная
 * строка, которую пишет фронт, — «куда идти за ценами» под отказом «Цены проекта не
 * заполнены»: без неё человек ищет цены там, где их нет. Цены живут в строке цен той же
 * вкладки «Расходы», поэтому и подсказка зовёт туда.
 *
 * `noValidate` на форме — сознательное решение: `type="number"` со `step="1"` иначе
 * перехватил бы дробное количество подсказкой браузера, и до контрактного текста сервера
 * дело не дошло бы. Пустая дата тоже уходит на сервер: `ГГГГ-ММ-ДД` и его отказ — часть
 * контракта, а не проверка браузера.
 */

import { useId, useState, type FormEvent } from 'react';

import { createExpense, type JournalTokens } from '../api/expenses';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import Dialog from './Dialog';

/** Четыре количества токенов: порядок как в ответе API и в строке цен. */
const COUNT_FIELDS = [
  { key: 'tokens_input', apiKey: 'in', label: 'Вход', testId: 'expense-form-tokens-input' },
  { key: 'tokens_output', apiKey: 'out', label: 'Выход', testId: 'expense-form-tokens-output' },
  {
    key: 'tokens_cache_read',
    apiKey: 'cacheRead',
    label: 'Кэш-чтение',
    testId: 'expense-form-tokens-cache-read',
  },
  {
    key: 'tokens_cache_write',
    apiKey: 'cacheWrite',
    label: 'Кэш-запись',
    testId: 'expense-form-tokens-cache-write',
  },
] as const;

type CountKey = (typeof COUNT_FIELDS)[number]['key'];

/** Значения полей как их видит человек: пустое поле — «ноль токенов». */
type Counts = Record<CountKey, string>;

const EMPTY_COUNTS: Counts = {
  tokens_input: '',
  tokens_output: '',
  tokens_cache_read: '',
  tokens_cache_write: '',
};

/**
 * Серверный текст отказа «все четыре цены нули». По нему окно показывает подсказку, куда
 * идти за ценами; сам текст показывается как пришёл.
 */
const NO_PRICES_TEXT = 'Цены проекта не заполнены';

/** Сегодняшняя дата в виде `ГГГГ-ММ-ДД` — по местному календарю, без часового пояса UTC. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Количество в теле запроса: пустое поле — ноль, остальное — как ввёл человек. */
function countValue(value: string): number {
  const text = value.trim();
  return text === '' ? 0 : Number(text);
}

/** Пустое или целое неотрицательное — так количество выглядит правильно. */
function countLooksValid(value: string): boolean {
  const text = value.trim();
  return text === '' || /^\d+$/.test(text);
}

/**
 * Какие поля подсветить под отказом сервера. Текст отказа говорит, что не так, но не
 * в каком поле; своё поле окно находит по своим же значениям — это разметка, а не вторая
 * проверка: отказ всё равно серверный.
 */
function invalidCounts(text: string, counts: Counts): Set<CountKey> {
  const lower = text.toLowerCase();
  if (lower.includes('хотя бы одно')) {
    return new Set(COUNT_FIELDS.map((field) => field.key));
  }
  if (lower.includes('токен')) {
    return new Set(
      COUNT_FIELDS.map((field) => field.key).filter(
        (key) => !countLooksValid(counts[key]),
      ),
    );
  }
  return new Set();
}

type ExpenseFormDialogProps = {
  /** Проект, в журнал которого пишется запись: путь ручки вложен в него. */
  projectId: number;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, журнал и итог перечитываются с сервера. */
  onSaved: () => void;
};

export default function ExpenseFormDialog({
  projectId,
  onClose,
  onSaved,
}: ExpenseFormDialogProps): JSX.Element {
  const formId = useId();
  const [spentOn, setSpentOn] = useState(today());
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const invalid = errorText === null ? new Set<CountKey>() : invalidCounts(errorText, counts);
  const dateInvalid = errorText !== null && errorText.toLowerCase().includes('дата');
  const pricesMissing = errorText !== null && errorText.includes(NO_PRICES_TEXT);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const tokens: JournalTokens = {
        in: countValue(counts.tokens_input),
        out: countValue(counts.tokens_output),
        cacheRead: countValue(counts.tokens_cache_read),
        cacheWrite: countValue(counts.tokens_cache_write),
      };
      await createExpense(projectId, { spent_on: spentOn, tokens });
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="expense-form"
      title="Новая запись"
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="expense-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="expense-form-submit"
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
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-date`}>
            Дата
          </label>
          <input
            className="field__input"
            id={`${formId}-date`}
            type="date"
            value={spentOn}
            aria-invalid={dateInvalid}
            onChange={(event) => setSpentOn(event.target.value)}
            data-testid="expense-form-date"
          />
        </div>

        <fieldset className="dialog__group">
          <legend className="field__label">Количество токенов</legend>
          <div className="form-grid">
            {COUNT_FIELDS.map(({ key, label, testId }) => (
              <div className="field field--tokens" key={key}>
                <label className="field__label" htmlFor={`${formId}-${key}`}>
                  {label}
                </label>
                <input
                  className="field__input"
                  id={`${formId}-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  placeholder="0"
                  value={counts[key]}
                  aria-invalid={invalid.has(key)}
                  onChange={(event) =>
                    setCounts((current) => ({ ...current, [key]: event.target.value }))
                  }
                  data-testid={testId}
                />
              </div>
            ))}
          </div>
        </fieldset>

        <p className="field__hint">Сумму посчитает сервер по ценам проекта.</p>
      </form>

      {errorText !== null && (
        <p className="error" role="alert" data-testid="expense-form-error">
          {errorText}
        </p>
      )}

      {pricesMissing && (
        <p className="field__hint">
          Задайте цены кнопкой «Изменить» в строке цен на вкладке «Расходы».
        </p>
      )}
    </Dialog>
  );
}
