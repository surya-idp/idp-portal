"""JSON logs on stdout, one object per line, with the request id on every line.

Kubernetes collects stdout; a log system (Step 34) can then filter on fields instead of
parsing text. The request id comes from the X-Request-ID header when the caller sent one,
so one request can be followed across services.
"""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

# Attributes every LogRecord has; anything else was passed with `extra=` and is logged too.
_STANDARD = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if (rid := request_id.get()) is not None:
            entry["request_id"] = rid
        entry.update({k: v for k, v in record.__dict__.items() if k not in _STANDARD})
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=level.upper(), handlers=[handler], force=True)
    # uvicorn installs its own text handlers before it imports the app. Hand its messages
    # (startup, shutdown, errors) to the JSON handler above instead.
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    # The access log is replaced by the request line that app.main logs.
    logging.getLogger("uvicorn.access").disabled = True
