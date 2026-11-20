"""Справочник ролей: строка таблицы `roles` и каталог ролей по умолчанию.

Роли берутся из пресетов надстройки, но в рантайме их прочитать нельзя: каталога
`plugins/` в образе `api` нет. Поэтому справочник живёт в базе, а наполняет его сид
миграции `0003_departments` из константы `DEFAULT_ROLES` — она же используется в тестах,
чтобы сид миграции и сид тестов не разъехались.

Отдел ссылается на роль по `id`. Раньше справочник менялся только миграцией; теперь
роли правятся из веба (раздел «Роли»): меняются `title` и `description`, а `code`
неизменяем, потому что по нему раскладывается каталог пресета DSH. Удаление мягкое —
код удалённой роли занят навсегда, поэтому правка названия не превращается в новую роль.
"""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Порядок вставки = порядок выдачи: `GET /api/roles` сортирует по `id`, а автоинкремент
# присваивает номера в порядке строк этой таблицы.
DEFAULT_ROLES: tuple[tuple[str, str], ...] = (
    ("analyst", "Аналитик"),
    ("dev-fullstack", "Разработчик (полный стек)"),
    ("dev-backend", "Бэкенд-разработчик"),
    ("dev-frontend", "Фронтенд-разработчик"),
    ("code-review", "Код-ревьюер"),
    ("tester", "Тестировщик"),
    ("devops-delivery", "DevOps-инженер"),
    ("design", "Дизайнер"),
    ("security-review", "Безопасник"),
    ("jev", "Jev (System One)"),
)


class Role(Base):
    """Роль справочника: код для тестов и `data-testid`, название — для человека.

    Код роли — это ещё и имя каталога пресета DSH (`plugins/agent-presets/<code>`),
    поэтому он неизменяем, а код мягко удалённой роли не переиспользуется: уникальный
    индекс `uq_roles_code` не частичный и видит удалённые строки тоже.

    `description` уходит в `preset.yml` пресета, `deleted_at` — признак мягкого удаления:
    удалённая роль исчезает из списков и из пресетов, но связи `department_roles` и её
    собственные скиллы остаются в базе.
    """

    __tablename__ = "roles"
    __table_args__ = (Index("uq_roles_code", "code", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    # Описание роли: необязательное для человека, но пресет отдаёт его в `preset.yml`.
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    # Признак soft delete: `NULL` — роль живая.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
