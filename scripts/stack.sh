#!/usr/bin/env bash
# ===========================================================================
# stack.sh — graceful stop / start / restart for the Carto harness.
#
#   ./carto stop      | ./scripts/stack.sh stop      quiesce and stop, keep everything
#   ./carto start     | ./scripts/stack.sh start     bring it back and wait until usable
#   ./carto cycle     | ./scripts/stack.sh restart   stop then start
#   ./carto status    | ./scripts/stack.sh status    what is running, and is it serving
#
# WHY THIS EXISTS RATHER THAN `docker compose stop`
# =================================================
# Two things a bare stop gets wrong on this stack:
#
#   1. ORDER. Postgres ships with StopSignal=SIGINT, which is a FAST shutdown:
#      it disconnects clients mid-transaction. If the app services are still
#      attached when it goes, the next start replays WAL and the first few
#      queries of the demo are slow — or, if a write was in flight, the
#      transaction_ledger loses the tail of a journey. Stopping the writers
#      first means Postgres shuts down with no clients to interrupt.
#
#   2. TELEMETRY. The Datadog Agent batches logs and metrics. Killing it
#      alongside the apps discards whatever had not shipped, so the last
#      minute before a shutdown is missing from the demo org — which is
#      exactly the minute a presenter was looking at. The Agent is stopped
#      AFTER the applications it collects from, with time to flush.
#
# Each app also runs background threads (the WMS stage worker, catalogue
# replenishment, the Joy driver, heartbeats). They are daemon threads, so
# SIGTERM ends the process cleanly — but uvicorn needs a moment to finish an
# in-flight request, hence the per-service grace period rather than the
# 10-second Docker default.
#
# `stop` uses `docker compose stop`, NOT `down`: containers are kept, so a
# start is seconds rather than a rebuild, and nothing that lives in a
# container's filesystem is lost.
# ===========================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

# --- compose composition, identical to the Makefile's ----------------------
COMPOSE_FILES="compose.yaml"
[[ -f docker-compose.override.yaml ]] && COMPOSE_FILES="$COMPOSE_FILES:docker-compose.override.yaml"
[[ -f docker-compose.rum-dns.yaml  ]] && COMPOSE_FILES="$COMPOSE_FILES:docker-compose.rum-dns.yaml"
export COMPOSE_FILE="$COMPOSE_FILES"

# The Agent and the Synthetics worker sit behind profiles; without naming them
# they are invisible to compose and would be left running by a stop.
PROFILES="agent"
docker inspect carto-synthetics-pl >/dev/null 2>&1 && PROFILES="agent,synthetics"
export COMPOSE_PROFILES="$PROFILES"

# carto.env is needed for variable interpolation in compose.yaml (DD_API_KEY etc).
# Absent, compose warns on every line; present, it is silent.
if [[ -f carto.env ]]; then set -a; . ./carto.env; set +a; fi

BFF="${BFF:-http://localhost:8091}"
WEB="${WEB:-${WEB_URL:-http://localhost:5175}}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Stop order: the things that GENERATE work first, then the things that serve
# it, then the collector, then the database.
STOP_ORDER=(load synthetics-pl web bff joy checkout fulfilment catalogue datadog-agent postgres)
# Start order is the reverse dependency order. compose honours depends_on, but
# being explicit means the health waits below are meaningful.
START_ORDER=(postgres catalogue checkout fulfilment joy bff web datadog-agent load synthetics-pl)

# Per-service grace. Postgres gets the longest: even with no clients it
# checkpoints on the way out, and a SIGKILL mid-checkpoint is the thing we are
# avoiding. The load driver gets the shortest — it is a browser, there is
# nothing to preserve.
grace_for() {
  case "$1" in
    postgres)      echo 30 ;;
    datadog-agent) echo 20 ;;
    load)          echo 5  ;;
    *)             echo 15 ;;
  esac
}

# Resolve a compose SERVICE to its container id via compose itself.
#
# Do not derive the container name from the service name: `datadog-agent` is
# `carto-dd-agent`, so the first version of this script guessed
# `carto-datadog-agent`, found nothing, and skipped the Agent entirely — it was
# left running after a "complete" shutdown. Asking compose removes the guess.
cid() { docker compose ps -aq "$1" 2>/dev/null | head -1; }

