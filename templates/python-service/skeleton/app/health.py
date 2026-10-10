"""Health endpoints for Kubernetes, served at the root (probes call the pod directly).

/health/live   "the process works". Failing it restarts the container, so it must NOT check
               dependencies: a database outage would restart every pod and fix nothing.
/health/ready  "send me traffic". Failing it takes the pod out of the Service and the ALB
               without restarting it. Dependency checks belong here.
"""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Response, status

router = APIRouter(prefix="/health", tags=["health"])

# name -> async check that raises when the dependency is not usable. Register a check when
# the service gains a dependency, for example:  readiness_checks["database"] = ping_database
readiness_checks: dict[str, Callable[[], Awaitable[None]]] = {}


@router.get("/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready(response: Response) -> dict[str, object]:
    results: dict[str, str] = {}
    for name, check in readiness_checks.items():
        try:
            await check()
            results[name] = "ok"
        except Exception as error:  # noqa: BLE001 - any failure means "not ready"
            results[name] = f"failed: {error}"
    healthy = all(result == "ok" for result in results.values())
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if healthy else "unavailable", "checks": results}
