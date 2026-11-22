"""Модель проекта: строка таблицы `projects` с признаком мягкого удаления."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Index, Integer, Numeric, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# Условие частичного индекса: в нём участвуют только живые строки.
ALIVE_CONDITION = text("deleted_at IS NULL")

# Условие частичного индекса кода: проект живой и код у него задан.
CODE_CONDITION = text("deleted_at IS NULL AND code IS NOT NULL")


class Project(Base):
    """Проект в списке экрана «Проекты».

    Удаление мягкое: `DELETE` ставит `deleted_at`, строка остаётся в таблице и в списке
    больше не показывается. Восстановления через интерфейс нет.

    `code` — стабильный слаг проекта (`workflow`, `CRMDormitory`), он же `id` проекта в
    документе реестра. Задаётся один раз и дальше не меняется: смена кода сменила бы
    идентификатор проекта в реестре. `NULL` — код ещё не задан, и в реестре проект
    остаётся под числовым `str(id)`.

    Деньги проекта живут здесь же: четыре цены в долларах США за 1 000 000 токенов и
    хранимая стоимость `total_cost`. Второго прайса в отделе нет: и ручная запись журнала,
    и смена отдела считаются по этим четырём ценам. Итог не вычисляется на чтении из
    журнала: ручки записи прибавляют сумму к колонке SQL-инкрементом в той же транзакции,
    поэтому два одновременных `POST` не теряют копейки.
    """

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    code: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    description: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default=text("''"),
    )
    repo_url: Mapped[str] = mapped_column(String(500), nullable=False)
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
    # Цены за 1 000 000 токенов — доллары США с шестью знаками. Ноль значит «не
    # тарифицируется», а не «неизвестно»: незаполненных цен у проекта нет, есть нулевые.
    # У ручной записи все четыре нуля — отказ («Цены проекта не заполнены»), у смены —
    # нулевая сумма: смену, приехавшую от отдела, выбрасывать нельзя.
    price_input: Mapped[Decimal] = mapped_column(
        Numeric(18, 6),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    price_output: Mapped[Decimal] = mapped_column(
        Numeric(18, 6),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    price_cache_read: Mapped[Decimal] = mapped_column(
        Numeric(18, 6),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    price_cache_write: Mapped[Decimal] = mapped_column(
        Numeric(18, 6),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    # Хранимая стоимость проекта: сумма уже округлённых сумм обеих половин журнала —
    # ручных записей и принятых смен. Журнал не правится и не удаляется, поэтому
    # денормализация не может разойтись с ним.
    # `Numeric(20, 6)` с запасом под максимум контракта: цена до 10 знаков и количество
    # до 10^12 дают сумму до 4·10^16. Шесть знаков, а не два: деньги журнала в долларах
    # США печатаются шестью знаками, и итог обязан быть той же точности, что его строки.
    total_cost: Mapped[Decimal] = mapped_column(
        Numeric(20, 6),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    # Признак soft delete: `NULL` — проект живой.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )


# Уникальность названия среди живых строк держит индекс, а не только проверка в ручке:
# два одновременных `POST` без него создали бы дубль. Условие поддержано и в PostgreSQL,
# и в SQLite, поэтому тесты на SQLite в памяти не расходятся со стендом.
Index(
    "uq_projects_name_alive",
    func.lower(Project.name),
    unique=True,
    postgresql_where=ALIVE_CONDITION,
    sqlite_where=ALIVE_CONDITION,
)

# Занятость кода держит такой же частичный индекс, но по `lower(code)` и с условием
# «код задан»: проектов без кода может быть сколько угодно, а `NULL` в уникальности не
# участвует. Сравнение без учёта регистра — потому что в живом реестре есть
# `CRMDormitory`, и он не должен столкнуться с `crmdormitory`.
Index(
    "uq_projects_code_alive",
    func.lower(Project.code),
    unique=True,
    postgresql_where=CODE_CONDITION,
    sqlite_where=CODE_CONDITION,
)
