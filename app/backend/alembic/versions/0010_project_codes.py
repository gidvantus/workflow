"""Код проекта: стабильный человеческий идентификатор проекта в документе реестра.

Ревизия добавляет `projects.code` — необязательный слаг проекта (`NULL` — не задан) — и
частичный уникальный индекс по `lower(code)` среди живых строк с заданным кодом.

Зачем код в базе. Документ реестра собирается из базы, и `id` проекта был `str(id)` —
числом (`"1"`…`"5"`). Живой файл реестра отдела держится на слагах (`vahta`, `workflow`),
а склейка `plugins/registry.mjs` сопоставляет проекты по `id`: числа против слагов означали
потерю локальных ключей проекта. Код делает `id` документа стабильным.

Порядок `upgrade` и его границы:

1. колонка `code` добавляется nullable: у существующих строк кода нет, и придумывать его
   из названия миграция не имеет права — транслитерация кириллицы даёт угаданный код,
   который потом неизменяем. До заполнения `id` в реестре остаётся числовым;
2. уникальность — частичная: только среди живых строк (`deleted_at IS NULL`) и только
   там, где код задан (`code IS NOT NULL`). `NULL` не участвует в уникальности, поэтому
   проектов без кода может быть сколько угодно;
3. индекс строится по `lower(code)`: занятость кода проверяется без учёта регистра, и
   `CRMDormitory` (верхний регистр — живой слаг отдела) не должен столкнуться с
   `crmdormitory`.

`downgrade` строго обратный: дропает индекс, затем колонку. Откат **теряет коды
проектов**, и после него `id` в документе реестра снова становится числовым — это
безопасно (документ пересобирается ручкой `POST /api/registry/rebuild`), но коды
придётся заполнить заново.

Revision ID: 0010_project_codes
Revises: 0009_roles_skills
Create Date: 2026-11-21

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010_project_codes"
down_revision: str | None = "0009_roles_skills"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Условие частичного индекса: проект живой **и** код задан. Условие поддержано и в
# PostgreSQL, и в SQLite, поэтому тесты не расходятся со стендом.
CODE_CONDITION = sa.text("deleted_at IS NULL AND code IS NOT NULL")


def upgrade() -> None:
    """Добавить колонку `code` и уникальный индекс `uq_projects_code_alive`."""
    op.add_column("projects", sa.Column("code", sa.String(length=32), nullable=True))
    op.create_index(
        "uq_projects_code_alive",
        "projects",
        [sa.text("lower(code)")],
        unique=True,
        postgresql_where=CODE_CONDITION,
        sqlite_where=CODE_CONDITION,
    )


def downgrade() -> None:
    """Откат: индекс и колонка. Заполненные коды проекта теряются безвозвратно.

    Восстановить их из базы нельзя: нужные слаги знает человек, а не база, — поэтому
    откат допустим, но после него коды придётся заполнить заново.
    """
    op.drop_index("uq_projects_code_alive", table_name="projects")
    op.drop_column("projects", "code")
