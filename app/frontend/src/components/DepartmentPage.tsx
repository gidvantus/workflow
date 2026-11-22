/**
 * Страница правки отдела: крошки, «← К проекту», заголовок с видом и датой, форма из
 * блоков, которые задаёт вид отдела.
 *
 * Страница заменяет прежнее окно правки: полей у отдела стало одиннадцать (флаг работы,
 * расписание, роли, шесть машинных строк, лимит возврата и уведомления), и в диалог они
 * не влезают. Адреса у неё нет — как и у страницы проекта, это состояние
 * `ProjectPage`, а не маршрут.
 *
 * **Состав и порядок блоков задаёт контракт.** `department.fields` — массив ключей,
 * который приходит вместе с отделом; фронт рисует только их и в этом порядке, поэтому
 * третий вид (новая строка в базе, новая ревизия) не требует правки этого файла:
 * незнакомый ключ не рисуется и страницу не роняет. Секции ниже — только надзаголовки
 * («Смена», «Где работает отдел», «Возврат и уведомления»): они группируют подписи, но
 * порядок внутри секции — всё равно порядок `fields`.
 *
 * **Подписи и контролы — на фронте**, потому что ключ контракта — это `repo_path`,
 * а не «Путь репозитория»: тексты живут рядом с контролами, а не в API.
 *
 * **Валидации здесь нет.** Длины строк и диапазон лимита возврата проверяет сервер, его
 * текст отказа показывается дословно; своих формулировок страница не придумывает.
 * Единственная подсказка от фронта — «Пустое поле — 3» у лимита и «окно идёт через
 * полночь» у времени.
 *
 * **Время работы — список окон, а не пара.** Рядов от одного до шести: «Добавить окно»
 * добавляет ряд, крестик убирает свой. Границы `1..6` держат сами кнопки — седьмого ряда
 * не добавить, а последний не удалить, — но это удобство, а не замена серверной проверке:
 * пересечения, формат и предел проверяет сервер и отвечает своим текстом, который
 * страница показывает дословно. Порядок окон — серверный: массив уходит как есть, а в
 * ответе приходит отсортированным по возрастанию начала.
 *
 * Рядов не может быть меньше одного, но пустой набор всё же возможен: у отдела,
 * заведённого видом, стоит один пустой ряд, и если все ряды пусты целиком, в тело уходит
 * `windows: []`. Так сервер отвечает «Укажите хотя бы одно окно времени работы» — отказом
 * про окно, а не про формат времени в поле, которого человек не касался.
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';

import {
  listRoles,
  updateDepartment,
  type Department,
  type DepartmentPatch,
  type DepartmentWindow,
  type Role,
} from '../api/departments';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import type { Project } from '../api/projects';
import DepartmentProcess from './DepartmentProcess';

/** Предел окон: тот же `WINDOWS_MAX`, что у сервера. Фронт лишь не даёт добавить седьмое. */
const WINDOWS_MAX = 6;

/** Пустое окно нового ряда: время выбирается из `<input type="time">`, а не набирается. */
const EMPTY_WINDOW: DepartmentWindow = { start_time: '', end_time: '' };

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

/**
 * Дата обновления в виде «28 окт 2026». Тот же разбор, что в `ProjectPage` и
 * `DepartmentList`: свой список месяцев, чтобы не зависеть от ICU.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/**
 * Строковые поля страницы правки: подпись и `data-testid` для каждого ключа контракта.
 * Восемь ключей — восемь подписей; сам ключ в разметку не попадает, но он же приходит
 * в `fields`, поэтому набор и порядок контролов задаёт сервер.
 */
const TEXT_FIELDS = {
  repo_path: { label: 'Путь репозитория', testId: 'department-field-repo' },
  base_branch: { label: 'Базовая ветка', testId: 'department-field-base' },
  workspace: { label: 'Рабочее пространство отдела', testId: 'department-field-workspace' },
  human_workspace: {
    label: 'Рабочее пространство человека',
    testId: 'department-field-human-workspace',
  },
  artifacts_dir: {
    label: 'Директория для сохранения документов',
    testId: 'department-field-artifacts',
  },
  compose_project: { label: 'Название проекта в Docker', testId: 'department-field-compose' },
} as const;

type TextFieldKey = keyof typeof TEXT_FIELDS;

const TEXT_FIELD_KEYS: readonly string[] = Object.keys(TEXT_FIELDS);

