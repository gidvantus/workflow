"""Справочник видов отделов: строка таблицы `department_kinds` и каталог полей страницы.

Вид отдела — зеркало справочника ролей: живёт в базе, наполняется сидом ревизии
`0006_department_kinds` из константы `DEFAULT_DEPARTMENT_KINDS`, читается read-only
ручкой `GET /api/department-kinds`. Управляющих ручек нет: новый вид — это новая
строка и новая ревизия, а не правка существующей. Отдел ссылается на вид по `id`,
поэтому добавление вида не двигает уже сохранённые отделы.

`FIELD_KEYS_BY_CODE` — каталог **порядка и состава** полей страницы правки отдела.
Ключи — часть контракта API: они уходят наружу в массиве `fields` и у ответа
справочника, и у ответа отдела. Подписи и контролы живут на фронте, поэтому третий вид
добавляется строкой сида и записью в этом каталоге, без правок фронтенда.

Для кода, которого в каталоге нет, набор полей пуст: страница показывает только
заголовок и кнопки и не падает. Набор полей — правило отображения, а не авторизация:
`PATCH` отдела принимает любое известное поле, отказ «поле не того вида» не заводится.
"""

from sqlalchemy import Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Порядок вставки = порядок выдачи: `GET /api/department-kinds` сортирует по `id`, а
# автоинкремент присваивает номера в порядке строк этой таблицы.
DEFAULT_DEPARTMENT_KINDS: tuple[tuple[str, str], ...] = (
    ("development", "Разработка"),
    ("marketing", "Маркетинг"),
)

# Порядок ключей — порядок полей на странице правки. У «Разработки» десять полей
# (расписание, роли, шесть строк, лимит возврата, уведомления), у «Маркетинга» — четыре
# строки: ни времени работы, ни ролей, ни лимита, ни уведомлений у него нет.
FIELD_KEYS_BY_CODE: dict[str, tuple[str, ...]] = {
    "development": (
        "schedule",
        "roles",
        "repo_path",
        "base_branch",
        "workspace",
        "human_workspace",
        "artifacts_dir",
        "compose_project",
        "max_rework",
        "notifications",
    ),
    "marketing": ("repo_path", "base_branch", "workspace", "human_workspace"),
}


class DepartmentKind(Base):
    """Вид отдела справочника: код для тестов и `data-testid`, название — для человека.

    Название вида становится именем отдела при создании (`Department.name`), поэтому
    имя отдела правкой не меняется, а второй отдел того же вида в проекте — конфликт.
    """

    __tablename__ = "department_kinds"
    __table_args__ = (Index("uq_department_kinds_code", "code", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
