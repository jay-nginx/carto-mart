#!/usr/bin/env bash
# smoke.sh — drive one complete transaction through the API and print the
# ledger it produced. No Datadog credentials needed; this is the request-path
# check, and it is also the fastest way to seed the tracking page with a
# transaction you can talk to.
set -euo pipefail
cd "$(dirname "$0")/.."
BFF=${BFF:-http://localhost:8091}
# Storefront host port is deployment-specific: 5175 under Compose, 8080 via the
# kind/GKE ingress. WEB_URL from carto.env wins when it is set.
export WEB=${WEB:-${WEB_URL:-http://localhost:5175}}
USER_NAME=${USER_NAME:-alice}
METHOD=${METHOD:-HOME_DELIVERY}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. sign in as $USER_NAME"
LOGIN=$(curl -sf -X POST "$BFF/api/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER_NAME\",\"password\":\"${CARTO_DEMO_PASSWORD:-demo}\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
CUSTOMER=$(echo "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["customer"]["customer_id"])')
echo "   customer_id=$CUSTOMER"

say "2. add two products to the bag"
for sku in 43210003 43290001; do
  curl -sf -X POST "$BFF/api/bag" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "{\"sku\":\"$sku\",\"qty\":1}" >/dev/null
  echo "   added $sku"
done

say "3. check out ($METHOD)"
OUT=$(curl -s -X POST "$BFF/api/checkout" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"fulfilment_method\":\"$METHOD\"}")
echo "$OUT" | python3 -m json.tool
TXN=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("txn_id",""))')

say "4. wait for the black-box fulfilment worker to advance a stage"
sleep 16

say "5. reassemble the transaction from its txn_id"
curl -s "$BFF/api/track?q=$TXN" | python3 -c '
import json,os,sys
t=json.load(sys.stdin)["transactions"][0]
s=t["summary"]
print("txn_id     %s" % t["txn_id"])
print("order_id   %s" % (t["order"] or {}).get("order_id"))
print("coverage   Datadog sees %s of %s hops (%s%%)"
      % (s["traced_hops"], s["hop_count"], s["datadog_coverage_pct"]))
print()
print("%-3s %-28s %-22s %-9s %-7s %s" % ("hop","name","service","system","status","ref / trace"))
for h in t["hops"]:
    ref = h["external_ref"] or (("trace " + h["dd_trace_id"]) if h["dd_trace_id"] else "-")
    print("%-3s %-28s %-22s %-9s %-7s %s"
          % (h["hop"], h["hop_name"], h["service"], h["system"], h["status"], ref))
print()
print("open in Datadog:")
for k, v in t["datadog"].items(): print("  %-16s %s" % (k, v))
print()
print("open in the app:  %s/track?q=%s" % (os.environ["WEB"], t["txn_id"]))
'
