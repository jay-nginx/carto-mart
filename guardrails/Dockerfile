# Generic FastAPI + ddtrace runtime. The service supplies main.py and
# requirements.txt; this Dockerfile installs and runs them.
#
# Unlike catalogue/Dockerfile (pinned to an EOL 3.9/bullseye base on purpose,
# as the SBOM/CVE story), this service runs a current slim base — so the
# Vulnerability Management view shows a MIX of clean and vulnerable services
# rather than a uniformly red stack.
FROM python:3.12-slim-bookworm

WORKDIR /app

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app -d /app -s /usr/sbin/nologin app

# Both dependency sets are installed unconditionally: the Datadog tracer and
# the OpenTelemetry stack. This is what makes a mode switch a ~5s container
# recreate instead of a ~3min rebuild of every app image — see
# requirements-otel.txt for the version-pinning rationale.
COPY requirements.txt requirements-otel.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt \
                               -r /app/requirements-otel.txt

COPY . /app/

# Mode-aware observability helpers (already present via `COPY . /app/`;
# listed explicitly so the contract is visible):
#   obs_logging.py  one JSON log shape for app + uvicorn, trace ids resolved
#                   per mode.
#   obs_span.py     span error recording that works in all three modes.
#   otel_bridge.py  MODE=dual only: OTel contrib instrumentors on ddtrace.
#   boot.py         common app bootstrap (logging -> bridge -> uvicorn).
COPY obs_logging.py obs_span.py otel_bridge.py boot.py /app/

# Instrumentation runtime is chosen at container start from
# $INSTRUMENTATION_MODE. chmod must precede the USER switch below.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

RUN chown -R app:app /app
USER app

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
