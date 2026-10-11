import asyncio
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from app import flags
from app.config import get_settings


def enabled(flag: str, user_id: str = "anonymous", *, default: bool = False) -> bool:
    """The helper is async (routes await it); the tests call it from plain functions."""
    return asyncio.run(flags.is_enabled(flag, user_id, default=default))


class FlagService:
    """A local stand-in for the platform's flag service."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 200
        self.answer: Any = {"enabled": True, "reason": "boolean_flag"}
        self.url = ""


@pytest.fixture
def flag_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[FlagService]:
    service = FlagService()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            service.requests.append(
                {"path": self.path, "body": body, "auth": self.headers.get("Authorization")}
            )
            answer = service.answer
            payload = answer if isinstance(answer, str) else json.dumps(answer)
            self.send_response(service.status)
            self.end_headers()
            self.wfile.write(payload.encode())

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    service.url = f"http://127.0.0.1:{server.server_port}"
    token = tmp_path / "token"
    token.write_text("pod-token\n")
    monkeypatch.setenv("FLAG_API_URL", service.url)
    monkeypatch.setenv("FLAG_API_TOKEN_FILE", str(token))
    get_settings.cache_clear()
    flags.clear_cache()
    yield service
    server.shutdown()
    get_settings.cache_clear()
    flags.clear_cache()


def test_an_enabled_flag_is_true_and_the_pod_token_is_sent(flag_service: FlagService) -> None:
    assert enabled("new-checkout", "user-1") is True
    assert flag_service.requests == [
        {
            "path": "/evaluate",
            "body": {
                "flag_name": f"{get_settings().service_name}.new-checkout",
                "user_id": "user-1",
                "environment": "dev",
            },
            "auth": "Bearer pod-token",
        }
    ]


def test_a_disabled_flag_is_false_even_if_the_default_is_true(flag_service: FlagService) -> None:
    flag_service.answer = {"enabled": False, "reason": "boolean_flag"}
    assert enabled("new-checkout", default=True) is False


def test_a_flag_that_does_not_exist_gives_the_default(flag_service: FlagService) -> None:
    flag_service.answer = {"enabled": False, "reason": "flag_not_found"}
    assert enabled("typo", default=True) is True
    assert enabled("other-typo") is False


@pytest.mark.parametrize(
    ("status", "answer"),
    [(401, {"detail": "no"}), (500, "boom"), (200, "not json"), (200, ["a list"])],
)
def test_any_bad_answer_gives_the_default(
    flag_service: FlagService, status: int, answer: Any
) -> None:
    flag_service.status, flag_service.answer = status, answer
    assert enabled("new-checkout", default=True) is True
    assert enabled("new-checkout", default=False) is False


def test_an_unreachable_flag_service_gives_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLAG_API_URL", "http://127.0.0.1:1")  # nothing listens here
    get_settings.cache_clear()
    flags.clear_cache()
    try:
        assert enabled("new-checkout", default=True) is True
    finally:
        get_settings.cache_clear()
        flags.clear_cache()


def test_a_missing_token_file_gives_the_default(
    flag_service: FlagService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FLAG_API_TOKEN_FILE", "/does/not/exist")
    get_settings.cache_clear()
    assert enabled("new-checkout", default=False) is False
    assert flag_service.requests == []


def test_a_default_is_never_remembered(flag_service: FlagService) -> None:
    # Found on the cluster (2026-10-11): the first call's default was cached and returned to
    # a later call that passed a different default.
    flag_service.answer = {"enabled": False, "reason": "flag_not_found"}
    assert enabled("missing") is False
    assert enabled("missing", default=True) is True
    assert enabled("missing") is False
    # ...and once the flag exists, its real answer is used at once.
    flag_service.answer = {"enabled": True, "reason": "boolean_flag"}
    assert enabled("missing") is True


def test_the_answer_is_reused_per_flag_and_user(flag_service: FlagService) -> None:
    for _ in range(3):
        assert enabled("new-checkout", "user-1") is True
    assert len(flag_service.requests) == 1
    enabled("new-checkout", "user-2")
    enabled("other-flag", "user-1")
    assert len(flag_service.requests) == 3


def test_outside_the_cluster_every_flag_is_its_default() -> None:
    get_settings.cache_clear()
    flags.clear_cache()
    assert get_settings().flag_api_url == ""
    assert enabled("anything") is False
    assert enabled("anything", default=True) is True
