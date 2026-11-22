"""Схемы запросов и ответов — контракт, который читает фронтенд."""

from app.schemas.department import (
    DepartmentCreate,
    DepartmentKindRef,
    DepartmentKindResponse,
    DepartmentResponse,
    DepartmentUpdate,
    RoleResponse,
)
from app.schemas.expense import ExpenseCreate, ExpenseListResponse, ExpenseResponse
from app.schemas.presets import (
    PresetManifest,
    PresetPutRequest,
    PresetRoleDocument,
    PresetRoleRef,
    PresetSkill,
    PresetStoredResponse,
)
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.schemas.role import RoleCreate, RoleItem, RoleUpdate
from app.schemas.skill import SkillCreate, SkillResponse, SkillSection, SkillUpdate
from app.schemas.task import TaskCreate, TaskResponse

__all__ = [
    "DepartmentCreate",
    "DepartmentKindRef",
    "DepartmentKindResponse",
    "DepartmentResponse",
    "DepartmentUpdate",
    "ExpenseCreate",
    "ExpenseListResponse",
    "ExpenseResponse",
    "PresetManifest",
    "PresetPutRequest",
    "PresetRoleDocument",
    "PresetRoleRef",
    "PresetSkill",
    "PresetStoredResponse",
    "ProjectCreate",
    "ProjectResponse",
    "ProjectUpdate",
    "RoleCreate",
    "RoleItem",
    "RoleResponse",
    "RoleUpdate",
    "SkillCreate",
    "SkillResponse",
    "SkillSection",
    "SkillUpdate",
    "TaskCreate",
    "TaskResponse",
]
