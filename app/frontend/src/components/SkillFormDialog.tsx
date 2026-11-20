/**
 * Одно окно на создание и правку скилла роли (`mode`).
 *
 * Код скилла вводится только при создании: это имя каталога скилла и frontmatter «name»,
 * после сохранения он не меняется — при правке поле показано, но изменить его нельзя, а в
 * тело `PATCH` `code` не попадает вовсе.
 *
 * **Разделы.** Скилл правится как упорядоченный набор разделов: заголовок «##» и его
 * markdown. Порядок массива и есть порядок разделов в файле, поэтому перестановка здесь —
 * это «Выше»/«Ниже», а не отдельная ручка: `PATCH /api/skills/{id}` присылает массив
 * целиком. Пределы полей (200 символов на заголовок, 20 000 на текст, 50 разделов) —
 * те же, что у валидаторов `app/api/roles.py`: кнопка «Добавить раздел» гаснет на
 * пятидесятом, длину держит `maxLength` на поле.
 *
 * Тексты отказов — дословно из `detail`; своих формулировок здесь нет.
 */

import { useId, useState, type FormEvent } from 'react';

import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import {
  createSkill,
  updateSkill,
  type Skill,
  type SkillSection,
} from '../api/roles';
import Dialog from './Dialog';

/** Пределы полей скилла — те же, что у валидаторов `app/api/roles.py`. */
const CODE_MAX_LENGTH = 64;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 1000;
const SECTION_TITLE_MAX_LENGTH = 200;
const SECTION_BODY_MAX_LENGTH = 20000;
const SECTIONS_MAX = 50;

type SkillFormDialogProps = {
  /** Роль, к которой относится скилл: нужна для вложенного `POST`. */
  roleId: number;
  mode: 'create' | 'edit';
  /** Текущие значения при правке. */
  skill?: Skill;
  onClose: () => void;
  /** Успешное сохранение: окно закрывается, вызывающая сторона перечитывает список. */
  onSaved: () => void;
};

/** Поле, к которому относится текст отказа — нужно только для `aria-invalid`. */
type InvalidField = 'code' | 'title' | 'description' | 'sections' | null;

function invalidFieldFor(text: string): InvalidField {
  const lower = text.toLowerCase();
  if (lower.includes('раздел')) {
    return 'sections';
  }
  if (lower.includes('код')) {
    return 'code';
  }
  if (lower.includes('назван')) {
    return 'title';
  }
  if (lower.includes('описан')) {
    return 'description';
  }
  return null;
}

