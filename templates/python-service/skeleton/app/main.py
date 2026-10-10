"""${{ values.name }} - ${{ values.description }}

Created from the idp "python-service" golden path.

Routing: the shared ALB forwards /${{ values.name }}/... to this service unchanged (no path
stripping), so the API lives under that prefix. Health endpoints live at the root, because
the kubelet and the ALB health check call the pod directly.
"""

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, FastAPI, Request, Response

from app import health
from app.config import get_settings
from app.logs import configure_logging, request_id

logger = logging.getLogger(__name__)
api = APIRouter()


@api.get("/")
async def index() -> dict[str, str]:
    settings = get_settings()
    return {
        "service": settings.service_name,
        "message": "Hello from the idp golden path",
        "version": settings.git_sha,
    }


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    prefix = f"/{settings.service_name}"

    app = FastAPI(
        title=settings.service_name,
        version=settings.git_sha,
        # Under the prefix, so they are reachable through the ALB.
        docs_url=f"{prefix}/docs",
        redoc_url=None,
        openapi_url=f"{prefix}/openapi.json",
    )

    @app.middleware("http")
    async def log_requests(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        token = request_id.set(rid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = rid
            # Probes arrive every few seconds; logging them would bury real requests.
            if not request.url.path.startswith("/health/"):
                logger.info(
                    "request",
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    },
                )
            return response
        finally:
            request_id.reset(token)

    app.include_router(health.router)
    app.include_router(api, prefix=prefix)
    return app


app = create_app()
