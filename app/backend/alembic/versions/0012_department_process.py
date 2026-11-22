"""Процесс отдела: колонка `departments.process` — таблица ступеней конвейера документом.

Ревизия аддитивная и откатываемая: добавляется одна nullable JSON-колонка, данные не
переписываются. У всех существующих отделов значение остаётся `NULL`, а `NULL` значит
«своего процесса нет» — диспетчер исполняет умолчания, то есть после выкатки ни один
проект не меняет поведения ни на одном тике. Это и есть причина, по которой ревизию
можно ставить до того, как веб научится сохранять процесс.

**Что в колонке.** Только `version`, `labels`, `steps` — документ процесса. Лимиты отдела
(`maxAttempts`, `maxRework`, `stuckAfterMinutes`) остаются каждый в своём месте: второй
источник тех же чисел постановка запрещает.

**Тип.** `JSON` с вариантом `JSONB` на PostgreSQL — как у `departments.windows`: на стенде
данные лежат в `jsonb`, в тестах на SQLite — в `json`. Проверка документа живёт в Python
(`app/schemas/process.py`), поэтому поведение диалектов совпадает.

`downgrade` строго обратный: дропает колонку. Откат теряет **только сохранённые процессы**:
отделы, у которых процесс правили, после отката работают на умолчаниях, а их документы
приходят из истории ревизий реестра — отдельной таблицы истории у процесса нет.

Revision ID: 0012_department_process
Revises: 0011_department_enabled
Create Date: 2026-11-22

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0012_department_process"
down_revision: str | None = "0011_department_enabled"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Тип колонки: тот же выбор диалекта, что в модели отдела (`PROCESS_JSON`).
PROCESS_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    """Добавить `departments.process`: nullable, данные не трогаются.

    `NOT NULL` нет намеренно: `NULL` — это «умолчания», а не «пустой процесс». Заполнять
    колонку копией умолчаний значило бы завести 13 строк JSON у каждого отдела, который
    процесс не правил, и потерять разницу между «так решил человек» и «как было».
    """
    op.add_column("departments", sa.Column("process", PROCESS_JSON, nullable=True))


def downgrade() -> None:
    """Откат: колонка снимается целиком. Теряются только сохранённые процессы.

    Настройки, окна, роли и флаг работы отдел сохраняет; после повторного `upgrade`
    значение вернётся `NULL` — то есть отдел снова работает на умолчаниях и процесс
    придётся сохранить заново (или забрать из истории ревизий реестра).
    """
    op.drop_column("departments", "process")
