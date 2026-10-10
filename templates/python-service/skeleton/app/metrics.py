"""Request metrics for Prometheus, served at /metrics.

Two metrics describe every HTTP service the same way, so one dashboard and one set of alerts
work for all of them (idp-gitops platform/monitoring):

    http_requests_total{method, path, status}            how many, and how they ended
    http_request_duration_seconds{method, path}          how long they took (a histogram)

Prometheus adds the labels `service`, `namespace` and `pod` when it scrapes, so they are not
set here. `path` is the route TEMPLATE (/orders/{order_id}), never the real URL: one label
value per order id would create a new time series for every order.
"""

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

REQUESTS = Counter(
    "http_requests_total",
    "HTTP requests handled, by method, route and response status.",
    ["method", "path", "status"],
)
DURATION = Histogram(
    "http_request_duration_seconds",
    "Time spent handling an HTTP request, by method and route.",
    ["method", "path"],
    # Upper bounds in seconds. The alert threshold (0.5 s) is one of them, so the 95th
    # percentile around that value is exact, not interpolated across a wide bucket.
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)


def observe(method: str, path: str, status: int, seconds: float) -> None:
    REQUESTS.labels(method=method, path=path, status=str(status)).inc()
    DURATION.labels(method=method, path=path).observe(seconds)


def render() -> tuple[bytes, str]:
    """The current values in Prometheus' text format, and its content type."""
    return generate_latest(), CONTENT_TYPE_LATEST
