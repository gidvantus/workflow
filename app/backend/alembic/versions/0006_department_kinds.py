"""Справочник видов отделов, привязка отдела к виду, необязательное время и поля правки.

Ревизия повторяет историю ролей: таблица-справочник `department_kinds` создаётся и
наполняется каталогом `DEFAULT_DEPARTMENT_KINDS` прямо здесь, потому что каталога
`plugins/` в образе `api` нет, а отдел ссылается на вид по `id`. Новая строка сида —
новая ревизия, а не правка этой: применённая ревизия не переигрывается.

Порядок `upgrade` важен и не переставляется:

1. таблица `department_kinds`, уникальный индекс кода и сид двух видов;
2. колонка `departments.kind_id` **допускает `NULL`**, потому что бэкфилл идёт следом;
3. `UPDATE departments SET kind_id = ...` — бэкфилл **всех** строк, включая сирот без
   проекта: отдел без вида не бывает, а выдумывать вид по проекту не из чего;
4. `kind_id` становится `NOT NULL`, получает индекс и внешний ключ;
5. десять новых колонок страницы правки: восемь необязательных строк, `max_rework` с
   умолчанием `3` и `notifications_enabled` с умолчанием `false`;
6. `start_time` и `end_time` перестают быть обязательными: отдел создаётся без
   расписания, а у вида «Маркетинг» времени работы нет вовсе.

`downgrade` строго обратный. Он **теряет** десять новых полей и привязку отделов к виду,
а на строках с пустым временем работы честно падает на `SET NOT NULL`: выдуманное время
не подставляем. Откатываться можно только сразу после `upgrade` или после ручной чистки
строк без расписания.

Revision ID: 0006_department_kinds
Revises: 0005_departments_project
Create Date: 2026-11-19

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from app.models.department_kind import DEFAULT_DEPARTMENT_KINDS

revision: str = "0006_department_kinds"
down_revision: str | None = "0005_departments_project"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Таблица для `bulk_insert`: значения колонок — только `code` и `title`, `id` даёт
# автоинкремент, поэтому порядок вставки и есть порядок выдачи справочника.
KINDS_TABLE = sa.table(
    "department_kinds",
    sa.column("code", sa.String(length=50)),
    sa.column("title", sa.String(length=100)),
)

# Колонки страницы правки: имя, тип, значения по умолчанию. Порядок — порядок постановки.
TEXT_FIELDS: tuple[tuple[str, int], ...] = (
    ("repo_path", 500),
    ("base_branch", 200),
    ("workspace", 500),
    ("human_workspace", 500),
    ("artifacts_dir", 500),
    ("compose_project", 200),
    ("telegram_token", 200),
    ("telegram_chat_id", 64),
)


def upgrade() -> None:
    """Справочник видов, бэкфилл `kind_id`, поля правки и необязательное время."""
    op.create_table(
        "department_kinds",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_department_kinds_code", "department_kinds", ["code"], unique=True)
    op.bulk_insert(
        KINDS_TABLE,
        [{"code": code, "title": title} for code, title in DEFAULT_DEPARTMENT_KINDS],
    )

    # Сначала колонка допускает `NULL`: строки уже есть, и им нужен бэкфилл.
    op.add_column("departments", sa.Column("kind_id", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE departments SET kind_id = "
        "(SELECT id FROM department_kinds WHERE code = 'development')"
    )
    op.alter_column("departments", "kind_id", existing_type=sa.Integer(), nullable=False)
    op.create_index("ix_departments_kind_id", "departments", ["kind_id"])
    op.create_foreign_key(
        "fk_departments_kind_id",
        "departments",
        "department_kinds",
        ["kind_id"],
        ["id"],
    )

    for name, length in TEXT_FIELDS:
        op.add_column("departments", sa.Column(name, sa.String(length=length), nullable=True))
    op.add_column(
        "departments",
        sa.Column("max_rework", sa.Integer(), nullable=False, server_default="3"),
    )
    op.add_column(
        "departments",
        sa.Column(
            "notifications_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # Отдел больше не требует расписания: `NULL` — «время работы не задано».
    op.alter_column("departments", "start_time", existing_type=sa.Time(), nullable=True)
    op.alter_column("departments", "end_time", existing_type=sa.Time(), nullable=True)


def downgrade() -> None:
    """Откат в обратном порядке: время обязательное, поля правки, вид, справочник.

    Время возвращается в `NOT NULL` первым: на строках, заведённых без расписания, откат
    падает — это честный отказ, а не тихая подстановка выдуманного времени. Привязка к
    виду и десять новых полей при откате теряются насовсем.
    """
    op.alter_column(
        "departments",
        "end_time",
        existing_type=sa.Time(),
        nullable=False,
    )
    op.alter_column(
        "departments",
        "start_time",
        existing_type=sa.Time(),
        nullable=False,
    )

    op.drop_column("departments", "notifications_enabled")
    op.drop_column("departments", "max_rework")
    for name, _length in reversed(TEXT_FIELDS):
        op.drop_column("departments", name)

    op.drop_constraint("fk_departments_kind_id", "departments", type_="foreignkey")
    op.drop_index("ix_departments_kind_id", table_name="departments")
    op.drop_column("departments", "kind_id")

    op.drop_index("uq_department_kinds_code", table_name="department_kinds")
    op.drop_table("department_kinds")
