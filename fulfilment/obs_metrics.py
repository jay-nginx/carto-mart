"""Mode-aware OpenTelemetry metrics for the Carto Python services.

WHY THIS EXISTS
===============
Traces and logs were already covered (obs_span.py, obs_logging.py). Metrics
were not: the services emitted no application metrics at all, so everything on
a Datadog dashboard had to be derived from trace metrics or log counts. This
module adds the third signal, through the VENDOR-NEUTRAL OpenTelemetry Metrics
API, so the same app code produces metrics in all three instrumentation modes.

THE MODE PROBLEM
================
ddtrace implements the OpenTelemetry *trace* API when DD_TRACE_OTEL_ENABLED=true.
It does NOT implement the OpenTelemetry *metrics* API — there is no ddtrace
MeterProvider. So in MODE=agent and MODE=dual, `metrics.get_meter(...)` resolves
to the no-op default provider and every counter silently discards its value.
That is the trap this module exists to close:

  MODE=agent  -> no MeterProvider exists. We register an SDK MeterProvider with
                 an OTLP/HTTP exporter aimed at the Datadog Agent's own OTLP
                 receiver (enabled in compose.yaml). App code stays OTel.
  MODE=dual   -> identical to agent. ddtrace owns traces; the OTel SDK owns
                 metrics. They coexist because they are different signals with
                 different providers — no global-provider race.
  MODE=otel   -> `opentelemetry-instrument` has ALREADY configured a
                 MeterProvider from OTEL_METRICS_EXPORTER=otlp. Registering a
                 second one here would either lose the race or double-export,
                 so install() returns early and does nothing.

THE LOCAL SNAPSHOT
==================
Every value recorded through this module is ALSO mirrored into an in-process
snapshot exposed at GET /debug/metrics. That is what powers the app's own
Telemetry tab, which shows an SE exactly what is being sent to Datadog without
having to open Datadog. The snapshot is NOT the transport — it is a read-only
mirror. Deleting it would not change what Datadog receives.

Histograms keep a bounded sample window (the last MAX_SAMPLES values) so the
snapshot can report p50/p95/p99. The real percentiles in Datadog come from the
OTLP histogram buckets, not from this window; the window exists so the in-app
view has something meaningful to show between export intervals.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Dict, List, Optional

from opentelemetry import metrics as otel_metrics

MODE = os.getenv("INSTRUMENTATION_MODE", "agent")
SERVICE = os.getenv("DD_SERVICE") or os.getenv("OTEL_SERVICE_NAME", "unknown")

# Bounded per-histogram sample window used only for the /debug/metrics view.
MAX_SAMPLES = 500

_lock = threading.Lock()

# name -> {"type", "unit", "description", "points": {tagkey: {...}}}
_snapshot: Dict[str, dict] = {}

# Lazily created OTel instruments, keyed by name. Created on first use rather
# than at import time so that install() has already registered the provider.
_instruments: Dict[str, object] = {}
_meter = None


# ---------------------------------------------------------------------------
# Exporter noise suppression
# ---------------------------------------------------------------------------
# When the metrics endpoint is unreachable — no Agent running, a mode/compose
# mismatch, a typo'd endpoint — the OTLP exporter retries with backoff and logs
# a WARNING per attempt. Measured on this harness that was 45% of the log
# stream, which buries the application's own logs in the Log Explorer and in
# the app's Telemetry tab. A telemetry pipeline that cannot ship must not also
# destroy the signal it was meant to carry.
#
# So: drop the per-attempt retry WARNINGs, and rate-limit the real failures to
# one record per SUPPRESS_WINDOW_S per logger. The failure stays visible (you
# still learn the endpoint is down, with the endpoint in the message) without
# repeating it every two seconds.
SUPPRESS_WINDOW_S = int(os.getenv("CARTO_EXPORT_ERROR_WINDOW_S", "60"))

_EXPORTER_LOGGERS = (
    "opentelemetry.exporter.otlp.proto.http.metric_exporter",
    "opentelemetry.exporter.otlp.proto.http.trace_exporter",
    "opentelemetry.exporter.otlp.proto.http._log_exporter",
    "opentelemetry.sdk.metrics.export",
)


class _RateLimitFilter(logging.Filter):
    """One record per window, keyed on the logger. Retry-chatter is dropped."""

    def __init__(self) -> None:
        super().__init__()
        self._last: Dict[str, float] = {}

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        # The retry lines are the ones that announce the next attempt. They are
        # pure noise: the terminal failure is logged separately.
        if "retrying in" in msg:
            return False
        now = time.time()
        prev = self._last.get(record.name, 0.0)
        if now - prev < SUPPRESS_WINDOW_S:
            return False
        self._last[record.name] = now
        return True


def _quiet_exporters() -> None:
    f = _RateLimitFilter()
    for name in _EXPORTER_LOGGERS:
        lg = logging.getLogger(name)
        lg.addFilter(f)


# ---------------------------------------------------------------------------
# Provider bootstrap
# ---------------------------------------------------------------------------
def install() -> None:
    """Register an OTel SDK MeterProvider when the active mode has none.

    Called from boot.py BEFORE the app module is imported, so instruments
    created at module scope in main.py still bind to the real provider.
    Idempotent and never raises — a metrics pipeline failure must not stop the
    service from serving requests.
    """
    global _meter

    # Applies in every mode: MODE=otel's exporters are just as capable of
    # flooding the stream when the collector is down.
    _quiet_exporters()

    if MODE == "otel":
        # opentelemetry-instrument already built a MeterProvider from
        # OTEL_METRICS_EXPORTER / OTEL_EXPORTER_OTLP_*. Do not touch it.
        return

    try:
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )

        # The signal-specific var wins over the general one, which is what lets
        # compose point metrics at the Agent while traces go to the Agent's
        # APM port in agent/dual mode. Falls back to the Agent's OTLP HTTP
        # receiver on the compose network.
        endpoint = (
            os.getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
            or "http://datadog-agent:4318/v1/metrics"
        )

        resource = Resource.create({
            "service.name": SERVICE,
            "service.version": os.getenv("DD_VERSION", "0.1.0"),
            "deployment.environment": os.getenv("DD_ENV", "dev"),
            "service.namespace": "carto",
            # Same pivot tag the traces and logs carry, so one tag filters
            # every signal by which stack produced it.
            "instrumentation": MODE,
        })

        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint),
            export_interval_millis=int(os.getenv("CARTO_METRIC_EXPORT_MS", "10000")),
        )
        otel_metrics.set_meter_provider(
            MeterProvider(resource=resource, metric_readers=[reader])
        )
        _meter = otel_metrics.get_meter("carto")
        logging.getLogger("obs_metrics").info(
            "OTel metrics provider registered",
            extra={"ctx_endpoint": endpoint, "ctx_mode": MODE,
                   "ctx_export_interval_ms": os.getenv("CARTO_METRIC_EXPORT_MS", "10000")},
        )
    except Exception:  # noqa: BLE001 — metrics must never block startup
        # Leave the no-op provider in place. The local snapshot still works, so
        # the Telemetry tab stays populated even if OTLP export is broken.
        _meter = None


def _meter_handle():
    global _meter
    if _meter is None:
        _meter = otel_metrics.get_meter("carto")
    return _meter


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------
def _tag_key(tags: dict) -> str:
    if not tags:
        return ""
    return ",".join(f"{k}:{tags[k]}" for k in sorted(tags))


def _ensure(name: str, kind: str, unit: str, description: str) -> dict:
    entry = _snapshot.get(name)
    if entry is None:
        entry = {
            "name": name,
            "type": kind,
            "unit": unit,
            "description": description,
            "service": SERVICE,
            "points": {},
        }
        _snapshot[name] = entry
    return entry


# ---------------------------------------------------------------------------
# Public API — counters and histograms
# ---------------------------------------------------------------------------
def count(name: str, value: int = 1, unit: str = "1", description: str = "", **tags) -> None:
    """Increment a monotonic counter. Tags become OTel attributes."""
    try:
        inst = _instruments.get(("counter", name))
        if inst is None:
            inst = _meter_handle().create_counter(
                name, unit=unit, description=description or name
            )
            _instruments[("counter", name)] = inst
        inst.add(value, attributes=tags or None)
    except Exception:  # noqa: BLE001
        pass

    with _lock:
        entry = _ensure(name, "counter", unit, description)
        pt = entry["points"].setdefault(_tag_key(tags), {"tags": dict(tags), "value": 0})
        pt["value"] += value
        pt["last_seen"] = time.time()


def record(name: str, value: float, unit: str = "ms", description: str = "", **tags) -> None:
    """Record a histogram observation (latency, amount, percentage)."""
    try:
        inst = _instruments.get(("histogram", name))
        if inst is None:
            inst = _meter_handle().create_histogram(
                name, unit=unit, description=description or name
            )
            _instruments[("histogram", name)] = inst
        inst.record(value, attributes=tags or None)
    except Exception:  # noqa: BLE001
        pass

    with _lock:
        entry = _ensure(name, "histogram", unit, description)
        pt = entry["points"].setdefault(
            _tag_key(tags),
            {"tags": dict(tags), "count": 0, "sum": 0.0,
             "min": None, "max": None, "samples": []},
        )
        pt["count"] += 1
        pt["sum"] += value
        pt["min"] = value if pt["min"] is None else min(pt["min"], value)
        pt["max"] = value if pt["max"] is None else max(pt["max"], value)
        pt["samples"].append(value)
        if len(pt["samples"]) > MAX_SAMPLES:
            del pt["samples"][0 : len(pt["samples"]) - MAX_SAMPLES]
        pt["last_seen"] = time.time()


def gauge(name: str, value: float, unit: str = "1", description: str = "", **tags) -> None:
    """Report a point-in-time value.

    Implemented as an OTel *gauge* instrument where the SDK version supports
    one, falling back to a counter-free snapshot-only entry otherwise (older
    OTel Python has no synchronous gauge). The snapshot always records it, so
    the Telemetry tab shows it either way.
    """
    try:
        inst = _instruments.get(("gauge", name))
        if inst is None:
            factory = getattr(_meter_handle(), "create_gauge", None)
            inst = factory(name, unit=unit, description=description or name) if factory else False
            _instruments[("gauge", name)] = inst
        if inst:
            inst.set(value, attributes=tags or None)
    except Exception:  # noqa: BLE001
        pass

    with _lock:
        entry = _ensure(name, "gauge", unit, description)
        pt = entry["points"].setdefault(_tag_key(tags), {"tags": dict(tags)})
        pt["value"] = value
        pt["last_seen"] = time.time()


# ---------------------------------------------------------------------------
# /debug/metrics payload
# ---------------------------------------------------------------------------
def _percentile(sorted_vals: List[float], q: float) -> Optional[float]:
    if not sorted_vals:
        return None
    idx = min(int(round(q * (len(sorted_vals) - 1))), len(sorted_vals) - 1)
    return sorted_vals[idx]


def snapshot() -> dict:
    """Render the metric registry as JSON for GET /debug/metrics.

    Histogram sample windows are summarised (count/sum/avg/min/max/p50/p95/p99)
    rather than dumped, so the payload stays small regardless of traffic.
    """
    with _lock:
        out = []
        for entry in _snapshot.values():
            points = []
            for pt in entry["points"].values():
                if entry["type"] == "histogram":
                    vals = sorted(pt["samples"])
                    points.append({
                        "tags": pt["tags"],
                        "count": pt["count"],
                        "sum": round(pt["sum"], 3),
                        "avg": round(pt["sum"] / pt["count"], 3) if pt["count"] else None,
                        "min": pt["min"],
                        "max": pt["max"],
                        "p50": _percentile(vals, 0.50),
                        "p95": _percentile(vals, 0.95),
                        "p99": _percentile(vals, 0.99),
                        "window": len(vals),
                    })
                else:
                    points.append({k: v for k, v in pt.items() if k != "samples"})
            out.append({
                "name": entry["name"],
                "type": entry["type"],
                "unit": entry["unit"],
                "description": entry["description"],
                "service": entry["service"],
                "points": points,
            })
        out.sort(key=lambda m: m["name"])

    return {
        "service": SERVICE,
        "instrumentation": MODE,
        "signal": "metrics",
        "transport": _transport(),
        "metrics": out,
    }


def _transport() -> dict:
    """Where this process's metrics actually go, per mode. Shown in the UI so
    the routing is stated rather than assumed."""
    if MODE == "otel":
        return {
            "api": "opentelemetry-metrics",
            "sdk": "opentelemetry-sdk (configured by opentelemetry-instrument)",
            "exporter": "otlp/http",
            "endpoint": os.getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
                        or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "unset"),
            "then": "otel-collector -> datadog exporter -> Datadog",
        }
    return {
        "api": "opentelemetry-metrics",
        "sdk": "opentelemetry-sdk (registered by obs_metrics.install)",
        "exporter": "otlp/http",
        "endpoint": os.getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
                    or "http://datadog-agent:4318/v1/metrics",
        "then": "Datadog Agent OTLP receiver -> Datadog",
    }