exists() { [[ -n "$(cid "$1")" ]]; }
# ---------------------------------------------------------------------------
# amd64 emulation, for the Synthetics private-location worker.
#
# Datadog publishes that worker for linux/amd64 ONLY, so on an Apple Silicon
# laptop it runs under emulation. The binfmt_misc handler that provides it
# lives in the Docker VM's kernel and does NOT survive a Docker Desktop
# restart — when it is missing the container crash-loops with
# "exec /home/dog/scripts/s6-init.sh: exec format error", every [Carto]
# synthetic silently stops executing, and the only visible symptom is test
# results quietly going stale. That is a bad thing to discover in front of a
# customer, so the start path checks and repairs it.
#
# The repair is the canonical one from Docker's multi-platform docs: register
# the QEMU handlers with tonistiigi/binfmt (the buildkit maintainer's image,
# which needs --privileged to write binfmt_misc). Skip it with
# CARTO_SKIP_BINFMT=1 if you would rather use Docker Desktop's Rosetta setting
# (Settings -> General -> "Use Rosetta for x86_64/amd64 emulation").
amd64_emulation_ok() {
  docker run --rm --platform linux/amd64 alpine:3.20 true >/dev/null 2>&1
}

ensure_amd64_emulation() {
  # Only relevant if this harness actually has the worker.
  exists synthetics-pl || return 0
  [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] || return 0
  if amd64_emulation_ok; then
    ok "amd64 emulation available (synthetics worker can run)"
    return 0
  fi
  if [[ "${CARTO_SKIP_BINFMT:-0}" == "1" ]]; then
    warn "amd64 emulation is unavailable and CARTO_SKIP_BINFMT=1 — the synthetics worker will crash-loop"
    return 1
  fi
  warn "amd64 emulation missing — the synthetics worker cannot start. Installing QEMU handlers…"
  if docker run --privileged --rm tonistiigi/binfmt --install amd64 >/dev/null 2>&1 \
     && amd64_emulation_ok; then
    ok "amd64 emulation restored"
  else
    bad "could not restore amd64 emulation — enable Rosetta in Docker Desktop, or run:"
    echo "        docker run --privileged --rm tonistiigi/binfmt --install amd64"
    return 1
  fi
}


# `restarting` counts as running. A crash-looping container (the amd64-only
# synthetics worker on an Apple Silicon host with emulation unavailable, for
# example) reports `restarting`, and treating that as "already stopped" left it
# spinning after a shutdown.
running() {
  local id st
  id=$(cid "$1"); [[ -n "$id" ]] || return 1
  st=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)
  [[ "$st" == "running" || "$st" == "restarting" ]]
}

# Human-facing name, for log lines.
cname() {
  local id; id=$(cid "$1")
  [[ -n "$id" ]] && docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||' || echo "carto-$1"
}

do_stop() {
  step "quiescing the demo before shutdown"
  # Clear injected failures so the stack comes back on a clean baseline rather
  # than in whatever state the last demo left it. Best effort: if the BFF is
  # already gone this is a no-op.
  if curl -sf --max-time 5 "$BFF/api/demo/reset" >/dev/null 2>&1; then
    ok "failure scenarios cleared (clean baseline on next start)"
  else
    warn "could not reach the demo control plane — skipping the reset"
  fi
  # Stop generating traffic first so the services below drain rather than
  # being stopped mid-journey.
  if running load; then
    docker compose stop -t 5 load >/dev/null 2>&1 && ok "load driver stopped (no new journeys)"
    sleep 2
  fi

  step "stopping services in dependency order"
  for svc in "${STOP_ORDER[@]}"; do
    exists "$svc" || continue
    running "$svc" || { warn "$(cname "$svc") already stopped"; continue; }
    g=$(grace_for "$svc")
    if [[ "$svc" == "datadog-agent" ]]; then
      # Give the Agent a moment with no new input so its batches flush.
      sleep 3
    fi
    if docker compose stop -t "$g" "$svc" >/dev/null 2>&1; then
      ok "$(cname "$svc") stopped (grace ${g}s)"
    else
      bad "$(cname "$svc") did not stop cleanly"
    fi
  done

  step "result"
  local left
  left=$(docker ps --filter 'name=carto-' --format '{{.Names}}' | wc -l | tr -d ' ')
  [[ "$left" == "0" ]] && ok "all carto containers stopped; images, volumes and data kept" \
                       || warn "$left container(s) still running: $(docker ps --filter 'name=carto-' --format '{{.Names}}' | tr '\n' ' ')"
  echo
  echo "  bring it back with:  ./carto start"
}

