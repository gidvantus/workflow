"""Ручки справочника ролей: только чтение.

Управляющих ручек (`POST`/`PATCH`/`DELETE`) у ролей нет: справочник меняется миграцией,
потому что отделы ссылаются на роль по `id` и правка строки под ними недопустима.
"""

from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.role import Role
from app.schemas.department import RoleResponse

router = APIRouter(prefix="/api/roles", tags=["roles"])

DbSession = Annotated[Session, Depends(get_db)]


@router.get(
    "",
    response_model=list[RoleResponse],
    summary="Справочник ролей",
)
def list_roles(db: DbSession) -> Sequence[Role]:
    """Все роли справочника, порядок — по `id` возрастанию (он же порядок сида)."""
    return db.scalars(select(Role).order_by(Role.id)).all()
