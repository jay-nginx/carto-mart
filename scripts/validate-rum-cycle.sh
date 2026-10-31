#!/usr/bin/env bash
# ===========================================================================
# validate-rum-cycle.sh — prove, end to end, that a triggered failure shows up
# in Datadog RUM and that a clean run does not.
#
#   ./scripts/creds-from-env.sh ./scripts/validate-rum-cycle.sh [cycles]
#
# Each cycle walks Raj Patel's journey three times in a REAL browser (Chromium
# inside the load container, running the actual RUM SDK — driving the API with
# curl would prove the backend and nothing about RUM):
#
#   a. failure armed for CT-CUST-9001  -> expect a failed checkout
#   b. failure cleared                 -> expect a clean checkout
#   c. failure armed again             -> expect a failed checkout
#
# Then it asks Datadog, per run and keyed on that run's own txn_id, whether a
# RUM error and backend error logs exist — and asserts they exist for (a) and
# (c) and do NOT exist for (b). Anything else is a FAIL.
#
# Run it before a demo. It takes about a minute per cycle.
# ===========================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

CYCLES="${1:-3}"
BFF="${BFF:-http://localhost:8091}"
CUSTOMER="${CUSTOMER:-CT-CUST-9001}"
RESULTS="$(mktemp -t carto-rum-runs).jsonl"

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker inspect carto-load >/dev/null 2>&1 || { echo "carto-load is not running — make up"; exit 1; }

# The journey script lives in the repo; ship it into the container each run so
# the two can never drift.
docker exec -i carto-load sh -c 'cat > /home/pptruser/raj-journey.js' < scripts/raj-journey.js

run() {  # run <label> <expect: fail|pass>
  local label="$1" expect="$2" out
  out=$(docker exec -w /home/pptruser carto-load node raj-journey.js "expect-$expect" 2>/dev/null)
  if [[ -z "$out" ]]; then
    echo "    $label: journey produced no output" >&2
    echo '{"label":"'"$label"'","expected":"'"$expect"'","outcome":"no-output"}' >> "$RESULTS"
    return
  fi
  python3 -c "
import json,sys
d=json.loads(sys.argv[1]); d['label']=sys.argv[2]; d['expected']=sys.argv[3]
print(json.dumps(d))" "$out" "$label" "$expect" >> "$RESULTS"
  python3 -c "
import json,sys
d=json.loads(sys.argv[1])
want='paid' if sys.argv[2]=='pass' else 'failed'
print('    %-22s outcome=%-7s %s  session=%s txn=%s' % (sys.argv[3], d['outcome'],
  'ok' if d['outcome']==want else 'MISMATCH', (d.get('sessionId') or '-')[:8], d.get('txnId') or '-'))" \
  "$out" "$expect" "$label"
}

: > "$RESULTS"
for c in $(seq 1 "$CYCLES"); do
  printf '\n\033[1mcycle %s/%s\033[0m\n' "$c" "$CYCLES"
  curl -s "$BFF/api/demo/user-break?customer=$CUSTOMER" >/dev/null; run "c${c}a-armed" fail
  curl -s "$BFF/api/demo/user-fix?customer=$CUSTOMER"   >/dev/null; run "c${c}b-clean" pass
  curl -s "$BFF/api/demo/user-break?customer=$CUSTOMER" >/dev/null; run "c${c}c-armed" fail
done
curl -s "$BFF/api/demo/user-fix?customer=$CUSTOMER" >/dev/null

printf '\n\033[1mwaiting 30s for RUM + log indexing\033[0m\n'
sleep 30

RESULTS="$RESULTS" python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

site = os.getenv("DD_SITE", "datadoghq.com")
H = {"DD-API-KEY": os.environ.get("DD_API_KEY", ""),
     "DD-APPLICATION-KEY": os.environ.get("DD_APP_KEY", ""),
     "Content-Type": "application/json"}
if not H["DD-API-KEY"] or not H["DD-APPLICATION-KEY"]:
    sys.exit("DD_API_KEY / DD_APP_KEY not set — run via ./scripts/creds-from-env.sh")

def post(path, body):
    r = urllib.request.Request("https://api.%s%s" % (site, path),
                               data=json.dumps(body).encode(), method="POST")
    for k, v in H.items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        sys.exit("%s -> %s %s" % (path, e.code, e.read().decode()[:300]))

runs = [json.loads(l) for l in open(os.environ["RESULTS"])]
print("%-22s %-8s %-24s %-11s %-11s %-9s %s"
      % ("RUN", "OUTCOME", "TXN_ID", "RUM ERRORS", "LOG ERRORS", "SESSION", "VERDICT"))
failures = 0
for r in runs:
    txn = r.get("txnId")
    want_err = r["expected"] == "fail"
    if not txn:
        print("%-22s %-8s %s" % (r["label"], r.get("outcome"), "NO TXN ID — FAIL"))
        failures += 1
        continue
    rum = post("/api/v2/rum/events/search",
               {"filter": {"query": "@type:error @context.txn_id:%s" % txn,
                           "from": "now-60m", "to": "now"},
                "page": {"limit": 10}}).get("data", [])
    logs = post("/api/v2/logs/events/search",
                {"filter": {"query": "@txn_id:%s status:error" % txn,
                            "from": "now-60m", "to": "now"},
                 "page": {"limit": 10}}).get("data", [])
    outcome_ok = r.get("outcome") == ("failed" if want_err else "paid")
    ok = outcome_ok and (len(rum) > 0) == want_err and (len(logs) > 0) == want_err
    if not ok:
        failures += 1
    print("%-22s %-8s %-24s %-11s %-11s %-9s %s"
          % (r["label"], r.get("outcome"), txn, len(rum), len(logs),
             (r.get("sessionId") or "-")[:8], "PASS" if ok else "FAIL"))

sessions = [r.get("sessionId") for r in runs if r.get("sessionId")]
unique = len(set(sessions))
print()
print("distinct RUM sessions across %d runs: %d %s"
      % (len(sessions), unique,
         "(one per run, as intended)" if unique == len(sessions) else "(RUNS SHARED A SESSION)"))
if unique != len(sessions):
    failures += 1
print("\n%s" % ("ALL RUNS AS EXPECTED" if failures == 0 else "%d RUN(S) FAILED" % failures))
sys.exit(1 if failures else 0)
PY
