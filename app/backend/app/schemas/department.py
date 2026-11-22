"""Схемы отдела, вида отдела и роли: тело ответа и тела запросов.

Ограничения длины и формата полей заданы **не** здесь, а валидаторами из
`app.api.departments`: так текст отказа ровно тот, что записан в контракте, и одинаков
для правки любой строки.

Время в ответе — строка `"ЧЧ:ММ"` (`"13:00"`), а не `"13:00:00"`: `<input type="time">`
на фронте получает значение из этого поля без собственного форматирования, и секунды
сделали бы его невалидным. Время работы — список окон `windows`; пустой список —
«расписания нет»: так отдел приходит сразу после создания и так выглядит «Маркетинг».
Порядок окон — по возрастанию начала, его задаёт сервер; фронт массив не сортирует.

`fields` — набор и порядок полей страницы правки, вычисляемый из вида: каталог
`FIELD_KEYS_BY_CODE` живёт в одном месте (`app.models.department_kind`), поэтому
добавление третьего вида не требует ни правки схем, ни правок фронтенда.
"""

from datetime import datetime, time

from pydantic import BaseModel, ConfigDict, computed_field, field_serializer

from app.models.department_kind import FIELD_KEYS_BY_CODE


class RoleResponse(BaseModel):
    """Роль справочника в `GET /api/roles` и внутри ответа отдела."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str


class DepartmentKindRef(BaseModel):
    """Вид отдела внутри ответа отдела: `id` для правки, `code` для `data-testid`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str


class DepartmentKindResponse(BaseModel):
    """Вид справочника в `GET /api/department-kinds` вместе с набором полей страницы."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    title: str

    @computed_field  # type: ignore[prop-decorator]
    @property
    def fields(self) -> list[str]:
        """Ключи полей страницы правки в порядке отображения; нет в каталоге — пусто."""
        return list(FIELD_KEYS_BY_CODE.get(self.code, ()))


class WindowInput(BaseModel):
    """Окно времени работы во входном теле: время приходит строкой и проверяется ручкой.

    `start_time: str`, а не `time`: отказ на `9:00`, `25:00` и `12:60` отдаёт валидатор
    `app.api.departments` одним и тем же текстом контракта, а не `422` схемы списком
    ошибок pydantic.
    """

    start_time: str
    end_time: str


class WindowValue(BaseModel):
    """Окно времени работы в ответе: время как `"ЧЧ:ММ"` без секунд.

    Полей ровно два: элемент колонки `windows` — это `{"start_time", "end_time"}`, и
    другие ключи в ответ отдела не попадают.
    """

    start_time: time
    end_time: time

    @field_serializer("start_time", "end_time")
    def serialize_clock(self, value: time) -> str:
        """В JSON — только часы и минуты: `"13:00"`, без секунд."""
        return value.strftime("%H:%M")


class DepartmentResponse(BaseModel):
    """Живой отдел в ответах `GET`, `POST` и `PATCH`.

    `deleted_at` наружу не отдаётся: клиент и так видит только живые строки.

    `project_id` типизирован `int | None`, а не `int`: отдел, заведённый до привязки к
    проекту, достаётся плоскими `PATCH`/`DELETE`, и жёсткий `int` уронил бы ответ на
    валидации `500` вместо честного `project_id: null` в списке живых отделов проекта.

    Строковые поля страницы правки отдаются как `null`, когда не заполнены: пустая
    строка в базе не появляется ни после одной правки.

    `enabled` — «работа отдела включена»; отдаётся всегда булевым, а не `null`: у флага
    нет значения «не заполнено», и выключенный отдел — это `false`, а не отсутствие поля.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int | None
    name: str
    kind: DepartmentKindRef
    windows: list[WindowValue]
    roles: list[RoleResponse]
    repo_path: str | None
    base_branch: str | None
    workspace: str | None
    human_workspace: str | None
    artifacts_dir: str | None
    compose_project: str | None
    telegram_token: str | None
    telegram_chat_id: str | None
    max_rework: int
    enabled: bool
    notifications_enabled: bool
    created_at: datetime
    updated_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def fields(self) -> list[str]:
        """Набор и порядок полей страницы правки — из вида, а не из самой строки."""
        return list(FIELD_KEYS_BY_CODE.get(self.kind.code, ()))


class DepartmentCreate(BaseModel):
    """Тело `POST /api/projects/{project_id}/departments`: ровно один вид отдела.

    `project_id` в теле нет: проект задаётся путём, а не полем формы. Имени, времени и
    ролей в теле тоже нет: имя — это `title` вида, а время и роли заполняются на странице
    правки. Отдел без ролей и без расписания — нормальное состояние нового отдела.
    """

    kind_id: int


class DepartmentUpdate(BaseModel):
    """Тело `PATCH /api/departments/{id}`: любое непустое подмножество полей страницы.

    Поля, которого нет в теле, не меняется. Строковое поле со значением `null` или `""`
    означает «не заполнено» и стирает значение в базе. Булевы поля — `enabled` и
    `notifications_enabled`: `null` для них значит «не менять», потому что значения «пусто»
    у флажка нет. `role_ids` заменяет набор ролей целиком, пустой список роли стирает.
    `windows` заменяет набор окон целиком и проверяется ручкой: от одного до шести окон,
    без пересечений; `[]` и `null` — отказ «Укажите хотя бы одно окно времени работы».

    Пустое тело — отказ `422`, его проверяет ручка, а не схема.

    `name` в схеме нет: имя отдела равно названию вида и правкой не меняется.
    `project_id` присутствует ровно для того, чтобы присланное значение **не** роняло
    запрос: переноса отдела между проектами нет, поле игнорируется и строку не двигает.
    """

    repo_path: str | None = None
    base_branch: str | None = None
    workspace: str | None = None
    human_workspace: str | None = None
    artifacts_dir: str | None = None
    compose_project: str | None = None
    telegram_token: str | None = None
    telegram_chat_id: str | None = None
    max_rework: int | None = None
    enabled: bool | None = None
    notifications_enabled: bool | None = None
    role_ids: list[int] | None = None
    windows: list[WindowInput] | None = None
    project_id: int | None = None
