"""Mode-aware span error recording.

The services deliberately attach error.type/message/stack to the active span
so Error Tracking shows a real message and stack instead of "missing error
message and stack trace" — ddtrace flags 5xx spans as errors but does not
record a stack for handled HTTPExceptions.

Calling `ddtrace.tracer.current_span()` directly would silently no-op in
MODE=otel, where there is no ddtrace span, and every failing trace would lose
its error detail — a regression you only notice when you click the red span on
stage. This shim keeps the behaviour in all three modes.
"""

from __future__ import annotations

import os
import traceback

MODE = os.getenv("INSTRUMENTATION_MODE", "agent")


def set_tags(tags: dict) -> None:
    """Attach string tags to the REQUEST'S ROOT SPAN, in whichever mode is running.

    Used to put business dimensions (which buyer, which conversation turn) on
    spans a tracer created automatically. Datadog surfaces span tags as APM
    facets, so these become one-click filters instead of something you have to
    reconstruct from logs.

    WHY THE ROOT SPAN AND NOT THE ACTIVE ONE
    ========================================
    `tracer.current_span()` returns the innermost active span, which inside a
    FastAPI handler is frequently not the one you want. A sync `def` handler
    runs in anyio's threadpool, and by the time business context is known the
    active span can be an internal child (serialisation, an outbound call)
    that is either not retained or not the span the resource is keyed on.
    Tags set there silently never appear on the trace.

    `current_root_span()` is the local root — the `fastapi.request` span that
    carries the resource name. Request-scoped business context belongs there,
    and that is the span Datadog facets on.
    """
    if not tags:
        return
    try:
        if MODE == "agent":
            from ddtrace import tracer

            # Prefer the local root; fall back to the active span if there is
            # no root (a background thread with no request in flight).
            span = None
            getter = getattr(tracer, "current_root_span", None)
            if getter is not None:
                span = getter()
            if span is None:
                span = tracer.current_span()
            if span is None:
                return
            for k, v in tags.items():
                span.set_tag(k, v)
            return

        from opentelemetry import trace

        span = trace.get_current_span()
        if not span.get_span_context().is_valid:
            return
        for k, v in tags.items():
            span.set_attribute(k, v)
    except Exception:  # noqa: BLE001 — instrumentation must never break a request
        return


def record_error(error_type: str, message: str) -> None:
    """Mark the active span errored and attach type/message/stack. No-ops if
    there is no active span."""
    stack = traceback.format_exc()
    try:
        if MODE == "agent":
            from ddtrace import tracer

            span = tracer.current_span()
            if span is None:
                return
            span.error = 1
            span.set_tag("error.type", error_type)
            span.set_tag("error.message", message)
            span.set_tag("error.stack", stack)
            return

        # dual + otel both go through the OTel API. In dual, ddtrace implements
        # it, so these land as Datadog span tags exactly as above.
        from opentelemetry import trace
        from opentelemetry.trace import Status, StatusCode

        span = trace.get_current_span()
        if not span.get_span_context().is_valid:
            return
        span.set_status(Status(StatusCode.ERROR, message))
        span.set_attribute("error.type", error_type)
        span.set_attribute("error.message", message)
        span.set_attribute("error.stack", stack)
    except Exception:  # noqa: BLE001 — instrumentation must never break the request
        return
