"""Модель документа реестра проектов: append-only ревизии таблицы `registry_documents`.

Реестр проектов отдела — документ формата v2 («проект → вложенные отделы»). Источник
правды для плагина диспетчера — эта таблица: плагин забирает последнюю ревизию и кладёт
её кешем в `projects.json`. Поэтому здесь хранится не разобранная структура, а **готовый
документ текстом**: никто, кроме владельца формата (`plugins/registry.mjs`), не знает,
какие ключи живут только в файле, и вторая копия этих правил в базе разошлась бы с первой
на первой же правке формата.

Ревизии **только добавляются**: `PUT` и `POST /api/registry/rebuild` пишут новую строку,
прошлые не меняются и не удаляются, `GET` отдаёт последнюю. Так у человека всегда есть
предыдущий документ, а откат формата не требует переписывания истории.

`revision` — номер ревизии, уникальный (индекс `uq_registry_documents_revision`): номер
выдаётся приложением как «предыдущий + 1», и уникальный индекс превращает гонку двух
одновременных записей в честный `409`, а не в два документа с одним номером.

`body` — JSON-текст документа как его прислали (ручка не переписывает форму), `note` —
человеческая пометка о ревизии.
"""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RegistryDocument(Base):
    """Одна ревизия документа реестра проектов.

    Живых и мягко удалённых строк здесь нет: ревизия либо есть, либо её нет. Удаления
    ревизий в приложении не предусмотрено вовсе.
    """

    __tablename__ = "registry_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Номер ревизии: «предыдущая + 1». Уникальность держит индекс, а не только проверка
    # в ручке — иначе две одновременные записи дали бы один номер дважды.
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    # Документ v2 целиком, JSON-текстом. Отдаётся наружу разобранным, но лежит текстом:
    # база не навязывает документу форму, которую задаёт `plugins/registry.mjs`.
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # Пометка о ревизии: чем она собрана (`rebuild`) или откуда пришла. Необязательна.
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


Index("uq_registry_documents_revision", RegistryDocument.revision, unique=True)
