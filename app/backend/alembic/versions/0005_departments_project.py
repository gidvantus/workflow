"""Отдел внутри проекта: колонка `project_id` и уникальность имени в пределах проекта.

Ревизия только добавляет колонку, индекс и внешний ключ и заменяет уникальный индекс
имени: таблицы `departments` и `department_roles` вместе с содержимым остаются на месте.
Ни `UPDATE`, ни `DELETE` здесь нет — строки, заведённые до привязки, остаются с
`project_id IS NULL`. Их не удаляют и не бэкфиллят: привязки к проекту у них нет и взять
её неоткуда, а живой отдел без проекта в списках проекта просто не виден.

Колонка **допускает `NULL`**: обязательность привязки держит API, а не схема, иначе
существующие строки пришлось бы либо удалить, либо приписать к выдуманному проекту.

Глобальный уникальный индекс `uq_departments_name_alive` заменяется на
`uq_departments_project_name_alive` по `(project_id, lower(name))`: одно и то же имя в
двух проектах — не конфликт. Частичное условие `deleted_at IS NULL` прежнее, поэтому имя
удалённого отдела по-прежнему свободно. `NULL` в индексе не равен `NULL`, так что
уникальность строк без проекта индекс не держит — её держит ручка.

`downgrade` строго обратный: вернуть глобальный уникальный индекс и снять колонку.
Откат **теряет привязку** отделов к проектам — на базе с отделами в двух проектах один
из них станет недостижим по паре, поэтому откатываться только после снятия бэкапа.

Revision ID: 0005_departments_project
Revises: 0004_tasks
Create Date: 2026-11-02

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_departments_project"
down_revision: str | None = "0004_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = sa.text("deleted_at IS NULL")


def upgrade() -> None:
    """Добавить `project_id`, внешний ключ, индекс и уникальность имени в проекте."""
    op.add_column("departments", sa.Column("project_id", sa.Integer(), nullable=True))
    op.create_index("ix_departments_project_id", "departments", ["project_id"])
    op.create_foreign_key(
        "fk_departments_project_id",
        "departments",
        "projects",
        ["project_id"],
        ["id"],
    )
    op.drop_index("uq_departments_name_alive", table_name="departments")
    op.create_index(
        "uq_departments_project_name_alive",
        "departments",
        ["project_id", sa.text("lower(name)")],
        unique=True,
        postgresql_where=ALIVE_CONDITION,
    )


def downgrade() -> None:
    """Откат: глобальная уникальность имени, затем колонка, индекс и ключ.

    Откат теряет привязку отделов к проектам: колонка `project_id` пропадает вместе
    со значениями.
    """
    op.drop_index("uq_departments_project_name_alive", table_name="departments")
    op.create_index(
        "uq_departments_name_alive",
        "departments",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=ALIVE_CONDITION,
    )
    op.drop_constraint("fk_departments_project_id", "departments", type_="foreignkey")
    op.drop_index("ix_departments_project_id", table_name="departments")
    op.drop_column("departments", "project_id")
