#!/usr/bin/env bash
# doctor.sh — is this harness actually demo-ready?
#
# Checks the things that break a demo in front of a customer, in the order they
# break: containers, then HTTP endpoints, then whether each signal is really
# leaving the box, then whether the Carto tracking ids are present end to end.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARN=$((WARN+1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$*"; }

BFF=${BFF:-http://localhost:8091}

# --creds-only stops after the credentials section. The other seven sections all
# need a running stack, so a new user who runs the full doctor before `carto up`
# sees sixteen failures and concludes their setup is broken, when in fact only
# the first section said anything meaningful. Validating keys BEFORE an
# eight-image build is worth two seconds.
CREDS_ONLY=false
for a in "$@"; do
  case "$a" in
    --creds-only|--creds) CREDS_ONLY=true ;;
    *) printf 'usage: doctor.sh [--creds-only]\n' >&2; exit 2 ;;
  esac
done

head "credentials"
if [[ -f carto.env ]]; then
  set -a; . ./carto.env; set +a
  [[ -n "${DD_API_KEY:-}" ]] && ok "DD_API_KEY present" || bad "DD_API_KEY empty in carto.env"
  [[ -n "${DD_APP_KEY:-}" ]] && ok "DD_APP_KEY present" || bad "DD_APP_KEY empty in carto.env"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "DD-API-KEY: ${DD_API_KEY:-}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY:-}" \
    "https://api.${DD_SITE:-datadoghq.com}/api/v1/validate")
  [[ "$code" == "200" ]] && ok "keys validate against ${DD_SITE:-datadoghq.com}" \
                         || bad "key validation returned HTTP $code"
  # Presence is not validity. A revoked or mistyped key is present, passes a
  # -n test, and then fails on every Joy turn at runtime with nothing in this
  # report to explain it. The Datadog keys are validated against the API here,
  # so this one is too -- /v1/models is the cheapest authenticated GET.
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY empty — Joy runs degraded, no Agent Observability spans"
  else
    acode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      https://api.anthropic.com/v1/models \
      -H "x-api-key: ${ANTHROPIC_API_KEY}" -H "anthropic-version: 2023-06-01" 2>/dev/null)
    case "$acode" in
      200) ok "ANTHROPIC_API_KEY validates (Joy + Agent Observability live)" ;;
      401) bad "ANTHROPIC_API_KEY rejected (HTTP 401) — revoked or mistyped. Joy answers will fail" ;;
      000) warn "could not reach api.anthropic.com to validate the key (network/proxy?)" ;;
      *)   warn "ANTHROPIC_API_KEY check returned HTTP $acode — treat as unverified" ;;
    esac
  fi
else
  bad "carto.env not found"
fi

# Resolved after carto.env so WEB_URL can set it; 5175 is the Compose default,
# 8080 the kind/GKE ingress. An explicit WEB in the environment still wins.
WEB=${WEB:-${WEB_URL:-http://localhost:5175}}

if [[ "$CREDS_ONLY" == true ]]; then
  printf '\n\033[1m%d passed, %d failed, %d warnings\033[0m\n' "$PASS" "$FAIL" "$WARN"
  if [[ "$FAIL" -eq 0 ]]; then
    printf 'credentials look good — now run: ./carto up\n'
  else
    printf 'fix carto.env before building: the keys above are what every other check depends on\n'
  fi
  [[ "$FAIL" -eq 0 ]] || exit 1
  exit 0
fi

head "containers"
# STATUS ALONE IS NOT ENOUGH. A Node process that hits a fatal error while
# dd-trace's debugger is attached lingers without serving anything, so the
# container reports "running" while nginx answers 502 — which is exactly how
# this stack spent three days broken. Check the HEALTH state too, and treat an
# unhealthy-but-running container as a failure.
for c in carto-postgres carto-catalogue carto-checkout carto-fulfilment carto-joy \
         carto-bff carto-web carto-load carto-dd-agent; do
  state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
  if [[ "$state" != "running" ]]; then
    bad "$c is $state"
  elif [[ "$health" == "unhealthy" ]]; then
    bad "$c is running but UNHEALTHY — it is not serving (check: docker logs $c)"
  elif [[ "$health" == "starting" ]]; then
    warn "$c starting (healthcheck has not passed yet)"
  else
    ok "$c running${health:+ ($health)}"
  fi
done
state=$(docker inspect -f '{{.State.Status}}' carto-synthetics-pl 2>/dev/null || echo absent)
case "$state" in
  running)
    ok "carto-synthetics-pl running (synthetics can reach the stack)" ;;
  restarting)
    # The worker is amd64-only. On Apple Silicon it needs emulation, and the
    # binfmt handler does not survive a Docker Desktop restart — so this is the
    # state where every [Carto] synthetic silently stops executing.
    bad "carto-synthetics-pl is CRASH-LOOPING — synthetic tests are NOT running"
    if ! docker run --rm --platform linux/amd64 alpine:3.20 true >/dev/null 2>&1; then
      bad "  cause: amd64 emulation unavailable. Fix: ./carto start (repairs it), or"
      echo "         docker run --privileged --rm tonistiigi/binfmt --install amd64"
    fi ;;
  *)
    warn "carto-synthetics-pl $state — run 'make synthetics-worker' before relying on synthetic tests" ;;
esac

