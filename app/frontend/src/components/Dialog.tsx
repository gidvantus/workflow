/**
 * Общая оболочка диалога: подложка, `role="dialog"`, `aria-modal`, Esc, удержание Tab
 * внутри окна и возврат фокуса на элемент, который окно открыл.
 *
 * Логика запроса и текстов живёт в конкретных диалогах; здесь только поведение окна,
 * чтобы форма проекта и подтверждение удаления не расходились в мелочах.
 */

import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';

/** Что можно получить фокусом внутри окна. Выключенные кнопки в обход не попадают. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type DialogProps = {
  /** `data-testid` окна по контракту: `project-form` или `project-delete-confirm`. */
  testId: string;
  title: ReactNode;
  /** id элемента с пояснением под заголовком, если он есть. */
  describedBy?: string;
  onClose: () => void;
  /** Пока идёт запрос, окно не закрывается ни Esc, ни подложкой, ни крестиком. */
  busy: boolean;
  children: ReactNode;
  /** Кнопки окна: порядок «Отмена», затем основное действие. */
  actions: ReactNode;
  /**
   * Широкое окно: форма отдела показывает десять чекбоксов в две колонки, в обычную
   * ширину диалога они не влезают. Узкое окно — поведение по умолчанию.
   */
  wide?: boolean;
};

export default function Dialog({
  testId,
  title,
  describedBy,
  onClose,
  busy,
  children,
  actions,
  wide = false,
}: DialogProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Обработчики ставятся один раз: свежие значения props читаются через refs,
  // иначе новая ссылка на onClose перезапускала бы эффект и сбрасывала фокус.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const previouslyFocused = document.activeElement;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    // Первый фокус — на первом поле окна: крестик в шапке стоит в разметке раньше,
    // но начинать с него неудобно. Запасные варианты — первая кнопка и сам диалог.
    const field = dialog.querySelector<HTMLElement>('input, textarea, select');
    const [firstFocusable] = focusables();
    (field ?? firstFocusable ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (busyRef.current) {
          return;
        }
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      const active = document.activeElement;
      const activeInside = active !== null && dialog.contains(active);
      // Tab с последнего элемента уходит на первый и наоборот. Если фокус уже выбило
      // наружу (например, кликом по подложке во время запроса), он затягивается обратно:
      // `aria-modal="true"` обещает, что остальная страница инертна.
      if (event.shiftKey && (active === first || active === dialog || !activeInside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !activeInside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, []);

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>): void {
    // Клик по подложке, а не по содержимому окна, закрывает его — но не во время запроса.
    if (event.target === event.currentTarget && !busy) {
      onClose();
    }
  }

  return (
    <div className="overlay" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className={wide ? 'dialog dialog--wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-testid={testId}
        tabIndex={-1}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          <button
            className="dialog__close"
            type="button"
            aria-label="Закрыть окно"
            onClick={onClose}
            disabled={busy}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>

        {children}

        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
