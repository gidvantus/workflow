"""Таблица ревизий документа реестра проектов `registry_documents`.

Ревизия только создаёт новую таблицу и уникальный индекс по `revision`: строк
`projects`/`departments` она не трогает, поэтому существующие данные приложения
остаются как есть. Наполнения нет — первая ревизия появляется из ручки
`POST /api/registry/rebuild` или `PUT /api/registry`, а не из миграции: документ
собирается из текущих строк базы, и зашивать его в ревизию значило бы завести
историю, которой не было.

`downgrade` дропает таблицу вместе с содержимым: ревизии — история документа, и
потерять их при откате честнее, чем оставить таблицу, которой нет в моделях. Данные
`projects`/`departments` откат не задевает.

Revision ID: 0007_registry_documents
Revises: 0006_department_kinds
Create Date: 2026-11-20

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_registry_documents"
down_revision: str | None = "0006_department_kinds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Создать `registry_documents` и уникальный индекс по номеру ревизии."""
    op.create_table(
        "registry_documents",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        # Документ v2 лежит JSON-текстом: форму задаёт `plugins/registry.mjs`.
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_registry_documents_revision", "registry_documents", ["revision"], unique=True)


def downgrade() -> None:
    """Откат: таблица ревизий вместе с историей документа.

    `projects` и `departments` откат не трогает. Восстановить ревизии после отката
    можно только новой сборкой (`rebuild`) — прежние номера при этом начнутся заново.
    """
    op.drop_index("uq_registry_documents_revision", table_name="registry_documents")
    op.drop_table("registry_documents")