head "endpoints"
for pair in "catalogue:8021" "checkout:8022" "fulfilment:8023" "joy:8024" "storefront:8091"; do
  name=${pair%%:*}; port=${pair##*:}
  if curl -sf --max-time 5 "http://localhost:$port/healthz" >/dev/null; then
    ok "$name /healthz"
  else
    bad "$name /healthz did not answer on :$port"
  fi
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$WEB/")
[[ "$code" == "200" ]] && ok "storefront serving ($WEB)" || bad "storefront returned HTTP $code"
# The full browser path — nginx -> BFF -> catalogue -> Postgres. This is the
# check that fails the way a customer would notice ("no products are loading"),
# rather than the way a container would report it.
prod=$(curl -s --max-time 10 "$WEB/api/products?limit=3" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("count", 0))
except Exception: print(0)' 2>/dev/null || echo 0)
[[ "${prod:-0}" -ge 1 ]] && ok "products load through the storefront proxy ($prod returned)" \
  || bad "NO PRODUCTS through $WEB/api/products — the browser path is broken"
for page in demo-walkthrough.html architecture.html carto-logo.svg; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$WEB/$page")
  [[ "$code" == "200" ]] && ok "$page served" || bad "$page returned HTTP $code"
done

head "data"
cats=$(curl -s --max-time 8 "$BFF/api/categories" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("categories",[])))' 2>/dev/null || echo 0)
[[ "$cats" -ge 8 ]] && ok "$cats categories in the range" || bad "only $cats categories — is the seed loaded?"
nr=$(curl -s --max-time 8 "$BFF/api/new-range" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("%s/%s %s"%(d["count"],d["expected_min"],d["complete"]))' 2>/dev/null || echo "?")
case "$nr" in
  *True) ok "new range complete ($nr)" ;;
  *False) warn "new range INCOMPLETE ($nr) — the content failure is currently engaged" ;;
  *) bad "could not read /api/new-range" ;;
esac

head "tracking ids"
recent=$(curl -s --max-time 8 "$BFF/api/track/recent")
n=$(echo "$recent" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("transactions",[])))' 2>/dev/null || echo 0)
if [[ "$n" -gt 0 ]]; then
  ok "$n recent transactions on the ledger"
  txn=$(echo "$recent" | python3 -c 'import json,sys;print(json.load(sys.stdin)["transactions"][0]["txn_id"])')
  summary=$(curl -s --max-time 8 "$BFF/api/track?q=$txn" | python3 -c '
import json,sys
t=json.load(sys.stdin)["transactions"][0]["summary"]
print("%s %s %s" % (t["hop_count"], t["traced_hops"], t["blackbox_hops"]))' 2>/dev/null || echo "0 0 0")
  read -r hops traced blackbox <<<"$summary"
  [[ "$traced" -ge 5 ]] && ok "$txn: $traced traced hops carry a Datadog trace id" \
                        || bad "$txn: only $traced traced hops — is the ledger being written?"
  [[ "$blackbox" -ge 1 ]] && ok "$txn: $blackbox black-box hops joined by txn_id alone" \
                          || warn "$txn: no black-box hops yet — the fulfilment worker may not have run"
else
  warn "no transactions yet — the load driver needs a minute, or run 'make smoke'"
fi

head "signals reaching Datadog"
if [[ -n "${DD_API_KEY:-}" && -n "${DD_APP_KEY:-}" ]]; then
  H=(-H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY")
  from=$(( $(date +%s) - 900 ))
  mcount=$(curl -s "${H[@]}" "https://api.${DD_SITE:-datadoghq.com}/api/v1/metrics?from=$from" \
    | python3 -c 'import json,sys;print(len([m for m in json.load(sys.stdin).get("metrics",[]) if m.startswith("carto.")]))' 2>/dev/null || echo 0)
  [[ "$mcount" -ge 5 ]] && ok "$mcount carto.* metrics seen in the last 15 min" \
                        || bad "only $mcount carto.* metrics — check the Agent's OTLP receiver"
  lcount=$(curl -s "${H[@]}" -X POST "https://api.${DD_SITE:-datadoghq.com}/api/v2/logs/events/search" \
    -H 'Content-Type: application/json' \
    -d '{"filter":{"query":"service:carto-*","from":"now-15m","to":"now"},"page":{"limit":5}}' \
    | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo 0)
  [[ "$lcount" -gt 0 ]] && ok "logs from carto-* arriving" || bad "no carto-* logs in the last 15 min"
  apm=$(docker exec carto-dd-agent agent status 2>/dev/null | grep -c "APM Agent" || true)
  [[ "${apm:-0}" -gt 0 ]] && ok "Agent APM pipeline up" || warn "could not read the Agent's APM status"
else
  warn "skipping Datadog-side checks (no credentials)"
fi

head "injected conditions"
curl -s --max-time 8 "$BFF/api/demo/state" | python3 -c '
import json,sys
d=json.load(sys.stdin)
dirty=False
for s in d.get("services",[]):
    st=s.get("state") or {}
    # Only the keys that actually ENGAGE something. payment_fail_rate and
    # stall_rate are always 1.0 — they are the rate applied WHEN a target is
    # set, so reporting them as live conditions makes a clean stack look dirty.
    ENGAGING = ("range_publish_broken","search_latency_ms","payment_fail_method",
                "payment_fail_state","peak_latency_ms","stall_stage","wms_error_rate")
    live={k:v for k,v in st.items() if k in ENGAGING and v not in (None,False,0,0.0)}
    if live:
        dirty=True
        print("  ! %s: %s" % (s["service"], json.dumps(live)))
for f in d.get("flags",[]):
    print("    flag %s @ %s%%" % (f["key"], f["rollout"]))
if not dirty: print("  \033[32m✓\033[0m no failure scenarios engaged — clean baseline")
' 2>/dev/null || warn "could not read /api/demo/state"

printf '\n\033[1m%d passed, %d failed, %d warnings\033[0m\n' "$PASS" "$FAIL" "$WARN"
[[ "$FAIL" -eq 0 ]] || exit 1
