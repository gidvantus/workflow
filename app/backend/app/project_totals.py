"""Один итог проекта на весь журнал: сумма двух половин, а не приращения ручек.

До этой задачи итог проекта (`projects.total_cost`) умели только прибавлять: ручка
ручной записи и приём смены делали SQL-инкремент в своей транзакции. Прибавление
удобно и не теряет суммы при одновременных записях, но не умеет вычитать и не умеет
пересчитывать: после удаления строки или её пересчёта по новым ценам инкремент оставил
бы в колонке старое число.

Здесь одна формула итога на весь журнал: ручные записи проекта (`project_expenses`)
плюс смены этого проекта (`usage_shifts`, условие — `shifts_of_project`). Пересборка
всего итога вместо дельты выбрана нарочно (см. #88): одна потерянная дельта расходилась
бы с суммой строк навсегда, а пересборка после любой операции сходится с журналом.

Модуль намеренно не зависит ни от одной ручки (`app.api.*`): иначе ручки журнала
импортировали бы друг друга, и цикл импортов появился бы на первом же расширении.
Транзакцией владеет ручка: ни одна из функций здесь не коммитит.
"""

from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.expense import ProjectExpense
from app.models.project import Project
from app.models.usage_shift import UsageShift
from app.project_refs import shifts_of_project


def project_total(db: Session, project: Project) -> Decimal:
    """Сумма всех строк журнала проекта: ручные записи плюс смены по всем ключам.

    Смены ищутся тем же условием `shifts_of_project`, что и в чтении журнала: смена,
    записанная под прежним ключом проекта (`str(id)` до присвоения кода), обязана
    попасть и в итог, иначе он перестал бы сходиться с суммой строк на экране.

    Функция читает базу, поэтому изменения, ещё не сброшенные в неё (`flush`), она не
    увидит: `store_project_total` сбрасывает их сам. Отдельный вызов на свежей сессии
    видит всё, что уже записано.
    """
    expenses = db.scalar(
        select(func.coalesce(func.sum(ProjectExpense.amount), 0)).where(
            ProjectExpense.project_id == project.id
        )
    )
    shifts = db.scalar(
        select(func.coalesce(func.sum(UsageShift.cost_usd), 0)).where(shifts_of_project(project))
    )
    return _decimal(expenses) + _decimal(shifts)


def store_project_total(db: Session, project: Project) -> Decimal:
    """Пересобрать итог проекта и записать его одним `UPDATE`, вернув записанное.

    Это не приращение: колонке присваивается сумма строк журнала, поэтому операция
    сходится и после пересчёта строки, и после удаления — чего инкремент не умеет.

    Перед чтением строк сбрасываются изменения сессии (`flush`): перенесённая сумма
    строки или удалённая смена лежат в сессии, а `project_total` читает базу. `flush`
    — не `commit`: транзакцией по-прежнему владеет ручка, и откат остаётся её делом.
    """
    db.flush()
    total = project_total(db, project)
    db.execute(update(Project).where(Project.id == project.id).values(total_cost=total))
    return total


def _decimal(value: object) -> Decimal:
    """Сумма из базы `Decimal`, а пустой агрегат — ноль.

    `SUM` по `Numeric` возвращает `Decimal`, но `COALESCE` с целым нулём на пустом
    журнале отдаёт `int`: приводим через `str`, чтобы не потерять точность и не
    зависеть от диалекта (`Decimal(0)` из `float` дал бы хвост).
    """
    if value is None:
        return Decimal(0)
    return Decimal(str(value))
