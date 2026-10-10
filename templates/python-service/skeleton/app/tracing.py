"""Tracing with OpenTelemetry: one trace per request, sent to the platform's trace store.

Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. The platform sets it for every golden-path
service (idp-gitops components/golden-path), together with OTEL_SERVICE_NAME; on a laptop
neither exists, and the service runs exactly the same without sending anything.

Each request becomes a trace. Its id is added to every log line written while the request is
handled (app/logs.py), so from a log line in Grafana you can jump to the trace and see where
the time went. To time a step of your own:

    from opentelemetry import trace
    tracer = trace.get_tracer(__name__)

    with tracer.start_as_current_span("load-order"):
        ...
"""

import os

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def tracing_enabled() -> bool:
    return bool(os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"))


def configure_tracing(app: FastAPI, service_name: str) -> bool:
    """Send a trace for every request, if an endpoint is configured. Returns whether it is."""
    if not tracing_enabled():
        return False
    provider = TracerProvider(
        resource=Resource.create(
            {"service.name": os.environ.get("OTEL_SERVICE_NAME", service_name)}
        )
    )
    # Batched and sent in the background: a slow or absent trace store never slows a request.
    # The exporter reads the endpoint from the environment and posts to <endpoint>/v1/traces.
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    # Probes and scrapes arrive every few seconds; tracing them would bury real requests.
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health/.*,metrics")
    return True


def current_trace_id() -> str | None:
    """The id of the trace this code is running in, or None outside a traced request."""
    context = trace.get_current_span().get_span_context()
    return format(context.trace_id, "032x") if context.is_valid else None
