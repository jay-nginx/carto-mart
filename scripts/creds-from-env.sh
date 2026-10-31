#!/usr/bin/env bash
# creds-from-env.sh — exec a command with carto.env sourced into the env.
#
# Plain-keys alternative to scripts/dev/with-dd-creds.sh — no 1Password,
# no keychain, just `set -a; . carto.env; set +a` then exec the command.
# Used when carto.env contains literal DD_API_KEY / DD_APP_KEY / DD_SITE
# values instead of op:// references.
#
# carto.env stays gitignored — do not commit literal keys.

set -euo pipefail

OP_ENV="${OP_ENV:-carto.env}"

if [[ ! -f "$OP_ENV" ]]; then
  echo "[creds-from-env] $OP_ENV not found in $(pwd)" >&2
  echo "[creds-from-env] copy carto.env.example to carto.env and fill in your keys" >&2
  exit 1
fi

# Export every var defined in carto.env into the environment. `set -a`
# auto-exports anything assigned; `.` (source) reads the file as shell.
# Comments and blank lines are ignored by the shell parser.
set -a
# shellcheck disable=SC1090
. "$OP_ENV"
set +a

if [[ -z "${DD_API_KEY:-}" ]]; then
  echo "[creds-from-env] DD_API_KEY not set after sourcing $OP_ENV" >&2
  echo "[creds-from-env] check that carto.env has DD_API_KEY=<your-key> (no quotes around op://-style refs)" >&2
  exit 1
fi

# Reject leftover op:// refs — those need the op CLI which this wrapper
# explicitly avoids. Tell the user clearly.
case "$DD_API_KEY" in
  op://*)
    echo "[creds-from-env] DD_API_KEY in $OP_ENV is still an op:// reference." >&2
    echo "[creds-from-env] either replace with literal keys (this wrapper) or use scripts/dev/with-dd-creds.sh (op CLI)." >&2
    exit 1 ;;
esac

exec "$@"