/** Ключ контракта — строковое поле страницы, а не один из блоков `schedule`/`roles`. */
function isTextFieldKey(key: string): key is TextFieldKey {
  return TEXT_FIELD_KEYS.includes(key);
}

/**
 * Секции страницы: надзаголовок и ключи, которые в нём живут. Секция не задаёт порядок —
 * он берётся из `department.fields`; ключ, которого нет ни в одной секции, не рисуется.
 */
const SECTIONS: readonly { title: string; keys: readonly string[] }[] = [
  { title: 'Смена', keys: ['enabled', 'schedule', 'roles'] },
  {
    title: 'Где работает отдел',
    keys: [
      'repo_path',
      'base_branch',
      'workspace',
      'human_workspace',
      'artifacts_dir',
      'compose_project',
    ],
  },
  { title: 'Возврат и уведомления', keys: ['max_rework', 'notifications'] },
];

/** Поле, к которому относится серверный отказ — нужно только для `aria-invalid`. */
type InvalidTarget =
  | TextFieldKey
  | 'telegram_token'
  | 'telegram_chat_id'
  | 'max_rework'
  | 'schedule'
  | 'roles'
  | null;

/**
 * Поле, к которому относится текст отказа. Контракт адресует отказ текстом, а не именем
 * поля, поэтому связь «текст → поле» живёт здесь: у каждой строки таблицы отказов свой
 * узнаваемый оборот, и подпись поля совпадает с началом текста.
 *
 * У окон времени работы подпись одна на список, а отказов у них четыре формы
 * («Укажите хотя бы одно окно времени работы», «Окон времени работы не может быть больше
 * шести», «Время работы указывается как ЧЧ:ММ…», «Окна времени работы пересекаются»),
 * поэтому ловится общий корень «врем»: все они про расписание, и `aria-invalid` встаёт на
 * все поля окон сразу — какое именно виновато, контракт не говорит.
 */
function invalidTargetFor(text: string): InvalidTarget {
  const lower = text.toLowerCase();
  if (lower.includes('путь репозитория')) {
    return 'repo_path';
  }
  if (lower.includes('базовая ветка')) {
    return 'base_branch';
  }
  if (lower.includes('рабочее пространство отдела')) {
    return 'workspace';
  }
  if (lower.includes('рабочее пространство человека')) {
    return 'human_workspace';
  }
  if (lower.includes('директория для сохранения документов')) {
    return 'artifacts_dir';
  }
  if (lower.includes('название проекта в docker')) {
    return 'compose_project';
  }
  if (lower.includes('api telegram')) {
    return 'telegram_token';
  }
  if (lower.includes('ваш id')) {
    return 'telegram_chat_id';
  }
  if (lower.includes('лимит возврата')) {
    return 'max_rework';
  }
  if (lower.includes('врем')) {
    return 'schedule';
  }
  if (lower.includes('роль')) {
    return 'roles';
  }
  return null;
}

/** Пустое поле уходит как `null`, всё остальное — как ввели: длину проверяет сервер. */
function emptyToNull(text: string): string | null {
  return text === '' ? null : text;
}

/**
 * Значение поля «Лимит возврата задачи». Контракт объявляет `integer`, а поле на экране —
 * текст: уходит строка цифр, сервер приводит её к числу (проверено на стенде), а пустое
 * поле — `null`, то есть умолчание сервера. Диапазон `0..99` фронт не проверяет: отказ
 * приходит серверным текстом.
 *
 * Нецифры в поле не набираются (см. `onChange` ниже), поэтому `422` схемы на нечисловой
 * ввод с экрана недостижим: своего текста у такого отказа нет, и в интерфейсе он выглядел
 * бы как «Сервер не отвечает».
 */
function reworkOf(text: string): string | null {
  return text === '' ? null : text;
}

/** Состояние справочника ролей на странице: он нужен, только если вид показал блок `roles`. */
type RolesState =
  | { status: 'loading' }
  | { status: 'ready'; roles: Role[] }
  | { status: 'error'; errorText: string };

type DepartmentPageProps = {
  /** Проект отдела: крошки и путь возврата. */
  project: Project;
  /** Отдел, который правится: заголовок, вид, дата и значения полей. */
  department: Department;
  /** «← К проекту» и «Отмена»: возврат без запроса. */
  onBack: () => void;
  /** Сохранение прошло: страница закрывается, список отделов перечитывается. */
  onSaved: () => void;
};

