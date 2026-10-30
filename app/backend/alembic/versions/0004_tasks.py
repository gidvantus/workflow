"""Задачи проекта: новая таблица `tasks` с внешним ключом на `projects`.

Ревизия только добавляет таблицу и индекс: `projects`, `roles`, `departments` и
`department_roles` не двигаются, их данные остаются на месте.

Колонка `cost` — `Numeric(12, 2)` и **допускает `NULL`**: отсутствие стоимости это
«не указана», а не ноль. Внешний ключ без каскада: удаление проекта мягкое, задачи
удалённого проекта остаются в таблице и в списках не показываются.

`downgrade` дропает `tasks` вместе с содержимым — откат стирает заведённые задачи
насовсем, поэтому откатывать можно только пока в таблице нет нужных данных.

Revision ID: 0004_tasks
Revises: 0003_departments
Create Date: 2026-10-31

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_tasks"
down_revision: str | None = "0003_departments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Создать `tasks` с внешним ключом на `projects.id` и индексом по проекту."""
    op.create_table(
        "tasks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=sa.text("''")),
        # NULL — стоимость не указана; ноль значил бы «бесплатно».
        sa.Column("cost", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])


def downgrade() -> None:
    """Откат: индекс и таблица задач. Задачи при откате теряются насовсем."""
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
