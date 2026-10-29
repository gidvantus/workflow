"""Справочник ролей: строка таблицы `roles` и каталог ролей по умолчанию.

Роли берутся из пресетов надстройки, но в рантайме их прочитать нельзя: каталога
`plugins/` в образе `api` нет. Поэтому справочник живёт в базе, а наполняет его сид
миграции `0003_departments` из константы `DEFAULT_ROLES` — она же используется в тестах,
чтобы сид миграции и сид тестов не разъехались.

Отдел ссылается на роль по `id`: новая роль — это новая строка (и новая ревизия), а не
правка существующей, поэтому добавление роли не двигает уже сохранённые отделы.
"""

from sqlalchemy import Index, Integer, String
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
    """Роль справочника: код для тестов и `data-testid`, название — для человека."""

    __tablename__ = "roles"
    __table_args__ = (Index("uq_roles_code", "code", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
