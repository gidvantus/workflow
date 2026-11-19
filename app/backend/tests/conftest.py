"""Общие фикстуры тестов API: база в памяти, сид справочников и клиент.

Живая PostgreSQL тестам не нужна: `get_db` подменяется на SQLite в памяти, таблицы
создаются из метаданных моделей — вместе с частичным уникальным индексом
`uq_departments_project_name_alive`, поэтому гонка по имени проверяется на настоящем
индексе, а не на заглушке. Миграции здесь не выполняются, поэтому сид справочников делает
фикстура — теми же каталогами `DEFAULT_ROLES` и `DEFAULT_DEPARTMENT_KINDS`, что и ревизии
`0003_departments` и `0006_department_kinds`: без сида таблицы `roles` и
`department_kinds` пусты, и создание отдела падает на «нет такого вида».

Фикстуры общие для всех модулей, поэтому копий движка в них нет. Исключение —
`test_health.py`: у него свой клиент без базы, ручке здоровья база не нужна.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.db import Base, get_db
from app.models.department_kind import DEFAULT_DEPARTMENT_KINDS, DepartmentKind
from app.models.role import DEFAULT_ROLES, Role


def seed_references(factory: sessionmaker[Session]) -> None:
    """Наполнить справочники так же, как это делают сиды миграций."""
    with factory() as session:
        session.add_all([Role(code=code, title=title) for code, title in DEFAULT_ROLES])
        session.add_all(
            [DepartmentKind(code=code, title=title) for code, title in DEFAULT_DEPARTMENT_KINDS]
        )
        session.commit()


@pytest.fixture(name="session_factory")
def session_factory_fixture() -> Iterator[sessionmaker[Session]]:
    """Движок на одну in-memory базу: все сессии видят одно и то же соединение."""
    engine: Engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    seed_references(factory)
    try:
        yield factory
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture(name="client")
def client_fixture(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    """Клиент поверх подменённой зависимости: приложение не ходит в настоящую базу."""

    def override_get_db() -> Iterator[Session]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    main.app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(main.app) as test_client:
            yield test_client
    finally:
        main.app.dependency_overrides.clear()