export default function DepartmentPage({
  project,
  department,
  onBack,
  onSaved,
}: DepartmentPageProps): JSX.Element {
  const idPrefix = useId();
  const errorId = useId();
  const rolesLabelId = useId();
  const reworkHintId = useId();

  const [texts, setTexts] = useState<Record<TextFieldKey, string>>(() => ({
    repo_path: department.repo_path ?? '',
    base_branch: department.base_branch ?? '',
    workspace: department.workspace ?? '',
    human_workspace: department.human_workspace ?? '',
    artifacts_dir: department.artifacts_dir ?? '',
    compose_project: department.compose_project ?? '',
  }));
  /**
   * Окна работы. В серверном порядке, как пришли; у отдела без расписания (создан видом,
   * вид без `schedule`) — один пустой ряд, потому что расписание заполняется здесь, а не
   * в окне создания. Пустой набор в базу не уходит: сервер отказывает своим текстом.
   */
  const [windows, setWindows] = useState<DepartmentWindow[]>(() =>
    department.windows.length > 0 ? department.windows : [{ ...EMPTY_WINDOW }],
  );
  const [selectedRoleIds, setSelectedRoleIds] = useState<number[]>(() =>
    department.roles.map((role) => role.id),
  );
  const [maxRework, setMaxRework] = useState(String(department.max_rework));
  /**
   * Флаг работы отдела. Берётся из ответа как есть: умолчание `true` и смысл флага —
   * серверные, фронт значение не выводит из других полей (пустое расписание ≠ выключено)
   * и ничего не подставляет вместо отсутствующего ключа.
   */
  const [enabled, setEnabled] = useState(department.enabled);
  const [notifications, setNotifications] = useState(department.notifications_enabled);
  const [telegramToken, setTelegramToken] = useState(department.telegram_token ?? '');
  const [telegramChatId, setTelegramChatId] = useState(department.telegram_chat_id ?? '');
  const [roles, setRoles] = useState<RolesState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  /**
   * Вкладка страницы: настройки отдела и процесс. Процесс — отдельный документ со своей
   * парой ручек и своей кнопкой «Сохранить», поэтому он не часть формы настроек: одна
   * форма с двумя «Сохранить» сохраняла бы половину того, что человек видит на экране.
   */
  const [tab, setTab] = useState<'settings' | 'process'>('settings');

  const needsRoles = department.fields.includes('roles');
  /**
   * Пока справочник ролей в полёте, сохранять нечего: набор ролей на экране неполон, а
   * отправить его вслепую — значит стереть отмеченные роли. Отказ справочника сохранение не
   * блокирует: остальные поля от него не зависят, а `role_ids` в тело тогда не попадает.
   */
  const rolesLoading = needsRoles && roles.status === 'loading';
  const invalidTarget = errorText === null ? null : invalidTargetFor(errorText);

  /** Справочник ролей читается заново по «Повторить»: отказ не запоминается навсегда. */
  const loadRoles = useCallback(async (): Promise<void> => {
    setRoles({ status: 'loading' });
    try {
      const loaded = await listRoles();
      setRoles({ status: 'ready', roles: loaded });
    } catch (error) {
      setRoles({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  // Справочник ролей нужен только видам с блоком `roles`: «Маркетингу» он не запрашивается,
  // иначе страница из четырёх полей делала бы лишний запрос.
  useEffect(() => {
    if (needsRoles) {
      void loadRoles();
    }
  }, [needsRoles, loadRoles]);

  function toggleRole(roleId: number): void {
    setSelectedRoleIds((previous) =>
      previous.includes(roleId)
        ? previous.filter((id) => id !== roleId)
        : [...previous, roleId],
    );
  }

  /**
   * Правка одного поля одного окна. Список заменяется новым массивом, а не мутируется:
   * так состояние React видит изменение, и так же ведёт себя сервер (набор целиком).
   */
  function setWindowPart(
    index: number,
    part: keyof DepartmentWindow,
    value: string,
  ): void {
    setWindows((previous) =>
      previous.map((window, current) =>
        current === index ? { ...window, [part]: value } : window,
      ),
    );
  }

  /** «Добавить окно»: седьмого ряда нет, предел тот же, что у сервера. */
  function addWindow(): void {
    setWindows((previous) =>
      previous.length >= WINDOWS_MAX ? previous : [...previous, { ...EMPTY_WINDOW }],
    );
  }

  /**
   * Крестик убирает свой ряд. У единственного окна кнопки нет вовсе, и проверка остаётся:
   * до нуля рядов список на экране не доводится — пустой набор собирается в отправке,
   * когда все ряды пусты.
   */
  function removeWindow(index: number): void {
    setWindows((previous) =>
      previous.length <= 1 ? previous : previous.filter((_, current) => current !== index),
    );
  }

  /**
   * `PATCH` уходит только отрисованными полями: состав берётся из `department.fields`,
   * поэтому «Маркетинг» не присылает время и уведомления, а выключенный флажок не стирает
   * сохранённый токен — его поля в теле просто нет.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);

    const patch: DepartmentPatch = {};
    for (const key of department.fields) {
      if (key === 'schedule') {
        // Набор уходит целиком и в том порядке, в каком стоит на экране: сервер заменит
        // его и отсортирует ответ сам.
        //
        // Все ряды пусты — уходит пустой набор, а не пара пустых полей: «окон нет» и
        // «окно не заполнено» — разные отказы контракта («Укажите хотя бы одно окно
        // времени работы» против «Время работы указывается как ЧЧ:ММ»). У отдела,
        // заведённого видом, в блоке «Смена» уже стоит один пустой ряд, и человек,
        // правящий только путь репозитория, должен получить отказ про окно, а не про
        // формат времени. Частично заполненный набор отправляется как есть: там
        // серверный отказ про формат и есть точный ответ.
        const allEmpty = windows.every(
          (window) => window.start_time === '' && window.end_time === '',
        );
        patch.windows = allEmpty
          ? []
          : windows.map((window) => ({
              start_time: window.start_time,
              end_time: window.end_time,
            }));
      } else if (key === 'roles') {
        // Пока справочник не прочитан, набор ролей не отправляется: на экране его нет,
        // и переписывать его вслепую нельзя.
        if (roles.status === 'ready') {
          patch.role_ids = selectedRoleIds;
        }
      } else if (key === 'max_rework') {
        patch.max_rework = reworkOf(maxRework);
      } else if (key === 'enabled') {
        // Флаг уходит тем же единственным `PATCH`, что и остальные поля: второго пути
        // правки (переключателя в списке) нет. Выключение ничего не стирает — расписание,
        // роли и бот остаются в теле своими ключами.
        patch.enabled = enabled;
      } else if (key === 'notifications') {
        patch.notifications_enabled = notifications;
        if (notifications) {
          patch.telegram_token = emptyToNull(telegramToken);
          patch.telegram_chat_id = emptyToNull(telegramChatId);
        }
      } else if (isTextFieldKey(key)) {
        patch[key] = emptyToNull(texts[key]);
      }
    }

    try {
      await updateDepartment(department.id, patch);
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  function renderTextField(key: TextFieldKey): JSX.Element {
    const { label, testId } = TEXT_FIELDS[key];
    const id = `${idPrefix}-${key}`;
    return (
      <div className="field field--machine" key={key}>
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <input
          className="field__input"
          id={id}
          type="text"
          value={texts[key]}
          data-testid={testId}
          aria-invalid={invalidTarget === key}
          aria-describedby={invalidTarget === key ? errorId : undefined}
          onChange={(event) => {
            const { value } = event.target;
            setTexts((previous) => ({ ...previous, [key]: value }));
          }}
        />
      </div>
    );
  }

  /**
   * Блок «Работа отдела включена» — тот же `.notify` и `.checkbox`, что у уведомлений,
   * только без полей за флажком. Подпись и описание видны в обоих состояниях: за флагом
   * полей нет, а последствие выключения (`Выключенный отдел не берёт задачи из очереди`)
   * нужно прочитать до того, как снимаешь галочку. Ничего не гаснет и не прячется:
   * отдел сохраняет расписание, роли и настройки, выключается только очередь.
   */
  function renderEnabled(): JSX.Element {
    return (
      <div className="notify" key="enabled">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            data-testid="department-field-enabled"
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Работа отдела включена</span>
        </label>
        <p className="field__hint">Выключенный отдел не берёт задачи из очереди</p>
      </div>
    );
  }

  function renderSchedule(): JSX.Element {
    const invalid = invalidTarget === 'schedule';
    /**
     * Подпись «Время работы» одна на весь список: прежние «с» и «по» у каждого ряда дали
     * бы двенадцать подписей на шесть окон. Поле узнаётся по месту в ряду «начало — тире —
     * конец», а программе подписи хватает `aria-label` у самого поля.
     */
    return (
      <div className="time-block" key="schedule">
        <span className="field__label">Время работы</span>

        <div
          className="windows"
          role="group"
          aria-label="Время работы"
          data-testid="department-field-windows"
        >
          {windows.map((window, index) => (
            <div className="window-row" key={index}>
              <input
                className="field__input"
                type="time"
                value={window.start_time}
                aria-label={`Окно ${index + 1}: начало`}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                data-testid={`department-field-window-start-${index}`}
                onChange={(event) => setWindowPart(index, 'start_time', event.target.value)}
              />
              <span className="window-row__dash" aria-hidden="true">
                —
              </span>
              <input
                className="field__input"
                type="time"
                value={window.end_time}
                aria-label={`Окно ${index + 1}: конец`}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                data-testid={`department-field-window-end-${index}`}
                onChange={(event) => setWindowPart(index, 'end_time', event.target.value)}
              />
              {/* У единственного окна крестика нет: удалять нечего, и пустого места в
                  ряду тоже не остаётся — колонка кнопки `auto`. */}
              {windows.length > 1 && (
                <button
                  className="kebab"
                  type="button"
                  aria-label={`Удалить окно ${index + 1}`}
                  data-testid={`department-field-window-remove-${index}`}
                  disabled={busy}
                  onClick={() => removeWindow(index)}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* «Добавить окно» — обычная кнопка под списком. При шести окнах она неактивна:
            предел `WINDOWS_MAX` виден по самой кнопке, а не по отказу сервера. */}
        <button
          className="btn windows__add"
          type="button"
          data-testid="department-field-window-add"
          disabled={busy || windows.length >= WINDOWS_MAX}
          onClick={addWindow}
        >
          Добавить окно
        </button>

        <p className="field__hint">
          Если конец раньше начала, окно идёт через полночь. Окон может быть до шести.
        </p>
      </div>
    );
  }

  function renderRoles(): JSX.Element {
    return (
      <div className="roles" key="roles">
        <div className="roles__head">
          <span className="roles__title" id={rolesLabelId}>
            Роли
          </span>
          {roles.status === 'ready' && (
            <span className="chip">
              {`Отмечено ${selectedRoleIds.length} из ${roles.roles.length}`}
            </span>
          )}
        </div>

        {roles.status === 'loading' && (
          <p className="state__line" aria-live="polite">
            Загрузка ролей…
          </p>
        )}

        {roles.status === 'error' && (
          <div className="state__error">
            <p className="error" role="alert">
              {roles.errorText}
            </p>
            <button className="btn" type="button" onClick={() => void loadRoles()}>
              Повторить
            </button>
          </div>
        )}

        {roles.status === 'ready' && (
          <div
            className="roles__grid"
            role="group"
            aria-labelledby={rolesLabelId}
            aria-invalid={invalidTarget === 'roles'}
            aria-describedby={invalidTarget === 'roles' ? errorId : undefined}
          >
            {roles.roles.map((role) => (
              <label className="checkbox" key={role.id}>
                <input
                  type="checkbox"
                  checked={selectedRoleIds.includes(role.id)}
                  data-testid={`department-field-role-${role.code}`}
                  onChange={() => toggleRole(role.id)}
                />
                <span>{role.title}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderMaxRework(): JSX.Element {
    return (
      <div className="field field--cost" key="max_rework">
        <label className="field__label" htmlFor={`${idPrefix}-max-rework`}>
          Лимит возврата задачи
        </label>
        <input
          className="field__input"
          id={`${idPrefix}-max-rework`}
          type="text"
          inputMode="numeric"
          value={maxRework}
          data-testid="department-field-max-rework"
          aria-invalid={invalidTarget === 'max_rework'}
          aria-describedby={
            invalidTarget === 'max_rework' ? `${reworkHintId} ${errorId}` : reworkHintId
          }
          onChange={(event) => setMaxRework(event.target.value.replace(/\D/g, ''))}
        />
        <span className="field__hint" id={reworkHintId}>
          Сколько раз задачу можно вернуть в работу. Пустое поле — 3.
        </span>
      </div>
    );
  }

  function renderNotifications(): JSX.Element {
    return (
      <div className="notify" key="notifications">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={notifications}
            data-testid="department-field-notifications"
            onChange={(event) => setNotifications(event.target.checked)}
          />
          <span>Включить уведомления</span>
        </label>

        {/* Выключенный флажок убирает оба поля целиком, а не гасит их: у выключенного
            блока нет значений, и сервер их не получает — сохранённый токен не стирается. */}
        {notifications && (
          <div className="form-grid">
            <div className="field field--machine">
              <label className="field__label" htmlFor={`${idPrefix}-telegram-token`}>
                API telegram бота
              </label>
              <input
                className="field__input"
                id={`${idPrefix}-telegram-token`}
                type="text"
                value={telegramToken}
                data-testid="department-field-telegram-token"
                aria-invalid={invalidTarget === 'telegram_token'}
                aria-describedby={invalidTarget === 'telegram_token' ? errorId : undefined}
                onChange={(event) => setTelegramToken(event.target.value)}
              />
            </div>
            <div className="field field--machine">
              <label className="field__label" htmlFor={`${idPrefix}-telegram-chat`}>
                Ваш ID
              </label>
              <input
                className="field__input"
                id={`${idPrefix}-telegram-chat`}
                type="text"
                inputMode="numeric"
                value={telegramChatId}
                data-testid="department-field-telegram-chat"
                aria-invalid={invalidTarget === 'telegram_chat_id'}
                aria-describedby={invalidTarget === 'telegram_chat_id' ? errorId : undefined}
                onChange={(event) => setTelegramChatId(event.target.value)}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  /**
   * Блоки одной секции в порядке `fields`. Подряд идущие поля сетки собираются в одну
   * `.form-grid`: путь и ветка, два пространства, директория и compose-проект — пары,
   * которые читаются вместе.
   */
  function renderFields(keys: readonly string[]): JSX.Element[] {
    const blocks: JSX.Element[] = [];
    let grid: JSX.Element[] = [];

    const flushGrid = (): void => {
      if (grid.length === 0) {
        return;
      }
      blocks.push(
        <div className="form-grid" key={`grid-${blocks.length}`}>
          {grid}
        </div>,
      );
      grid = [];
    };

    for (const key of keys) {
      if (isTextFieldKey(key)) {
        grid.push(renderTextField(key));
        continue;
      }
      if (key === 'max_rework') {
        grid.push(renderMaxRework());
        continue;
      }
      flushGrid();
      if (key === 'enabled') {
        blocks.push(renderEnabled());
      } else if (key === 'schedule') {
        blocks.push(renderSchedule());
      } else if (key === 'roles') {
        blocks.push(renderRoles());
      } else if (key === 'notifications') {
        blocks.push(renderNotifications());
      }
    }

    flushGrid();
    return blocks;
  }

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          Проекты
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          {project.name}
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">{department.name}</span>
        </p>
        <button className="btn" type="button" data-testid="department-page-back" onClick={onBack}>
          ← К проекту
        </button>
      </header>

      <main className="content" data-testid="department-page">
        <div className="page-head">
          <div className="dept-head">
            <h1 className="page-head__title" data-testid="department-page-title">
              {department.name}
            </h1>
            <p className="dept-head__meta">
              <span>
                Вид: <span data-testid="department-page-kind">{department.kind.title}</span>
              </span>
              <span className="crumbs__sep" aria-hidden="true">
                ·
              </span>
              <span>{`Обновлён ${formatDate(department.updated_at)}`}</span>
            </p>
          </div>
        </div>

        <div className="dept-tabs" role="tablist" aria-label="Разделы отдела">
          <button
            className={tab === 'settings' ? 'dept-tabs__tab dept-tabs__tab--active' : 'dept-tabs__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            data-testid="department-tab-settings"
            onClick={() => setTab('settings')}
          >
            Настройки
          </button>
          <button
            className={tab === 'process' ? 'dept-tabs__tab dept-tabs__tab--active' : 'dept-tabs__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'process'}
            data-testid="department-tab-process"
            onClick={() => setTab('process')}
          >
            Процесс
          </button>
        </div>

        {tab === 'process' ? (
          <DepartmentProcess departmentId={department.id} />
        ) : (
        <form
          className="card"
          aria-label="Настройки отдела"
          onSubmit={(event) => void handleSubmit(event)}
        >
          {SECTIONS.map((section) => {
            const visible = department.fields.filter((key) => section.keys.includes(key));
            if (visible.length === 0) {
              return null;
            }
            return (
              <div className="form-section" key={section.title}>
                <h2 className="form-section__title">{section.title}</h2>
                {renderFields(visible)}
              </div>
            );
          })}

          <div className="form-foot">
            {errorText !== null && (
              <p className="error" id={errorId} data-testid="department-edit-error" role="alert">
                {errorText}
              </p>
            )}
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                data-testid="department-edit-cancel"
                onClick={onBack}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                className="btn btn--dark"
                type="submit"
                data-testid="department-edit-submit"
                disabled={busy || rolesLoading}
              >
                {busy ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </form>
        )}
      </main>
    </>
  );
}
