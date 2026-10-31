"""Uniform app bootstrap across instrumentation modes.

Every mode executes this same file, so startup ORDER is identical everywhere:

    logging -> metrics provider -> (dual) OTel trace bridge -> uvicorn/main:app

Order is load-bearing at two points:

  * obs_metrics.install() must precede the app import, because main.py records
    metrics at request time through instruments that bind to whatever
    MeterProvider is global when they are first created. Registering the
    provider after the app module loaded would leave early instruments bound
    to the no-op provider.

  * otel_bridge.install() must precede the app import too, because
    FastAPIInstrumentor patches at class level and has to be in place when the
    FastAPI() object is constructed.

AND `log_config=None` IS LOAD-BEARING
=====================================
`uvicorn.run()` applies its OWN logging dictConfig at startup — after this
file has already installed the JSON formatter — and dictConfig REPLACES the
handlers on `uvicorn`, `uvicorn.access` and `uvicorn.error`. The result was
that app logs shipped as correlated JSON while access logs shipped as
uvicorn's default plaintext:

    INFO:     172.25.0.6:40768 - "GET /facets HTTP/1.1" 200 OK

Measured against a live org, that was roughly two thirds of one service's
log records — uncorrelated and unparsed. `log_config=None`
tells uvicorn to configure no logging at all, so obs_logging's handlers
survive and access logs go out in the same shape as everything else.
"""

import os

import obs_logging

obs_logging.configure()

import obs_metrics  # noqa: E402 — after logging so failures are logged in JSON

obs_metrics.install()

if os.getenv("INSTRUMENTATION_MODE") == "dual":
    import otel_bridge

    otel_bridge.install()

import uvicorn  # noqa: E402 — must follow logging + metrics + bridge setup

uvicorn.run(
    "main:app",
    host="0.0.0.0",
    port=8080,
    # See the module docstring: without this, uvicorn's dictConfig replaces
    # obs_logging's handlers and every access log reverts to plaintext.
    log_config=None,
)
