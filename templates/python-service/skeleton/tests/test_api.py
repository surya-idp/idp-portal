import json
import logging
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app import health
from app.config import get_settings
from app.logs import JsonFormatter, request_id
from app.main import create_app

PREFIX = f"/{get_settings().service_name}"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as test_client:
        yield test_client
    health.readiness_checks.clear()


def test_index_is_served_under_the_service_prefix(client: TestClient) -> None:
    response = client.get(f"{PREFIX}/")
    assert response.status_code == 200
    assert response.json()["service"] == get_settings().service_name


def test_openapi_is_reachable_through_the_prefix(client: TestClient) -> None:
    assert client.get(f"{PREFIX}/openapi.json").status_code == 200


def test_live_does_not_depend_on_anything(client: TestClient) -> None:
    async def broken() -> None:
        raise RuntimeError("database down")

    health.readiness_checks["database"] = broken
    assert client.get("/health/live").status_code == 200


def test_ready_is_ok_without_dependencies(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {}}


def test_ready_returns_503_when_a_dependency_fails(client: TestClient) -> None:
    async def ok() -> None:
        return None

    async def broken() -> None:
        raise RuntimeError("database down")

    health.readiness_checks.update({"cache": ok, "database": broken})
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"] == {"cache": "ok", "database": "failed: database down"}


def test_request_id_is_generated_and_echoed(client: TestClient) -> None:
    assert len(client.get(f"{PREFIX}/").headers["x-request-id"]) == 32
    echoed = client.get(f"{PREFIX}/", headers={"X-Request-ID": "abc-123"})
    assert echoed.headers["x-request-id"] == "abc-123"


def test_requests_are_logged_as_json_with_the_request_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app.main"):
        client.get(f"{PREFIX}/", headers={"X-Request-ID": "abc-123"})
        client.get("/health/live")

    records = [r for r in caplog.records if r.name == "app.main"]
    assert len(records) == 1, "health probes must not be logged"
    entry = json.loads(JsonFormatter().format(records[0]))
    assert entry["message"] == "request"
    assert entry["path"] == f"{PREFIX}/"
    assert entry["status"] == 200
    assert entry["level"] == "INFO"


def test_log_lines_carry_the_request_id_and_extra_fields() -> None:
    record = logging.makeLogRecord({"name": "app", "levelname": "INFO", "msg": "paid", "order": 7})
    token = request_id.set("abc-123")
    try:
        entry = json.loads(JsonFormatter().format(record))
    finally:
        request_id.reset(token)
    assert entry["request_id"] == "abc-123"
    assert entry["order"] == 7
    assert entry["message"] == "paid"
