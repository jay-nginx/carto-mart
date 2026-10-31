#!/usr/bin/env bash
# common/ is the single source of truth for the shared Python modules. Compose
# builds each service from its own directory, so the files are copied in rather
# than mounted. Run this after editing anything under common/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for svc in catalogue checkout fulfilment joy guardrails; do
  cp "$HERE"/common/*.py "$HERE/$svc/"
  echo "synced common/ -> $svc/"
done
