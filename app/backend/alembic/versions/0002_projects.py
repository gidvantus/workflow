"""Таблица `projects` и частичный уникальный индекс по названиям живых строк.

Ревизия только создаёт таблицу и индекс, существующих данных не трогает. `downgrade`
дропает таблицу вместе с содержимым — откат безопасен лишь до наполнения базы:
проекты, удалённые мягко, при откате пропадают насовсем.

Revision ID: 0002_projects
Revises: 0001_init
Create Date: 2026-10-29

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002_projects"
down_revision: str | None = "0001_init"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Условие частичного индекса: уникальность держится только среди живых строк.
ALIVE_CONDITION = sa.text("deleted_at IS NULL")


def upgrade() -> None:
    """Создать таблицу `projects` и уникальный индекс `uq_projects_name_alive`."""
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column("repo_url", sa.String(length=500), nullable=False),
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
        # NULL — проект живой, значение — мягко удалённый.
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_projects_name_alive",
        "projects",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=ALIVE_CONDITION,
        sqlite_where=ALIVE_CONDITION,
    )


def downgrade() -> None:
    """Откат: индекс и таблица вместе с содержимым.

    Удалённые мягко проекты при откате теряются безвозвратно — откатывать только
    до наполнения базы.
    """
    op.drop_index("uq_projects_name_alive", table_name="projects")
    op.drop_table("projects")
