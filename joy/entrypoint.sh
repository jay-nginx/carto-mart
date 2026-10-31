#!/bin/sh
# Selects the tracing runtime from $INSTRUMENTATION_MODE.
#
# All three modes exec the same boot.py, so app startup order is identical
# across modes and only the launcher differs.
set -e

MODE="${INSTRUMENTATION_MODE:-agent}"
echo "[entrypoint] INSTRUMENTATION_MODE=${MODE}" >&2

case "$MODE" in
  agent)
    exec ddtrace-run python boot.py
    ;;
  dual)
    # ddtrace-run, NOT opentelemetry-instrument. The OTel distro would
    # register an SDK TracerProvider, and whichever of ddtrace/SDK registers
    # last wins the global-provider race — silently dropping every span on
    # the losing side. In dual mode ddtrace must own the global provider so
    # that OTel-API spans land in Datadog with AAP/IAST/Profiler intact.
    exec ddtrace-run python boot.py
    ;;
  otel)
    exec opentelemetry-instrument python boot.py
    ;;
  *)
    echo "[entrypoint] unknown INSTRUMENTATION_MODE='${MODE}' (want: agent|dual|otel)" >&2
    exit 64
    ;;
esac
