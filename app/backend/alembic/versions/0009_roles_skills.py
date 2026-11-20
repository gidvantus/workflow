"""Роли и скиллы в вебе: описание и мягкое удаление роли, отдельная таблица `role_skills`.

Ревизия расширяет справочник `roles` тремя колонками и создаёт таблицу скиллов роли.
Прежние ручки ролей были только на чтение, а `description` и признак удаления появились
потому, что роли теперь правятся из веба: без `deleted_at` строка исчезала бы физически и
рвала связь `department_roles`, без `description` роли нечего было бы отдавать пресету.

Порядок `upgrade` важен и не переставляется:

1. `roles.description` добавляется с `server_default ''`: строки сида `0003_departments`
   остаются на месте, пустое описание — не ошибка схемы, а «описания ещё нет»;
2. `roles.updated_at` — `server_default now()`, чтобы существующие строки не остались с
   `NULL` и `NOT NULL` можно было поставить сразу;
3. `roles.deleted_at` nullable, `NULL` — роль живая;
4. `role_skills` с JSON-колонкой `sections` (на PostgreSQL — `JSONB`): разделы скилла
   правятся как упорядоченный массив, нормализация в отдельную таблицу не нужна;
5. частичный уникальный индекс `(role_id, lower(code))` по живым строкам и индекс по
   `role_id` для списка скиллов роли.

Код роли и код скилла неизменяемы, а код удалённой сущности не переиспользуется —
поэтому у `role_skills` уникальность частичная (по живым строкам), а «прежний код занят»
держит ручка: индекс по живым строкам физически не может запретить строку, которой ещё
нет, но чей код лежит в мягко удалённой.

`downgrade` строго обратный: дропает таблицу скиллов вместе с содержимым и три колонки.
Откат **теряет описания ролей и все скиллы**, восстановить их из базы нельзя — данные
приезжают повторной заливкой инструментом импорта.

Revision ID: 0009_roles_skills
Revises: 0008_department_windows
Create Date: 2026-11-21

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0009_roles_skills"
down_revision: str | None = "0008_department_windows"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = sa.text("deleted_at IS NULL")

# Тот же тип, что у модели: на PostgreSQL — `JSONB`, на остальных диалектах — `JSON`.
SECTIONS_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    """Добавить полям роли описание и мягкое удаление и завести таблицу скиллов."""
    op.add_column(
        "roles",
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "roles",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.add_column("roles", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "role_skills",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        # Скилл живёт внутри роли: удаление роли его не каскадит, обе таблицы мягкие.
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        # Описание обязательно на уровне ручки: без него модель не видит скилл в каталоге.
        sa.Column("description", sa.Text(), nullable=False),
        # Разделы скилла в порядке показа: массив `{"title", "body"}`.
        sa.Column("sections", SECTIONS_TYPE, nullable=False),
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
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"]),
    )
    op.create_index("ix_role_skills_role_id", "role_skills", ["role_id"])
    op.create_index(
        "uq_role_skills_role_code_alive",
        "role_skills",
        ["role_id", sa.text("lower(code)")],
        unique=True,
        postgresql_where=ALIVE_CONDITION,
        sqlite_where=ALIVE_CONDITION,
    )


def downgrade() -> None:
    """Откат: индексы и таблица скиллов, затем три колонки ролей.

    Откат теряет все скиллы и описания ролей: второй копии этих данных нет, а повторно
    они приезжают заливкой из репозитория (`plugins/tools/presets-import.mjs`).
    """
    op.drop_index("uq_role_skills_role_code_alive", table_name="role_skills")
    op.drop_index("ix_role_skills_role_id", table_name="role_skills")
    op.drop_table("role_skills")
    op.drop_column("roles", "deleted_at")
    op.drop_column("roles", "updated_at")
    op.drop_column("roles", "description")
