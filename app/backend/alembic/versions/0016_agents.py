"""Справочник агентов: таблица `agents` и сид диспетчера `dsh`.

Ревизия аддитивная: существующие столбцы не меняются, данные отделов и процессов не
переписываются. Ступени берут агента из входящих тегов проекта, поэтому таблицы связи
«отдел — агент» нет — агент живёт кодом внутри `tags[].agent` документа процесса.

**Сид `dsh`.** Диспетчер пишет себе heartbeat перед каждым ходом
(`PUT /api/agents/dsh/status`), а ручка адресуется кодом живого агента. Без строки
`dsh` heartbeat получал бы `404` на каждом ходе, поэтому ревизия заводит её здесь:
код `dsh`, среда `dsh`, включён. Удалить её из веба можно — это обычный агент
справочника; тогда heartbeat просто перестанет записываться, а ход не сорвётся.

`downgrade` дропает таблицу **с содержимым**: заведённые в вебе агенты теряются, а
сохранённые процессы остаются с кодами, которых больше нет. Это ловит следующее
сохранение процесса (`422 «Агент не найден»`), а работающий диспетчер считает такой
тег тегом без агента — ступень снова берёт `dsh`.

Revision ID: 0016_agents
Revises: 0015_usd_journal
Create Date: 2026-11-24

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_agents"
down_revision: str | None = "0015_usd_journal"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AGENTS = sa.table(
    "agents",
    sa.column("code", sa.String(50)),
    sa.column("title", sa.String(100)),
    sa.column("runtime", sa.String(20)),
    sa.column("enabled", sa.Boolean),
)


def upgrade() -> None:
    """Создать `agents`, уникальный индекс кода и строку диспетчера."""
    op.create_table(
        "agents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("title", sa.String(100), nullable=False),
        sa.Column("runtime", sa.String(20), nullable=False, server_default="http"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_state", sa.String(20), nullable=True),
        sa.Column("last_issue", sa.Integer(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("uq_agents_code", "agents", ["code"], unique=True)
    op.bulk_insert(
        AGENTS,
        [{"code": "dsh", "title": "Диспетчер", "runtime": "dsh", "enabled": True}],
    )


def downgrade() -> None:
    """Откат: таблица снимается вместе с содержимым."""
    op.drop_index("uq_agents_code", table_name="agents")
    op.drop_table("agents")
