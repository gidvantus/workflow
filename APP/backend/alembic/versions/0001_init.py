"""Пустая стартовая ревизия: доказывает, что alembic подключён к базе.

Доменных таблиц в этой задаче нет. Задача ревизии — создать в PostgreSQL таблицу
`alembic_version` со значением `0001_init`, то есть подтвердить рабочее подключение.

Revision ID: 0001_init
Revises:
Create Date: 2026-10-27

"""

from collections.abc import Sequence

revision: str = "0001_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Таблиц нет: ревизия ничего не создаёт."""


def downgrade() -> None:
    """Откатывать нечего."""
