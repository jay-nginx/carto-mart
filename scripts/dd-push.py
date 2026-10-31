#!/usr/bin/env python3
"""Push every Carto Datadog asset in this repo to the org, idempotently.

    ./scripts/creds-from-env.sh ./scripts/dd-push.py [dashboards|monitors|slos|synthetics|catalog|all]

WHY A SCRIPT RATHER THAN CLICKING
=================================
The demo org accumulates assets. Every object this repo creates is named with
a "[Carto]" prefix (monitors, SLOs, synthetics) or a "Carto —" prefix
(dashboards) and tagged `harness:carto`, so the whole set is findable, and
deletable, as a unit. Re-running is safe: assets are matched by name and
UPDATED in place rather than duplicated, because the v1 dashboard POST does
not upsert and a demo org full of "Carto — Exec Overview (3)" is its own
failure mode.

Definitions live in dashboards/, monitors/, slos/, synthetics/ as JSON, so the
telemetry story and the asset that presents it are versioned together.
"""

from __future__ import annotations

import json
import os
import re
import pathlib
import sys
import urllib.error
import urllib.request

SITE = os.getenv("DD_SITE", "datadoghq.com")
API = "https://api.{}".format(SITE)
APP = ("app.datadoghq.com" if SITE == "datadoghq.com"
       else "app.datadoghq.eu" if SITE == "datadoghq.eu" else "app." + SITE)
API_KEY = os.environ.get("DD_API_KEY", "")
APP_KEY = os.environ.get("DD_APP_KEY", "")
ROOT = pathlib.Path(__file__).resolve().parent.parent

if not (API_KEY and APP_KEY):
    sys.exit("DD_API_KEY and DD_APP_KEY must be set (run via ./scripts/creds-from-env.sh)")


