"""Справочник ролей, таблица отделов и связь отдел—роль.

Ревизия создаёт три таблицы и два индекса и наполняет `roles` каталогом
`DEFAULT_ROLES`. Сид живёт здесь, а не в коде приложения: каталога `plugins/` с
пресетами в образе `api` нет, прочитать роли в рантайме нельзя, а отделы ссылаются
на роль по `id` — поэтому справочник приезжает ревизией. Новая роль — новая строка и
новая ревизия, а не правка этой: уже применённая ревизия не переигрывается.

`downgrade` дропает таблицы вместе с содержимым — откат безопасен лишь до наполнения
базы: отделы и справочник ролей при откате пропадают насовсем.

Revision ID: 0003_departments
Revises: 0002_projects
Create Date: 2026-10-30

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from app.models.role import DEFAULT_ROLES

revision: str = "0003_departments"
down_revision: str | None = "0002_projects"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Условие частичного индекса: уникальность держится только среди живых строк.
ALIVE_CONDITION = sa.text("deleted_at IS NULL")

# Таблица для `bulk_insert`: значения колонок — только `code` и `title`, `id` даёт
# автоинкремент, поэтому порядок вставки и есть порядок выдачи справочника.
ROLES_TABLE = sa.table(
    "roles",
    sa.column("code", sa.String(length=50)),
    sa.column("title", sa.String(length=100)),
)


def upgrade() -> None:
    """Создать `roles` с сидом, `departments` и `department_roles`."""
    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_roles_code", "roles", ["code"], unique=True)
    op.bulk_insert(
        ROLES_TABLE,
        [{"code": code, "title": title} for code, title in DEFAULT_ROLES],
    )

    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        # Время работы одной парой «с/по»: конец раньше начала — переход через полночь.
        sa.Column("start_time", sa.Time(), nullable=False),
        sa.Column("end_time", sa.Time(), nullable=False),
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
        # NULL — отдел живой, значение — мягко удалённый.
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_departments_name_alive",
        "departments",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=ALIVE_CONDITION,
        sqlite_where=ALIVE_CONDITION,
    )

    op.create_table(
        "department_roles",
        sa.Column("department_id", sa.Integer(), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["department_id"], ["departments.id"]),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"]),
        sa.PrimaryKeyConstraint("department_id", "role_id"),
    )


def downgrade() -> None:
    """Откат в обратном порядке: связь → отделы с индексом → роли с индексом.

    Таблицы дропаются вместе с содержимым: отделы и справочник ролей при откате
    теряются безвозвратно — откатывать только до наполнения базы.
    """
    op.drop_table("department_roles")
    op.drop_index("uq_departments_name_alive", table_name="departments")
    op.drop_table("departments")
    op.drop_index("uq_roles_code", table_name="roles")
    op.drop_table("roles")
