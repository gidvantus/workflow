"""Долларовый прайс: шесть знаков у денег журнала и один итог проекта на обе половины.

Ревизия доводит деньги журнала до одного вида и одного итога:

1. `project_expenses.amount` расширяется с `Numeric(20, 2)` до `Numeric(24, 6)`. Сумма
   ручной записи и сумма смены печатаются в одной ведомости одним форматом — шесть
   знаков, — и копеечное округление ручной половины разошлось бы с итогом, в который
   смена прибавляет шесть знаков. Знаков до точки не меньше, чем у прежней `(20, 2)`:
   восемнадцать. Максимум контракта — цена до десяти знаков и количество до 10^12 —
   даёт строку до 4·10^16, то есть восемнадцать знаков, а `(20, 6)` оставила бы
   четырнадцать и отдавала бы `500` на теле, прошедшем все проверки формы;
2. `projects.total_cost` расширяется так же (`Numeric(24, 6)`) по той же причине:
   итог складывается из уже округлённых сумм обеих половин;
3. итог **бэкфиллится** суммой принятых смен: до этой ревизии смены в итог проекта не
   попадали вовсе, и после неё итог обязан быть суммой обеих половин. Смена находит свой
   проект по `project_ref` — по **любому** из его ключей: пока кода нет, реестр зовёт
   проект `str(id)`, а после присвоения кода — кодом, и смены, записанные под прежним
   ключом, остаются сменами этого проекта. Тем же набором ключей ищет смены ручка приёма
   (`app.project_refs.project_ref_keys`), поэтому бэкфилл и дальнейший прирост считаются
   одинаково и итог сходится с суммой строк журнала.

Бэкфилл берёт только живые проекты (`deleted_at IS NULL`): журнал мягко удалённого проекта
не читается (`404`), прибавлять ему деньги некуда, и ручка приёма смены поступает так же.

`downgrade` строго обратный: вычитает из итога ровно то, что прибавил `upgrade`, и сужает
обе колонки обратно. Откат **теряет** шестой знак денег журнала: суммы округляются до
копейки, и вернуть их после повторного `upgrade` нечем — бэкфилл прибавит смены заново, а
округлённые ручные записи останутся округлёнными.

Revision ID: 0015_usd_journal
Revises: 0014_department_process
Create Date: 2026-11-24

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015_usd_journal"
down_revision: str | None = "0014_department_process"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Сумма принятых смен проекта — вторая половина его итога. Ключей у проекта два: код
# (без учёта регистра) и числовой id строкой, — и берутся оба, как в
# `app.project_refs.project_ref_keys`. `lower(projects.code)` у проекта без кода — `NULL`,
# сравнение с `NULL` не истинно, поэтому лишняя ветка ничего не прибавляет. Код из одних
# цифр запрещён проверкой ручки проекта, поэтому ключи двух проектов не пересекаются и
# одна смена не попадёт в два итога.
SHIFT_SUM = """
    SELECT COALESCE(sum(usage_shifts.cost_usd), 0)
      FROM usage_shifts
     WHERE lower(usage_shifts.project_ref) IN (
               lower(projects.code),
               CAST(projects.id AS TEXT)
           )
"""

ADD_SHIFT_SUM = (
    f"UPDATE projects SET total_cost = total_cost + ({SHIFT_SUM})"
    " WHERE projects.deleted_at IS NULL"
)
SUBTRACT_SHIFT_SUM = (
    f"UPDATE projects SET total_cost = total_cost - ({SHIFT_SUM})"
    " WHERE projects.deleted_at IS NULL"
)


def upgrade() -> None:
    """Расширить деньги журнала до шести знаков и прибавить к итогу принятые смены."""
    op.alter_column(
        "project_expenses",
        "amount",
        existing_type=sa.Numeric(precision=20, scale=2),
        type_=sa.Numeric(precision=24, scale=6),
        existing_nullable=False,
    )
    op.alter_column(
        "projects",
        "total_cost",
        existing_type=sa.Numeric(precision=20, scale=2),
        type_=sa.Numeric(precision=24, scale=6),
        existing_nullable=False,
    )
    op.execute(ADD_SHIFT_SUM)


def downgrade() -> None:
    """Откат: снять прибавленные смены и сузить деньги обратно до копейки.

    Теряет шестой знак сумм журнала и итога: округление до копейки необратимо.
    """
    op.execute(SUBTRACT_SHIFT_SUM)
    op.alter_column(
        "projects",
        "total_cost",
        existing_type=sa.Numeric(precision=24, scale=6),
        type_=sa.Numeric(precision=20, scale=2),
        existing_nullable=False,
    )
    op.alter_column(
        "project_expenses",
        "amount",
        existing_type=sa.Numeric(precision=24, scale=6),
        type_=sa.Numeric(precision=20, scale=2),
        existing_nullable=False,
    )