def call(method: str, path: str, body=None, raw=False, raise_http=False):
    """Call the API.

    By default an HTTP error is fatal, because a failed dashboard push almost
    always means a malformed definition and continuing would hide it. Callers
    that must survive a per-item failure (synthetics, where one test can hit an
    org quota while the rest are fine) pass raise_http=True and handle it."""
    url = path if path.startswith("http") else API + path
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("DD-API-KEY", API_KEY)
    req.add_header("DD-APPLICATION-KEY", APP_KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read().decode()
            return json.loads(payload) if payload and not raw else payload
    except urllib.error.HTTPError as e:
        if raise_http:
            raise
        detail = e.read().decode()
        raise SystemExit("{} {} -> {} {}".format(method, url, e.code, detail[:1200]))


# Asset definitions are tracked in git, so they must not contain anyone's
# notification target. They carry ${ALERT_EMAIL} and friends instead, expanded
# here from the environment at push time. Unset variables are left as the empty
# string rather than the literal "${NAME}", because a monitor that notifies
# "@${ALERT_EMAIL}" fails silently: Datadog accepts it and routes it nowhere.
_VAR = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")


def expand_env(text: str) -> str:
    missing = set()

    def sub(m):
        name = m.group(1)
        val = os.environ.get(name, "")
        if not val:
            missing.add(name)
        return val

    out = _VAR.sub(sub, text)
    if missing:
        print("  warning: unset in carto.env, substituted empty: {}".format(
            ", ".join(sorted(missing))))
    return out


def load(kind: str):
    d = ROOT / kind
    if not d.is_dir():
        return []
    return [(p, json.loads(expand_env(p.read_text()))) for p in sorted(d.glob("*.json"))]



# ---------------------------------------------------------------------------
# Org monitor-tag policy
# ---------------------------------------------------------------------------
# An org can enforce required tag keys on monitors, with a closed set of
# allowed values. This org requires `datacenter` and monitor creation is
# REJECTED with "Missing required tag key(s): datacenter" without it.
#
# Rather than hardcode a tag that exists in exactly one org, read the policy
# and satisfy whatever it asks for, so this script also works in an org with
# different policies or none. Value selection, in order: CARTO_TAG_<KEY> from the
# environment, then the first value the policy permits, then "prod".
def policy_tags():
    try:
        body = call("GET", "/api/v2/monitor/policy")
    except SystemExit:
        return []
    out = []
    for pol in body.get("data", []) or []:
        attrs = pol.get("attributes") or {}
        if attrs.get("policy_type") != "tag":
            continue
        policy = attrs.get("policy") or {}
        key = policy.get("tag_key")
        if not key or not policy.get("tag_key_required"):
            continue
        allowed = policy.get("valid_tag_values") or []
        val = os.getenv("CARTO_TAG_" + key.upper()) or (allowed[0] if allowed else "prod")
        out.append("{}:{}".format(key, val))
    return out


POLICY_TAGS = None


def with_policy_tags(tags):
    """Append whatever the org's monitor tag policy requires, once."""
    global POLICY_TAGS
    if POLICY_TAGS is None:
        POLICY_TAGS = policy_tags()
        if POLICY_TAGS:
            print("org monitor tag policy requires: {}".format(", ".join(POLICY_TAGS)))
    have = {t.split(":", 1)[0] for t in tags}
    return tags + [t for t in POLICY_TAGS if t.split(":", 1)[0] not in have]


# ---------------------------------------------------------------------------
# Dashboards — matched on title.
# ---------------------------------------------------------------------------
def push_dashboards():
    existing = {d["title"]: d["id"] for d in call("GET", "/api/v1/dashboard").get("dashboards", [])}
    for path, body in load("dashboards"):
        title = body["title"]
        if title in existing:
            res = call("PUT", "/api/v1/dashboard/{}".format(existing[title]), body)
            action = "updated"
        else:
            res = call("POST", "/api/v1/dashboard", body)
            action = "created"
        print("dashboard {} {}: https://{}{}".format(action, title, APP, res["url"]))


# ---------------------------------------------------------------------------
# Monitors — matched on name.
# ---------------------------------------------------------------------------
def push_monitors():
    existing = {m["name"]: m["id"] for m in call("GET", "/api/v1/monitor")}
    for path, body in load("monitors"):
        body = dict(body)
        body["tags"] = with_policy_tags(body.get("tags", []))
        name = body["name"]
        if name in existing:
            res = call("PUT", "/api/v1/monitor/{}".format(existing[name]), body)
            action = "updated"
        else:
            res = call("POST", "/api/v1/monitor", body)
            action = "created"
        print("monitor {} {}: https://{}/monitors/{}".format(action, name, APP, res["id"]))


# ---------------------------------------------------------------------------
# SLOs — matched on name.
# ---------------------------------------------------------------------------
def push_slos():
    existing = {s["name"]: s["id"] for s in call("GET", "/api/v1/slo?limit=1000").get("data", [])}
    for path, body in load("slos"):
        body = dict(body)
        body["tags"] = with_policy_tags(body.get("tags", []))
        name = body["name"]
        if name in existing:
            res = call("PUT", "/api/v1/slo/{}".format(existing[name]), body)
            action = "updated"
        else:
            res = call("POST", "/api/v1/slo", body)
            action = "created"
        sid = res["data"][0]["id"] if isinstance(res.get("data"), list) else res["data"]["id"]
        print("slo {} {}: https://{}/slo/manage?query={}".format(action, name, APP, sid))


# ---------------------------------------------------------------------------
# Synthetics — matched on name. Private-location id is injected from
# synthetics-pl-config.json so the JSON definitions carry no environment
# specifics.
# ---------------------------------------------------------------------------
def private_location_id():
    override = os.getenv("CARTO_SYNTHETICS_LOCATION")
    if override:
        return override
    cfg = ROOT / "synthetics-pl-config.json"
    if cfg.is_file():
        try:
            return json.loads(cfg.read_text())["id"]
        except Exception:  # noqa: BLE001
            pass
    return None


def push_synthetics():
    loc = private_location_id()
    if not loc:
        print("synthetics: no private location available — set CARTO_SYNTHETICS_LOCATION "
              "or add synthetics-pl-config.json. Skipping.")
        return
    existing = {t["name"]: t["public_id"]
                for t in call("GET", "/api/v1/synthetics/tests").get("tests", [])}
    for path, body in load("synthetics"):
        body = dict(body)
        # Every test in this repo runs from the private location that sits on
        # the carto compose network; managed locations cannot reach
        # http://web or http://bff:8080.
        body["locations"] = [loc]
        name = body["name"]
        kind = body.get("subtype", body.get("type"))
        base = "/api/v1/synthetics/tests"
        # Creation endpoints are per-type: /tests/api for API and multistep API
        # tests, /tests/browser for browser tests. Updates go to /tests/<id>
        # regardless.
        create = "{}/{}".format(base, "browser" if body.get("type") == "browser" else "api")
        # One test failing must not abort the rest. Browser-test quota is the
        # common case: orgs cap them (often at 5), and because the browser
        # definition sorts first alphabetically, an unguarded failure here used
        # to prevent all three API tests from ever being created.
        try:
            if name in existing:
                res = call("PUT", "{}/{}".format(base, existing[name]), body, raise_http=True)
                action = "updated"
            else:
                res = call("POST", create, body, raise_http=True)
                action = "created"
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:200]
            if e.code == 402:
                print("synthetic SKIPPED {} ({}): quota reached in this org. "
                      "Free a slot or delete an unused test, then re-run.".format(name, kind))
            else:
                print("synthetic FAILED {} ({}): {} {}".format(name, kind, e.code, detail))
            continue
        print("synthetic {} {} ({}): https://{}/synthetics/details/{}".format(
            action, name, kind, APP, res["public_id"]))


# ---------------------------------------------------------------------------
# Software Catalog entities (v2 API, YAML or JSON accepted).
# ---------------------------------------------------------------------------
def push_catalog():
    f = ROOT / "catalog" / "carto-entities.yaml"
    if not f.is_file():
        print("catalog: no entity file, skipping")
        return
    url = API + "/api/v2/catalog/entity"
    # Entity docs deep-link into the app, so the YAML carries ${WEB_URL}
    # for the same reason the monitors do -- expand it like load() does.
    body = expand_env(f.read_text()).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("DD-API-KEY", API_KEY)
    req.add_header("DD-APPLICATION-KEY", APP_KEY)
    req.add_header("Content-Type", "application/yaml")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
        print("catalog entities pushed: https://{}/software".format(APP))
    except urllib.error.HTTPError as e:
        print("catalog push failed: {} {}".format(e.code, e.read().decode()[:400]))


TARGETS = {
    "dashboards": push_dashboards,
    "monitors": push_monitors,
    "slos": push_slos,
    "synthetics": push_synthetics,
    "catalog": push_catalog,
}

if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what == "all":
        # Monitors before SLOs: a monitor-based SLO needs its monitor to exist.
        for k in ("monitors", "slos", "dashboards", "synthetics", "catalog"):
            print("--- {}".format(k))
            TARGETS[k]()
    elif what in TARGETS:
        TARGETS[what]()
    else:
        sys.exit("unknown target {} (want: {} | all)".format(what, " | ".join(TARGETS)))
