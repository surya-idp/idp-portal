import json
import logging
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app import health
from app.config import get_settings
from app.logs import JsonFormatter, request_id
from app.main import create_app
from app.tracing import configure_tracing, current_trace_id

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


def test_metrics_count_requests_by_route_template(client: TestClient) -> None:
    client.get(f"{PREFIX}/")
    client.get(f"{PREFIX}/")
    client.get("/no-such-page")
    body = client.get("/metrics").text
    # the route template of the index, as registered: prefix + "/"
    assert f'http_requests_total{{method="GET",path="{PREFIX}/",status="200"}}' in body
    # an unknown URL is counted under one fixed label, not under the URL itself
    assert 'path="unmatched",status="404"' in body
    assert "/no-such-page" not in body
    assert "http_request_duration_seconds_bucket" in body


def test_path_parameters_do_not_become_label_values() -> None:
    app = create_app()

    @app.get("/orders/{order_id}/lines/{line}")
    async def order_line(order_id: int, line: int) -> dict[str, int]:
        return {"order": order_id, "line": line}

    with TestClient(app) as test_client:
        test_client.get("/orders/17/lines/3")
        test_client.get("/orders/99/lines/1")
        body = test_client.get("/metrics").text
    assert 'path="/orders/{order_id}/lines/{line}",status="200"} 2.0' in body
    assert "/orders/17" not in body


def test_probes_and_scrapes_are_not_counted(client: TestClient) -> None:
    client.get("/health/live")
    client.get("/health/ready")
    client.get("/metrics")
    body = client.get("/metrics").text
    assert 'path="/health/live"' not in body
    assert 'path="/metrics"' not in body


def test_metrics_endpoint_is_not_under_the_public_prefix(client: TestClient) -> None:
    # The load balancer only forwards /<name>/...; /metrics must stay unreachable through it.
    assert client.get(f"{PREFIX}/metrics").status_code == 404


def test_tracing_is_off_without_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert configure_tracing(create_app(), "x") is False
    assert current_trace_id() is None


def test_log_lines_inside_a_span_carry_its_trace_id() -> None:
    from opentelemetry.sdk.trace import TracerProvider

    tracer = TracerProvider().get_tracer("test")
    record = logging.makeLogRecord({"name": "app", "levelname": "INFO", "msg": "in span"})
    with tracer.start_as_current_span("unit-test") as span:
        entry = json.loads(JsonFormatter().format(record))
        expected = format(span.get_span_context().trace_id, "032x")
    assert entry["trace_id"] == expected
    assert len(expected) == 32
    assert "trace_id" not in json.loads(JsonFormatter().format(record))