export default function SkillFormDialog({
  roleId,
  mode,
  skill,
  onClose,
  onSaved,
}: SkillFormDialogProps): JSX.Element {
  const formId = useId();
  const editing = mode === 'edit' && skill !== undefined;
  const [code, setCode] = useState(skill?.code ?? '');
  const [title, setTitle] = useState(skill?.title ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [sections, setSections] = useState<SkillSection[]>(skill?.sections ?? []);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const invalidField = errorText === null ? null : invalidFieldFor(errorText);
  const canAddSection = !busy && sections.length < SECTIONS_MAX;

  function updateSection(index: number, patch: Partial<SkillSection>): void {
    setSections((current) =>
      current.map((section, position) =>
        position === index ? { ...section, ...patch } : section,
      ),
    );
  }

  /** Перестановка соседних разделов: порядок массива — порядок «##» в файле. */
  function moveSection(index: number, delta: number): void {
    setSections((current) => {
      const target = index + delta;
      const from = current[index];
      const to = current[target];
      if (from === undefined || to === undefined) {
        return current;
      }
      const next = [...current];
      next[index] = to;
      next[target] = from;
      return next;
    });
  }

  function removeSection(index: number): void {
    setSections((current) => current.filter((_, position) => position !== index));
  }

  function addSection(): void {
    setSections((current) =>
      current.length >= SECTIONS_MAX ? current : [...current, { title: '', body: '' }],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const input = { title, description, sections };
      if (editing && skill !== undefined) {
        await updateSkill(skill.id, input);
      } else {
        await createSkill(roleId, { code, ...input });
      }
      onSaved();
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : UNREACHABLE_TEXT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId="skill-form"
      title={editing ? 'Изменить скилл' : 'Новый скилл'}
      onClose={onClose}
      busy={busy}
      wide
      actions={
        <>
          <button
            className="btn"
            type="button"
            data-testid="skill-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="btn btn--dark"
            type="submit"
            form={formId}
            data-testid="skill-form-submit"
            disabled={busy}
          >
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <form className="dialog__form" id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <div className="field field--machine">
          <label className="field__label" htmlFor={`${formId}-code`}>
            Код
          </label>
          <input
            className="field__input"
            id={`${formId}-code`}
            type="text"
            autoComplete="off"
            maxLength={CODE_MAX_LENGTH}
            value={code}
            readOnly={editing}
            aria-invalid={invalidField === 'code'}
            onChange={(event) => setCode(event.target.value)}
            data-testid="skill-form-code"
          />
          <span className="field__hint">
            {editing
              ? 'Код не меняется: это имя каталога скилла и frontmatter «name».'
              : 'Латиница, цифры и дефис. Код станет именем каталога скилла и не изменится.'}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-title`}>
            Название
          </label>
          <input
            className="field__input"
            id={`${formId}-title`}
            type="text"
            autoComplete="off"
            maxLength={TITLE_MAX_LENGTH}
            value={title}
            aria-invalid={invalidField === 'title'}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="skill-form-title"
          />
          <span className="field__hint">Заголовок «#» в файле скилла.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-description`}>
            Описание
          </label>
          <textarea
            className="field__textarea"
            id={`${formId}-description`}
            rows={3}
            maxLength={DESCRIPTION_MAX_LENGTH}
            value={description}
            aria-invalid={invalidField === 'description'}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="skill-form-description"
          />
          <span className="field__hint">
            Frontmatter «description»: по нему модель решает, когда скилл грузить.
          </span>
        </div>

        <div className="form-section" data-testid="skill-form-sections">
          <h3 className="form-section__title">Разделы</h3>
          <p className="field__hint">
            Порядок разделов здесь — порядок «##» в файле скилла. Пустой текст раздела
            разрешён, пустой заголовок — нет.
          </p>

          {sections.length === 0 && (
            <p className="state__hint" data-testid="skill-sections-empty">
              Разделов нет: скилл будет из одного заголовка и описания.
            </p>
          )}

          {sections.map((section, index) => (
            <div className="skill-section" key={index} data-testid="skill-section">
              <div className="skill-section__head">
                <span className="skill-section__index" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="skill-section__tools">
                  <button
                    className="btn"
                    type="button"
                    data-testid="skill-section-up"
                    onClick={() => moveSection(index, -1)}
                    disabled={busy || index === 0}
                  >
                    Выше
                  </button>
                  <button
                    className="btn"
                    type="button"
                    data-testid="skill-section-down"
                    onClick={() => moveSection(index, 1)}
                    disabled={busy || index === sections.length - 1}
                  >
                    Ниже
                  </button>
                  <button
                    className="btn btn--danger"
                    type="button"
                    data-testid="skill-section-remove"
                    onClick={() => removeSection(index)}
                    disabled={busy}
                  >
                    Удалить
                  </button>
                </div>
              </div>

              <div className="field">
                <label className="field__label" htmlFor={`${formId}-section-${index}-title`}>
                  {`Заголовок раздела ${index + 1}`}
                </label>
                <input
                  className="field__input"
                  id={`${formId}-section-${index}-title`}
                  type="text"
                  autoComplete="off"
                  maxLength={SECTION_TITLE_MAX_LENGTH}
                  value={section.title}
                  aria-invalid={invalidField === 'sections' && section.title.trim() === ''}
                  onChange={(event) => updateSection(index, { title: event.target.value })}
                  data-testid="skill-section-title"
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor={`${formId}-section-${index}-body`}>
                  {`Текст раздела ${index + 1}`}
                </label>
                <textarea
                  className="field__textarea"
                  id={`${formId}-section-${index}-body`}
                  rows={5}
                  maxLength={SECTION_BODY_MAX_LENGTH}
                  value={section.body}
                  onChange={(event) => updateSection(index, { body: event.target.value })}
                  data-testid="skill-section-body"
                />
              </div>
            </div>
          ))}

          <button
            className="btn windows__add"
            type="button"
            data-testid="skill-section-add"
            onClick={addSection}
            disabled={!canAddSection}
          >
            Добавить раздел
          </button>
        </div>
      </form>

      {errorText !== null && (
        <p className="error" data-testid="skill-form-error" role="alert">
          {errorText}
        </p>
      )}
    </Dialog>
  );
}
