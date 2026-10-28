"""Ручка `/api/health`: обе формы ответа без живой PostgreSQL."""

from collections.abc import Iterator
from typing import Never

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import db, main


@pytest.fixture(name="client")
def client_fixture() -> Iterator[TestClient]:
    """Клиент без базы: `check_db` подменяется в каждом тесте."""
    with TestClient(main.app) as test_client:
        yield test_client


def test_health_ok(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """База отвечает — 200 и ровно те поля, что обещаны контрактом."""
    monkeypatch.setattr(main, "check_db", lambda: True)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "db": "ok", "version": "0.1.0"}


def test_health_degraded(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """База недоступна — 503 с текстом, который фронт показывает дословно."""
    monkeypatch.setattr(main, "check_db", lambda: False)

    response = client.get("/api/health")

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "db": "fail",
        "version": "0.1.0",
        "message": "База данных недоступна",
    }


def test_check_db_swallows_connection_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Отказ подключения — это `False`, а не исключение: ручка не должна падать в 500."""
    original_error = OperationalError("SELECT 1", {}, Exception("connection refused"))

    def failing_connect(*args: object, **kwargs: object) -> Never:
        raise original_error

    monkeypatch.setattr(db.engine, "connect", failing_connect)

    assert db.check_db() is False
