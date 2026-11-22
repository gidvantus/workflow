"""Журнал расхода смен: таблицы `usage_shifts` и `usage_sessions`.

Ревизия заводит хранение посчитанного расхода. Считать заново ничего не нужно: числа
(токены, ходы, цена) приезжают готовыми от harness, где формула цены уже живёт
(`costOf` в `plugins/usage-ledger.mjs`). Веб складывает их и хранит **вместе с
тарифами расчёта**: смена тарифа не должна переписывать прошлые деньги.

Порядок `upgrade`:

1. `usage_shifts` — смена проекта: интервал, причина закрытия, тарифы в JSON-колонке
   (на PostgreSQL — `JSONB`), суммы по принятым сессиям и деньги `Numeric(14, 6)`;
2. частичный уникальный индекс `(project_ref, shift_key)` — делаем полным: удаления
   смен в журнале не существует ни мягкого, ни физического, поэтому условия у него нет;
3. `usage_sessions` — детализация по сессиям роли, внешний ключ на `usage_shifts.id`;
4. уникальный индекс `(project_ref, session)`: он и держит правило «одна сессия входит
   в суммы проекта один раз» — смена может взять «продолженный диалог» из прошлой
   смены, и без индекса такой диалог посчитался бы дважды;
5. индексы по `project_ref` обеих таблиц и по `shift_id`: по ним читаются суммы проекта
   и детализация смены.

`project_ref` — id проекта из реестра отдела, **без внешнего ключа** на `projects`:
реестр живёт файлом, проект может не иметь строки в вебе, а удаление проекта в вебе не
должно уносить историю расходов.

`downgrade` строго обратный и полный: сначала сессии, потом смены. Откат **теряет
журнал расхода** — второй копии этих чисел нет, они приезжают только отправкой смен,
а отправленное заново не приходит: harness не хранит отправленные смены у себя.

Revision ID: 0012_usage
Revises: 0011_department_enabled
Create Date: 2026-11-21

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0012_usage"
down_revision: str | None = "0011_department_enabled"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Тот же тип, что у модели: на PostgreSQL — `JSONB`, на остальных диалектах — `JSON`.
RATES_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    """Завести журнал расхода: смены проекта и их сессии."""
    op.create_table(
        "usage_shifts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        # Id проекта из реестра отдела. Внешнего ключа нет намеренно — см. докстринг.
        sa.Column("project_ref", sa.String(length=64), nullable=False),
        sa.Column("project_title", sa.String(length=200), nullable=False),
        sa.Column("shift_key", sa.String(length=64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        # `window` — окно закрылось, `manual` — смену закрыл человек.
        sa.Column("reason", sa.String(length=16), nullable=False),
        sa.Column("sessions_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_cache_read", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_cache_write", sa.BigInteger(), nullable=False, server_default="0"),
        # Деньги в USD с шестью знаками: тариф за миллион токенов даёт доли цента.
        sa.Column("cost_usd", sa.Numeric(precision=14, scale=6), nullable=False,
                  server_default="0"),
        # Тарифы, по которым считалась эта смена: пересчёта прошлых смен нет.
        sa.Column("rates", RATES_TYPE, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_usage_shifts_project_ref", "usage_shifts", ["project_ref"])
    op.create_index(
        "uq_usage_shifts_project_shift",
        "usage_shifts",
        ["project_ref", "shift_key"],
        unique=True,
    )

    op.create_table(
        "usage_sessions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("shift_id", sa.Integer(), nullable=False),
        sa.Column("project_ref", sa.String(length=64), nullable=False),
        # Сессия может быть без тикета: работа постановки идёт до появления номера.
        sa.Column("issue_number", sa.Integer(), nullable=True),
        sa.Column("issue_title", sa.String(length=300), nullable=True),
        sa.Column("role", sa.String(length=64), nullable=False),
        sa.Column("session", sa.String(length=100), nullable=False),
        sa.Column("source", sa.String(length=50), nullable=True),
        sa.Column("turns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_cache_read", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tokens_cache_write", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(precision=14, scale=6), nullable=False,
                  server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["shift_id"], ["usage_shifts.id"]),
    )
    op.create_index("ix_usage_sessions_shift_id", "usage_sessions", ["shift_id"])
    op.create_index("ix_usage_sessions_project_ref", "usage_sessions", ["project_ref"])
    # «Одна сессия входит в суммы проекта один раз»: индекс, а не проверка в ручке,
    # потому что две одновременные отправки не должны посчитать её дважды.
    op.create_index(
        "uq_usage_sessions_project_session",
        "usage_sessions",
        ["project_ref", "session"],
        unique=True,
    )


def downgrade() -> None:
    """Откат: журнал расхода удаляется целиком, восстанавливать его нечем."""
    op.drop_index("uq_usage_sessions_project_session", table_name="usage_sessions")
    op.drop_index("ix_usage_sessions_project_ref", table_name="usage_sessions")
    op.drop_index("ix_usage_sessions_shift_id", table_name="usage_sessions")
    op.drop_table("usage_sessions")
    op.drop_index("uq_usage_shifts_project_shift", table_name="usage_shifts")
    op.drop_index("ix_usage_shifts_project_ref", table_name="usage_shifts")
    op.drop_table("usage_shifts")
