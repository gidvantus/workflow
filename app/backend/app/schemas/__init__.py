"""Схемы запросов и ответов — контракт, который читает фронтенд."""

from app.schemas.department import (
    DepartmentCreate,
    DepartmentKindRef,
    DepartmentKindResponse,
    DepartmentResponse,
    DepartmentUpdate,
    RoleResponse,
)
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
from app.schemas.usage import (
    UsageProjectTotal,
    UsageProjectTotals,
    UsageProjectUsage,
    UsageRates,
    UsageSessionRow,
    UsageShiftDetail,
    UsageShiftRow,
    UsageShiftStored,
    UsageTokens,
)

__all__ = [
    "DepartmentCreate",
    "DepartmentKindRef",
    "DepartmentKindResponse",
    "DepartmentResponse",
    "DepartmentUpdate",
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
    "UsageProjectTotal",
    "UsageProjectTotals",
    "UsageProjectUsage",
    "UsageRates",
    "UsageSessionRow",
    "UsageShiftDetail",
    "UsageShiftRow",
    "UsageShiftStored",
    "UsageTokens",
]
