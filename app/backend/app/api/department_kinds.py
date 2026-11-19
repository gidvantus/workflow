"""Ручки справочника видов отделов: только чтение.

Управляющих ручек (`POST`/`PATCH`/`DELETE`) у видов нет: справочник меняется миграцией,
потому что отделы ссылаются на вид по `id`, имя отдела равно названию вида, а порядок и
состав полей страницы правки — часть контракта. Новый вид — это новая строка сида и
запись в каталоге `FIELD_KEYS_BY_CODE`, то есть новая ревизия, а не правка существующей.

Вид отдаётся вместе с набором ключей полей страницы (`fields`): фронт держит подпись и
контрол на каждый ключ, порядок берёт из этого массива, а неизвестный ключ не рисует.
"""

from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.department_kind import DepartmentKind
from app.schemas.department import DepartmentKindResponse

router = APIRouter(prefix="/api/department-kinds", tags=["department-kinds"])

DbSession = Annotated[Session, Depends(get_db)]


@router.get(
    "",
    response_model=list[DepartmentKindResponse],
    summary="Справочник видов отделов",
)
def list_department_kinds(db: DbSession) -> Sequence[DepartmentKind]:
    """Все виды справочника, порядок — по `id` возрастанию (он же порядок сида).

    У каждого вида — `fields`: ключи полей страницы правки в порядке отображения.
    Управляющих ручек у справочника нет, как и у ролей.
    """
    return db.scalars(select(DepartmentKind).order_by(DepartmentKind.id)).all()
