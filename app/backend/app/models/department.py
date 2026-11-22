"""Модель отдела: проект, вид из справочника, расписание, роли и признак мягкого удаления.

Отдел живёт внутри проекта: `project_id` — внешний ключ на `projects`, а имя отдела
уникально **в пределах проекта**. Колонка допускает `NULL`: данные, заведённые до
появления привязки, не удаляются и не бэкфиллятся, поэтому строка без проекта — это
сирота, а не ошибка схемы. Обязательность привязки держит API, а не колонка.

Вид отдела (`kind_id`) задаёт набор полей страницы правки: порядок и состав полей
приезжают наружу массивом `fields` из каталога `FIELD_KEYS_BY_CODE`. Имя отдела — это
`title` вида на момент создания, и правкой оно не меняется: переименования отделов в
приложении нет.

Время работы — **набор окон** `windows`: от одного до шести диапазонов «с/по» в одной
JSON-колонке (на PostgreSQL — `JSONB`), без второй таблицы и без join-ов. Пустой список —
отдела без расписания: так создаются все отделы, а у вида «Маркетинг» времени работы нет
вовсе. Переход через полночь (`end_time < start_time`, например 13:00 → 04:00) —
свойство **каждого** окна, а не «два окна внутри суток». Пересечение окон запрещено;
окна, касающиеся концами (`13:00–18:00` и `18:00–21:00`), не пересекаются.

Элемент списка — ровно `{"start_time": "ЧЧ:ММ", "end_time": "ЧЧ:ММ"}`. Порядок окон в
списке — по возрастанию `start_time`, и пишет его **только ручка**: значение колонки
присваивается целиком, `MutableDict` и правка списка на месте не используются — иначе
SQLAlchemy не увидит изменения, а `updated_at` не сдвинется.

Признак `enabled` — «работа отдела включена». Выключенный отдел диспетчер не обслуживает:
он не берёт задачи из очереди, а настройки и роли отдел сохраняет — флаг ничего не стирает
и не прячет, поэтому выключение обратимо одним `PATCH`. Умолчание `true`: выключенный
отдел перестаёт работать, и `false` из ниоткуда остановил бы работу после выкатки. В
документ реестра признак попадает ключом `enabled` **всегда** — отсутствие ключа
диспетчер читает как «включён».

Отдел ссылается на роли через таблицу связи `department_roles`. Мягко удалённый отдел
свои строки связи не теряет: физического удаления в приложении нет, поэтому набор ролей
удалённого отдела остаётся в базе как есть. Ролей может не быть ни одной: пустой набор —
это не ошибка, а «роли ещё не заполнены».
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.department_kind import DepartmentKind
from app.models.role import Role

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = text("deleted_at IS NULL")

# Тип колонки окон: на стенде (PostgreSQL) — `JSONB`, в тестах (SQLite) — `JSON`.
# Вся проверка окон живёт в Python, поэтому поведение обоих диалектов совпадает; на
# JSON-операторы в запросах ручки не опираются.
WINDOWS_JSON = JSON().with_variant(JSONB(), "postgresql")

# Лимит возврата задачи по умолчанию: столько раз задачу можно вернуть в работу, если
# поле на странице правки оставили пустым.
DEFAULT_MAX_REWORK = 3

# Связь многие-ко-многим: у отдела много ролей, роль может стоять в нескольких отделах.
department_roles = Table(
    "department_roles",
    Base.metadata,
    Column("department_id", ForeignKey("departments.id"), primary_key=True),
    Column("role_id", ForeignKey("roles.id"), primary_key=True),
)


class Department(Base):
    """Отдел проекта в списке вкладки «Отделы».

    Удаление мягкое: `DELETE` ставит `deleted_at`, строка остаётся в таблице и в списке
    больше не показывается. Восстановления через интерфейс нет.
    """

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # `NULL` — строка, заведённая до привязки отдела к проекту: в списках проекта она
    # не видна, а плоские `PATCH`/`DELETE` её по-прежнему достают.
    project_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("projects.id"),
        nullable=True,
        index=True,
    )
    # Вид отдела: справочник `department_kinds`. Обязателен — миграция `0006` бэкфиллит
    # его всем строкам, включая сирот, и только потом снимает `NULL`.
    kind_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("department_kinds.id"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Окна работы: до шести пар «с/по» в одной JSON-колонке. Пустой список — расписания
    # нет: отдел создаётся без него, а у «Маркетинга» его нет вовсе. Порядок — по
    # возрастанию начала, его задаёт ручка.
    windows: Mapped[list[dict[str, str]]] = mapped_column(
        WINDOWS_JSON,
        nullable=False,
        default=list,
    )
    # Поля страницы правки: набор задаёт вид, сами значения — необязательные строки.
    repo_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    base_branch: Mapped[str | None] = mapped_column(String(200), nullable=True)
    workspace: Mapped[str | None] = mapped_column(String(500), nullable=True)
    human_workspace: Mapped[str | None] = mapped_column(String(500), nullable=True)
    artifacts_dir: Mapped[str | None] = mapped_column(String(500), nullable=True)
    compose_project: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Токен и id чата телеграм-бота отдела. Хранятся открытым текстом: аутентификации в
    # приложении нет, а стенд не публичный — это принятое решение, а не упущение.
    telegram_token: Mapped[str | None] = mapped_column(String(200), nullable=True)
    telegram_chat_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Лимит возврата задачи: пустое поле на странице правки означает `DEFAULT_MAX_REWORK`.
    max_rework: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=DEFAULT_MAX_REWORK,
        server_default=str(DEFAULT_MAX_REWORK),
    )
    # Работа отдела: выключенный отдел диспетчер не обслуживает — он не берёт задачи из
    # очереди, а настройки и роли отдел сохраняет: флаг ничего не удаляет и не прячет.
    # `true` по умолчанию: `false` из ниоткуда остановил бы работу после выкатки.
    enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("true"),
    )
    # Блок «Включить уведомления»: выключенный флажок значения полей токена и чата не
    # стирает, он означает «поля не показывать и не отправлять».
    notifications_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=text("false"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    # Признак soft delete: `NULL` — отдел живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )
    # `joined`: одна строка на отдел достаётся тем же `SELECT`, что и сам отдел, а не
    # вторым запросом на каждую строку списка.
    kind: Mapped[DepartmentKind] = relationship(DepartmentKind, lazy="joined")
    # `selectin`: роли приезжают одним дополнительным запросом, а не по строке на отдел,
    # и порядок ответа задаёт `id`, а не порядок в таблице связи. `secondaryjoin` с
    # `Role.deleted_at IS NULL` — потому что мягко удалённая роль из списка отдела
    # исчезает, как и из `GET /api/roles`: строка связи при этом остаётся в базе.
    roles: Mapped[list[Role]] = relationship(
        Role,
        secondary=department_roles,
        primaryjoin="Department.id == department_roles.c.department_id",
        secondaryjoin="and_(Role.id == department_roles.c.role_id, Role.deleted_at.is_(None))",
        order_by=Role.id,
        lazy="selectin",
    )


# Уникальность названия среди живых строк **одного проекта** держит индекс, а не только
# проверка в ручке: два одновременных `POST` без него создали бы дубль. Имя может
# совпадать у отделов разных проектов — это не конфликт.
#
# Условие поддержано и в PostgreSQL, и в SQLite, поэтому тесты на SQLite в памяти не
# расходятся со стендом. Строки с `project_id IS NULL` индекс не различает (в обоих
# диалектах `NULL` не равен `NULL`): уникальность сирот — забота ручки, а не индекса.
Index(
    "uq_departments_project_name_alive",
    Department.project_id,
    func.lower(Department.name),
    unique=True,
    postgresql_where=ALIVE_CONDITION,
    sqlite_where=ALIVE_CONDITION,
)
