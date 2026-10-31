"""Mode-aware structured logging for the Carto Python services.

WHY THIS EXISTS
===============
Every Python service in this harness must emit ONE JSON log shape — app logs
AND uvicorn access/error logs — in all three instrumentation modes. Configuring
logging twice (a Dockerfile-level `configure()` plus a per-app
`logging.basicConfig(force=True)`) is how you end up with app logs in JSON and
uvicorn logs in plaintext: two formats, one pipeline, half the records
uncorrelated. This module is the single place logging is configured.

WHAT IT EMITS
=============
Every record carries BOTH spellings of the active trace ids:

  trace_id / span_id        W3C hex (32 / 16 chars) — what OTel tooling expects
  dd.trace_id / dd.span_id  decimal — what Datadog's log pipeline correlates on

Datadog correlates logs to traces on `dd.trace_id`. The universally-safe form
is the decimal of the low-order 64 bits of the trace id, so that is what we
emit; the full 32-char hex is kept alongside under `trace_id` for OTel-native
tooling and for the collector's trace_parser operator in MODE=otel.

Ids are resolved from the ACTIVE SPAN at format time rather than read off
LogRecord attributes injected by DD_LOGS_INJECTION. That is the only
formulation that behaves identically in all three modes, and it drops the
dependence on ddtrace's log-injection filter ordering.

THE RING BUFFER
===============
configure() also installs a second handler that keeps the last RING_SIZE
formatted records in memory, exposed at GET /debug/logs. That is what powers
the app's own Telemetry tab: it shows the exact JSON payload Datadog receives,
trace ids included, without needing access to the Datadog UI.

The buffer is a read-only MIRROR of the shipping path, not the path itself.
Logs reach Datadog by being written to stdout and picked up by the Agent's
container log collection (MODE=agent/dual) or the collector's filelog receiver
plus the OTLP logs exporter (MODE=otel). Removing the buffer would not change
what Datadog receives.
"""

from __future__ import annotations

import collections
import json
import logging
import os
import sys
import threading

MODE = os.getenv("INSTRUMENTATION_MODE", "agent")


def _ids() -> tuple[str | None, str | None]:
    """Return (trace_id_hex32, span_id_hex16) for the active span, or (None, None).

    MODE=agent  -> ddtrace is the only tracer; ask it directly.
    MODE=dual   -> ddtrace IS the OTel API implementation (DD_TRACE_OTEL_ENABLED),
                   so the OTel API returns Datadog-native ids. Same numbers,
                   vendor-neutral call.
    MODE=otel   -> the OTel SDK is the only tracer.
    """
    try:
        if MODE == "agent":
            from ddtrace import tracer

            span = tracer.current_span()
            if span is None:
                return None, None
            return format(span.trace_id, "032x"), format(span.span_id, "016x")

        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        if not ctx.is_valid:
            return None, None
        return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001 — logging must never raise
        return None, None


class ObsJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "dd.service": os.getenv("DD_SERVICE") or os.getenv("OTEL_SERVICE_NAME", "unknown"),
            "dd.env": os.getenv("DD_ENV", "dev"),
            "dd.version": os.getenv("DD_VERSION", "0.1.0"),
            # Which instrumentation stack produced this log. Emitted in the
            # payload (not just as a container tag) so `@instrumentation:<mode>`
            # is the ONE search key that works across all three modes for both
            # logs and spans: in MODE=otel there is no Datadog Agent, so the
            # com.datadoghq.tags.* label -> tag mapping does not exist.
            "instrumentation": MODE,
        }

        tid, sid = _ids()
        if tid and sid:
            out["trace_id"] = tid                           # 32-hex, OTel-native
            out["span_id"] = sid                            # 16-hex
            out["dd.trace_id"] = str(int(tid[16:], 16))     # low-64 decimal
            out["dd.span_id"] = str(int(sid, 16))

        # Structured extras the caller attached via `extra={"ctx_foo": ...}`.
        for k, v in record.__dict__.items():
            if k.startswith("ctx_"):
                out[k[4:]] = v

        if record.exc_info:
            out["error.stack"] = self.formatException(record.exc_info)

        return json.dumps(out)


# ---------------------------------------------------------------------------
# In-memory ring buffer — read-only mirror of the shipping path, for
# GET /debug/logs and the app's Telemetry tab. See the module docstring.
# ---------------------------------------------------------------------------
RING_SIZE = int(os.getenv("CARTO_LOG_RING_SIZE", "200"))

_ring: "collections.deque[dict]" = collections.deque(maxlen=RING_SIZE)
_ring_lock = threading.Lock()


class _RingHandler(logging.Handler):
    """Captures each record as the parsed dict the formatter produced.

    Formats via ObsJsonFormatter and json.loads back, rather than rebuilding
    the payload, so the buffer cannot drift from what is actually emitted to
    stdout — one formatter, one shape, by construction.
    """

    def __init__(self, formatter: logging.Formatter) -> None:
        super().__init__()
        self._fmt = formatter

    def emit(self, record: logging.LogRecord) -> None:
        try:
            payload = json.loads(self._fmt.format(record))
        except Exception:  # noqa: BLE001 — never let capture break logging
            return
        with _ring_lock:
            _ring.append(payload)


def recent(limit: int = 50) -> dict:
    """Payload for GET /debug/logs. Newest first."""
    with _ring_lock:
        records = list(_ring)[-max(1, min(limit, RING_SIZE)):]
    records.reverse()
    return {
        "service": os.getenv("DD_SERVICE") or os.getenv("OTEL_SERVICE_NAME", "unknown"),
        "instrumentation": MODE,
        "signal": "logs",
        "transport": _log_transport(),
        "ring_size": RING_SIZE,
        "count": len(records),
        "logs": records,
    }


def _log_transport() -> dict:
    """How this process's logs actually reach Datadog, per mode."""
    if MODE == "otel":
        return {
            "emit": "stdout (JSON)",
            "collect": "otel-collector filelog receiver + OTLP logs exporter",
            "then": "collector datadog exporter -> Datadog",
            "correlation": "trace_parser operator promotes trace_id/span_id; "
                           "dd.trace_id also emitted as a plain attribute",
        }
    return {
        "emit": "stdout (JSON)",
        "collect": "Datadog Agent container log collection "
                   "(DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL)",
        "then": "Datadog Agent -> Datadog",
        "correlation": "dd.trace_id / dd.span_id (decimal) on every record",
    }


def configure() -> None:
    """Install the JSON formatter on root and on uvicorn's own loggers.

    Idempotent. Called from boot.py before uvicorn starts, so access logs and
    error logs flow through the same formatter from request 1.
    """
    fmt = ObsJsonFormatter()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(fmt)

    # Second handler: the read-only ring buffer behind GET /debug/logs. It
    # shares the SAME formatter instance as stdout, so the two can never
    # disagree about what a record looks like.
    ring_handler = _RingHandler(fmt)

    root = logging.getLogger()
    root.handlers[:] = [handler, ring_handler]
    root.setLevel(logging.INFO)

    # uvicorn installs its own handlers; override so access + error logs share
    # the shape. propagate=False prevents double emission through root.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = [handler, ring_handler]
        lg.propagate = False
