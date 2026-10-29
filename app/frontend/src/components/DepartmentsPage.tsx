/**
 * Раздел «Отделы»: шапка с крошками, заголовок «Отделы» с кнопкой «Добавить отдел»,
 * карточка списка и диалоги создания, правки и удаления.
 *
 * Экран владеет своим состоянием — списком, открытым окном и перечитыванием с сервера
 * после создания, правки и удаления. Оптимистичных обновлений нет: на экране только то,
 * что вернул сервер.
 *
 * Панели «Состояние сервиса» здесь нет: по решению человека и макету `mockups/34` она
 * осталась на экране «Проекты». Это осознанное расхождение с пунктом 17 постановки.
 */

import { useCallback, useEffect, useState } from 'react';

import { deleteDepartment, listDepartments, type Department } from '../api/departments';
import { ApiError, UNREACHABLE_TEXT } from '../api/http';
import ConfirmDialog from './ConfirmDialog';
import DepartmentFormDialog from './DepartmentFormDialog';
import DepartmentList from './DepartmentList';

/** Состояние списка: загрузка, готовые данные или ошибка загрузки. */
type ListState =
  | { status: 'loading' }
  | { status: 'ready'; departments: Department[] }
  | { status: 'error'; errorText: string };

/** Открытое окно: форма создания, форма правки или подтверждение удаления. */
type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; department: Department }
  | { kind: 'delete'; department: Department }
  | null;

type DepartmentsPageProps = {
  /**
   * Сколько отделов на экране: бейдж раздела в меню рисует `App`, а список читает этот
   * экран. `null` — список ещё не прочитан или не прочитался.
   */
  onCountChange: (count: number | null) => void;
};

export default function DepartmentsPage({
  onCountChange,
}: DepartmentsPageProps): JSX.Element {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [dialog, setDialog] = useState<DialogState>(null);

  /**
   * Список всегда читается с сервера: после создания, правки и удаления экран
   * перечитывает его, а не правит своё состояние на веру.
   */
  const loadDepartments = useCallback(async (): Promise<void> => {
    setList({ status: 'loading' });
    try {
      const departments = await listDepartments();
      setList({ status: 'ready', departments });
    } catch (error) {
      setList({
        status: 'error',
        errorText: error instanceof ApiError ? error.message : UNREACHABLE_TEXT,
      });
    }
  }, []);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    onCountChange(list.status === 'ready' ? list.departments.length : null);
  }, [list, onCountChange]);

  function closeDialog(): void {
    setDialog(null);
  }

  /** Сохранение или удаление прошло — окно закрыто, список перечитан с сервера. */
  function handleSaved(): void {
    setDialog(null);
    void loadDepartments();
  }

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          Приложение
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__current">Отделы</span>
        </p>
      </header>

      <main className="content">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Отделы</h1>
            <p className="page-head__sub">Отделы, их время работы и набор ролей</p>
          </div>
          <button
            className="btn btn--dark"
            type="button"
            data-testid="department-create"
            onClick={() => setDialog({ kind: 'create' })}
          >
            Добавить отдел
          </button>
        </div>

        <DepartmentList
          departments={list.status === 'ready' ? list.departments : []}
          loading={list.status === 'loading'}
          errorText={list.status === 'error' ? list.errorText : null}
          onRetry={() => void loadDepartments()}
          onEdit={(department) => setDialog({ kind: 'edit', department })}
          onDelete={(department) => setDialog({ kind: 'delete', department })}
        />
      </main>

      {dialog !== null && dialog.kind === 'create' && (
        <DepartmentFormDialog mode="create" onClose={closeDialog} onSaved={handleSaved} />
      )}
      {dialog !== null && dialog.kind === 'edit' && (
        <DepartmentFormDialog
          mode="edit"
          department={dialog.department}
          onClose={closeDialog}
          onSaved={handleSaved}
        />
      )}
      {dialog !== null && dialog.kind === 'delete' && (
        <ConfirmDialog
          testId="department-delete-confirm"
          title="Удалить отдел?"
          text={`Отдел «${dialog.department.name}» исчезнет из списка. Восстановить его через интерфейс нельзя.`}
          submitLabel="Удалить"
          busyLabel="Удаляю…"
          onConfirm={async () => {
            await deleteDepartment(dialog.department.id);
            handleSaved();
          }}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
