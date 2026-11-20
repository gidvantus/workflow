"""Схемы ручек реестра проектов: ответы `GET`/`PUT`/`POST rebuild`.

Сам документ реестра **не типизирован** здесь on purpose. Форма v2 («проект →
вложенные отделы») принадлежит владельцу формата — `plugins/registry.mjs`, и вторая
её копия в схемах разошлась бы с первой на первой же правке: плагин читает кеш
терпимо, а жёсткая pydantic-модель отвергала бы любой новый необязательный ключ
(порты, `areas`, `labels` живут только в файле и в базу не заводятся вовсе).
Поэтому документ принимается свободным телом и проверяется валидаторами
`app.api.registry` — они отказывают только по правилам из контракта, а не по составу
ключей, и тексты отказов совпадают с контрактом дословно.

Ответы же типизированы: `revision` и `stored_at` — часть контракта, и фронт читает
их как поля, а не как «что-то в JSON».
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class RegistryStoredResponse(BaseModel):
    """Ответ `PUT /api/registry`: номер новой ревизии и когда она записана.

    `stored_at` — время строки (`registry_documents.created_at`), а не время ответа.
    """

    revision: int
    stored_at: datetime


class RegistryRebuildResponse(RegistryStoredResponse):
    """Ответ `POST /api/registry/rebuild`: та же пара полей и собранный документ.

    Документ отдаётся сразу, чтобы человек видел, что именно попало в реестр, не делая
    второй запрос `GET`; в базе он лежит в этой же ревизии.
    """

    document: dict[str, Any]
