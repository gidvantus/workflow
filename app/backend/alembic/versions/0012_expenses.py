"""Журнал расходов проекта: четыре цены, хранимый итог и таблица `project_expenses`.

Ревизия добавляет деньги проекта и сам журнал:

1. `projects` получает пять колонок — четыре цены за 1 000 000 токенов
   (`Numeric(18, 6)`) и итог `total_cost` (`Numeric(14, 2)`). Все `NOT NULL` с умолчанием
   `0`: существующие строки получают нули без `UPDATE`, и проект без цен — допустимое
   состояние (ручка журнала отвергает запись по нему отдельным текстом, а не падает);
2. создаётся `project_expenses` с внешним ключом на `projects.id`, днём расхода, четырьмя
   количествами (`BIGINT`), суммой (`Numeric(14, 2)`) и моментом записи;
3. индекс `ix_project_expenses_project_id` обслуживает список журнала проекта.

Цены в базе, а не в записи: сумма записи — снимок на момент записи, а смена цен задним
числом уже записанные суммы не пересчитывает. Отдельного справочника тарифов нет.

`downgrade` строго обратный: снимает индекс, таблицу и пять колонок `projects`. Откат
теряет заведённые записи журнала и хранимый итог; цены проекта тоже пропадают —
восстановить их после повторного `upgrade` нечем, кроме ручного ввода.

Revision ID: 0012_expenses
Revises: 0011_department_enabled
Create Date: 2026-11-22

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012_expenses"
down_revision: str | None = "0011_department_enabled"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Пять новых колонок `projects`: имя и точность. Порядок — порядок цен в интерфейсе.
PROJECT_MONEY_COLUMNS = (
    ("price_input", sa.Numeric(precision=18, scale=6)),
    ("price_output", sa.Numeric(precision=18, scale=6)),
    ("price_cache_read", sa.Numeric(precision=18, scale=6)),
    ("price_cache_write", sa.Numeric(precision=18, scale=6)),
    ("total_cost", sa.Numeric(precision=14, scale=2)),
)


def upgrade() -> None:
    """Добавить деньги проекта и создать `project_expenses` с индексом по проекту."""
    for name, column_type in PROJECT_MONEY_COLUMNS:
        op.add_column(
            "projects",
            sa.Column(name, column_type, nullable=False, server_default=sa.text("0")),
        )

    op.create_table(
        "project_expenses",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("spent_on", sa.Date(), nullable=False),
        sa.Column("tokens_input", sa.BigInteger(), nullable=False),
        sa.Column("tokens_output", sa.BigInteger(), nullable=False),
        sa.Column("tokens_cache_read", sa.BigInteger(), nullable=False),
        sa.Column("tokens_cache_write", sa.BigInteger(), nullable=False),
        # Сумма — снимок на момент записи: меняют ли цены, считаются уже записанные.
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_expenses_project_id", "project_expenses", ["project_id"])


def downgrade() -> None:
    """Откат: индекс, таблица журнала и пять колонок `projects`.

    Записи журнала, итог и цены проекта теряются насовсем: откатывать можно только пока
    эти данные не нужны.
    """
    op.drop_index("ix_project_expenses_project_id", table_name="project_expenses")
    op.drop_table("project_expenses")
    for name, _ in reversed(PROJECT_MONEY_COLUMNS):
        op.drop_column("projects", name)
