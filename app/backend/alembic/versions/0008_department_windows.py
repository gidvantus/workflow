"""Несколько окон времени работы: колонка `departments.windows` вместо пары `с/по`.

Ревизия повторяет путь `0006_department_kinds`: сначала nullable-колонка, потом перенос
данных, и только потом `NOT NULL`. Порядок `upgrade` важен и не переставляется:

1. `add_column("departments", windows, ... nullable=True)` — на существующих строках
   значения пока нет;
2. `UPDATE` переносит старую пару в одно окно: `left(start_time::text, 5)` даёт ровно
   `"ЧЧ:ММ"` без секунд, а `to_char` зависел бы от локали сессии;
3. у строк без расписания (`NULL`/`NULL`) остаётся пустой список: расписание отдела —
   это набор окон, и пустой набор значит «расписания нет», как раньше значила пустая пара;
4. `windows` становится `NOT NULL`;
5. `end_time` и `start_time` удаляются физически — это принятое человеком необратимое
   решение: данные уже в `windows`, а вторая копия расписания разошлась бы с первой.

Ни таблиц, ни индексов, ни строк ревизия не создаёт и не удаляет: `start_time` и
`end_time` были `NOT NULL` без индексов, поэтому при удалении колонок терять нечего, а
число строк `departments` после `upgrade` не меняется.

`downgrade` строго обратный и **теряет все окна, кроме первого**: обратно пара
`start_time`/`end_time` — это одно окно. Строки с пустым набором окон возвращаются без
расписания (`NULL`/`NULL`), а не падают: после `0006_department_kinds` обе колонки
nullable, и выдумывать время вместо честного «расписания нет» нельзя.

Revision ID: 0008_department_windows
Revises: 0007_registry_documents
Create Date: 2026-11-20

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0008_department_windows"
down_revision: str | None = "0007_registry_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Тот же тип, что у модели: на PostgreSQL — `JSONB`, на остальных диалектах — `JSON`.
WINDOWS_TYPE = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    """Перенести пару `с/по` в `windows` и удалить старые колонки.

    Удаление `start_time`/`end_time` необратимо без `downgrade`, а `downgrade` вернёт
    только первое окно: лишние окна при откате теряются. Второго набора данных нет.
    """
    op.add_column(
        "departments",
        sa.Column("windows", WINDOWS_TYPE, nullable=True),
    )
    op.execute(
        "UPDATE departments SET windows = jsonb_build_array("
        "jsonb_build_object("
        "'start_time', left(start_time::text, 5), "
        "'end_time', left(end_time::text, 5)"
        ")) "
        "WHERE start_time IS NOT NULL AND end_time IS NOT NULL"
    )
    op.execute("UPDATE departments SET windows = '[]'::jsonb WHERE windows IS NULL")
    op.alter_column("departments", "windows", existing_type=WINDOWS_TYPE, nullable=False)
    op.drop_column("departments", "end_time")
    op.drop_column("departments", "start_time")


def downgrade() -> None:
    """Вернуть пару `с/по` из первого окна и удалить `windows`.

    Откат **теряет все окна, кроме первого**, и это записано в докстроке ревизии: форма
    `windows` — принятая смена контракта, обратного переноса один-к-одному не существует.
    Строки с пустым набором окон остаются без расписания (`NULL`/`NULL`): выдуманное
    время хуже честного «расписания нет».
    """
    op.add_column("departments", sa.Column("start_time", sa.Time(), nullable=True))
    op.add_column("departments", sa.Column("end_time", sa.Time(), nullable=True))
    op.execute(
        "UPDATE departments SET "
        "start_time = (windows->0->>'start_time')::time, "
        "end_time = (windows->0->>'end_time')::time "
        "WHERE jsonb_array_length(windows) > 0"
    )
    op.drop_column("departments", "windows")
