# Generic FastAPI + ddtrace runtime. The service supplies main.py and
# requirements.txt; this Dockerfile installs and runs them.
#
# DELIBERATELY VULNERABLE BASE (SCA/CSM story): pinned to an EOL
# Python 3.9 / Debian bullseye image. The agent's container-image SBOM
# scanning (DD_SBOM_CONTAINER_IMAGE_ENABLED) surfaces the stale OS-package
# CVEs + the EOL interpreter as vulnerabilities on carto-catalogue. This
# is intentional — do NOT "fix" it back to slim/bookworm. The catalogue service
# runs fine on 3.9 (PEP 585 generics, pydantic v2, ddtrace all 3.9-compatible).
#
# Debian 11 is end-of-life. deb.debian.org still serves the
# bullseye-security *index*, but its .deb pool has been purged, so the
# image's default sources 404 on ca-certificates/curl. We repoint apt at
# archive.debian.org (bullseye + bullseye-updates, which still have a
# complete pool), drop the dead security suite, and skip the expired
# Release date check. The base image is NOT bumped — the EOL base IS the
# demo, and pinning to pre-security-update packages only makes the SBOM
# story louder.
FROM python:3.9-slim-bullseye

WORKDIR /app

# Build deps if a service pins something native (confluent-kafka, etc.)
RUN printf '%s\n' \
      'deb http://archive.debian.org/debian bullseye main' \
      'deb http://archive.debian.org/debian bullseye-updates main' \
      > /etc/apt/sources.list \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99archive \
 && apt-get update -qq \
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

# Non-root runtime user (IaC HIGH: missing-user-instruction). uvicorn
# binds to 8080 (>1024), so non-root has no port-bind issues.
RUN chown -R app:app /app
USER app

EXPOSE 8080

# Instrumentation runtime is selected at container start from
# $INSTRUMENTATION_MODE (agent | dual | otel); all three exec boot.py, which
# configures logging before uvicorn binds so access logs are correlated from
# request 1. See entrypoint.sh.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
