"""Dual mode: OTel API + contrib instrumentation on top of the ddtrace runtime.

ddtrace registers itself as the global OTel TracerProvider when
DD_TRACE_OTEL_ENABLED=true, so contrib instrumentors that call
opentelemetry.trace.get_tracer(...) emit spans into the Datadog tracer.

Deliberately absent: any SDK TracerProvider, BatchSpanProcessor or OTLP
exporter. dd-trace owns transport in this mode — that is what keeps AAP,
IAST, API Security, Profiler and LLM Observability working while the
instrumentation surface stays vendor-neutral OTel code.

The matching ddtrace integrations are switched off via DD_PATCH_MODULES in
compose.dual.yaml. That is mandatory, not tuning: leaving both on produces
two spans per request and per query (doubled hit counts, a nested duplicate
in the flamegraph, wrong latency).

Each instrumentor is applied independently and skipped if the library it
targets is not installed. The OTel contrib instrumentors hard-import their
target at module scope (e.g. `import httpx`), so a single unguarded import
takes down app startup for a library the service never used.
"""

from __future__ import annotations

import logging

log = logging.getLogger("otel_bridge")

# (module path, class name, kwargs) — applied in order, each independently guarded.
_INSTRUMENTORS = [
    # exclude_spans drops the ASGI "http send" / "http receive" event
    # sub-spans. They are pure noise in a demo flamegraph: they add 3 internal
    # spans per request (2 send, 1 receive) around the one span that matters.
    ("opentelemetry.instrumentation.fastapi", "FastAPIInstrumentor",
     {"exclude_spans": ["send", "receive"]}),
    ("opentelemetry.instrumentation.requests", "RequestsInstrumentor", {}),
    ("opentelemetry.instrumentation.httpx", "HTTPXClientInstrumentor", {}),
    ("opentelemetry.instrumentation.psycopg2", "Psycopg2Instrumentor", {}),
    # set_logging_format=False is load-bearing: the default True calls
    # logging.basicConfig and would stomp obs_logging's JSON handler back to
    # plaintext.
    ("opentelemetry.instrumentation.logging", "LoggingInstrumentor",
     {"set_logging_format": False}),
    # DELIBERATELY ABSENT: AnthropicInstrumentor.
    #
    # This bridge only ever runs in MODE=dual, and in dual mode ddtrace's own
    # anthropic integration stays ON because it is what feeds Datadog LLM
    # Observability (compose.dual.yaml does not disable it). Applying the OTel
    # Anthropic instrumentor here as well would double-instrument every
    # Claude call — two spans per LLM request, doubled token/cost rollups.
    #
    # In MODE=otel the OTel Anthropic instrumentation IS used, but it is
    # auto-loaded by `opentelemetry-instrument` from its entry point, not from
    # this file.
]


def install() -> None:
    applied, skipped = [], []
    for mod_path, cls_name, kwargs in _INSTRUMENTORS:
        try:
            mod = __import__(mod_path, fromlist=[cls_name])
            getattr(mod, cls_name)().instrument(**kwargs)
            applied.append(cls_name)
        except ImportError:
            # Target library (or the instrumentor itself) not installed in
            # this service. Expected and fine — services differ.
            skipped.append(cls_name)
        except Exception as exc:  # noqa: BLE001 — never block startup
            log.warning("otel_bridge: %s failed to instrument: %s", cls_name, exc)
            skipped.append(cls_name)

    log.info(
        "otel_bridge ready",
        extra={"ctx_applied": ",".join(applied), "ctx_skipped": ",".join(skipped)},
    )
