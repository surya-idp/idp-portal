"""${{ values.name }}: a service on the idp platform.

Created from the idp "python-service" golden path.

Routing: the shared ALB forwards /${{ values.name }}/... to this service unchanged (no path
stripping), so the API lives under that prefix. Health endpoints and /metrics live at the
root, because the kubelet, the ALB health check and Prometheus call the pod directly (and
because /metrics must not be reachable from the internet).
"""

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, FastAPI, Request, Response

from app import health, metrics
from app.config import get_settings
from app.logs import configure_logging, request_id
from app.tracing import configure_tracing

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


def route_template(request: Request) -> str:
    """The route as written in the code: /orders/{order_id}, never /orders/17.

    Used as a metric label, where every distinct value creates a new time series. A URL that
    matched no route is always "unmatched", or anyone could create series by requesting
    random paths.
    """
    if request.scope.get("route") is None:
        return "unmatched"
    path = request.url.path
    for name, value in request.path_params.items():
        path = path.replace(f"/{value}", f"/{{{name}}}", 1)
    return path


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
            seconds = time.perf_counter() - started
            # Probes and scrapes arrive every few seconds; counting or logging them would
            # bury real requests.
            if not request.url.path.startswith(("/health/", "/metrics")):
                metrics.observe(
                    request.method, route_template(request), response.status_code, seconds
                )
                logger.info(
                    "request",
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "status": response.status_code,
                        "duration_ms": round(seconds * 1000, 1),
                    },
                )
            return response
        finally:
            request_id.reset(token)

    @app.get("/metrics", include_in_schema=False)
    async def prometheus_metrics() -> Response:
        body, content_type = metrics.render()
        return Response(content=body, media_type=content_type)

    app.include_router(health.router)
    app.include_router(api, prefix=prefix)
    if configure_tracing(app, settings.service_name):
        logger.info("tracing enabled")
    return app


app = create_app()