wait_http() {  # wait_http <url> <seconds> <label>
  local url="$1" secs="$2" label="$3" i=0
  while (( i < secs )); do
    curl -sf --max-time 3 "$url" >/dev/null 2>&1 && { ok "$label ready (${i}s)"; return 0; }
    sleep 2; i=$((i+2))
  done
  bad "$label did not answer within ${secs}s"
  return 1
}

wait_healthy() {  # wait_healthy <service> <seconds>
  local svc="$1" secs="$2" i=0 h id n
  id=$(cid "$svc"); n=$(cname "$svc")
  [[ -n "$id" ]] || { bad "$n does not exist"; return 1; }
  while (( i < secs )); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$id" 2>/dev/null || echo missing)
    case "$h" in
      healthy) ok "$n healthy (${i}s)"; return 0 ;;
      none)    ok "$n running (no healthcheck defined)"; return 0 ;;
    esac
    sleep 2; i=$((i+2))
  done
  warn "$n still '$h' after ${secs}s — check: docker logs $n"
  return 1
}

do_start() {
  step "pre-flight"
  ensure_amd64_emulation

  step "starting services in dependency order"
  local missing=0
  for svc in "${START_ORDER[@]}"; do
    exists "$svc" || { missing=$((missing+1)); continue; }
    if running "$svc"; then
      ok "$(cname "$svc") already running"
    else
      docker compose start "$svc" >/dev/null 2>&1 \
        && ok "$(cname "$svc") started" || bad "$(cname "$svc") failed to start"
    fi
    # Wait on the layer below before starting the layer above, so nothing
    # comes up against a database or a BFF that is not accepting yet.
    case "$svc" in
      postgres)                              wait_healthy postgres 60 ;;
      catalogue|checkout|fulfilment|joy|bff)  wait_healthy "$svc" 90 ;;
      web)                                   wait_healthy web 60 ;;
    esac
  done
  # Surface anything stuck in a restart loop — it reports as running but is
  # serving nothing, which is the failure mode that hid a dead BFF for days.
  for svc in "${START_ORDER[@]}"; do
    exists "$svc" || continue
    if [[ "$(docker inspect -f '{{.State.Status}}' "$(cid "$svc")" 2>/dev/null)" == "restarting" ]]; then
      bad "$(cname "$svc") is CRASH-LOOPING — check: docker logs $(cname "$svc")"
    fi
  done
  if (( missing > 0 )); then
    warn "$missing service(s) have no container yet — run 'make up' once to build them"
  fi

  step "verifying the stack is actually usable"
  wait_http "$BFF/healthz" 60 "storefront BFF"
  wait_http "$WEB/"        60 "storefront"
  local n
  n=$(curl -s --max-time 10 "$WEB/api/products?limit=3" \
      | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("count",0))
except Exception: print(0)' 2>/dev/null || echo 0)
  [[ "${n:-0}" -ge 1 ]] && ok "products load through the browser path ($n returned)" \
                        || bad "NO PRODUCTS through $WEB/api/products — run ./carto doctor"
  curl -s --max-time 10 "$BFF/api/demo/status" 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print("  \033[32m✓\033[0m demo state: %s" % d["headline"])
except Exception:
    print("  \033[33m!\033[0m could not read demo state")' 2>/dev/null || true

  step "ready"
  echo "  storefront      $WEB"
  echo "  run sheet       $WEB/demo-walkthrough.html"
  echo "  demo state      $WEB/demo-state"
  echo "  tracking        $WEB/track?q=CT-CUST-9001"
  echo
  echo "  full check:     ./carto doctor"
}

do_status() {
  step "containers"
  docker ps -a --filter 'name=carto-' \
    --format '  {{.Names}}\t{{.State}}\t{{.Status}}' | sort
  step "endpoints"
  for pair in "catalogue:8021" "checkout:8022" "fulfilment:8023" "joy:8024" "storefront:8091"; do
    name=${pair%%:*}; port=${pair##*:}
    curl -sf --max-time 3 "http://localhost:$port/healthz" >/dev/null 2>&1 \
      && ok "$name :$port" || bad "$name :$port not answering"
  done
  curl -sf --max-time 3 "$WEB/" >/dev/null 2>&1 && ok "storefront $WEB" || bad "storefront $WEB not answering"
}

case "${1:-}" in
  stop)    do_stop ;;
  start)   do_start ;;
  restart) do_stop; echo; do_start ;;
  status)  do_status ;;
  *) echo "usage: $0 {stop|start|restart|status}"; exit 2 ;;
esac
