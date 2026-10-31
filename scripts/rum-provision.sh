#!/usr/bin/env bash
# rum-provision.sh — mint a Datadog RUM application + client token via the
# DD API, then emit the resulting applicationId + clientToken into one of
# several output formats: a docker-compose override (default, used by the
# SPA build), an Apple xcconfig, or a flat KEY=VALUE .env file.
#
# Designed for non-interactive invocation. Either:
#
#   # Mode 5 (Keychain bridge — no biometric):
#   eval "$(./scripts/dev/dd-creds-keychain.sh export --org <name>)"
#   ./scripts/rum-provision.sh <harness-path>
#
#   # Mode 1/2 (op run):
#   op run --env-file=harnesses/<name>/carto.env -- ./scripts/rum-provision.sh harnesses/<name>
#
# All inputs come from env vars; no flags. Idempotent — re-running will
# reuse an existing app of the same name if one is found. The
# (name, type) pair distinguishes apps: a "carto" browser
# app and a "carto-ios" ios app are separate, and the
# operator owns the naming convention.
#
# Required env (provided by either Mode 5 export or `op run`):
#   DD_API_KEY     — DD API key
#   DD_APP_KEY     — DD app key (RUM creation requires both)
#   DD_SITE        — DD intake FQDN (datadoghq.com, us3.datadoghq.com, ...)
#
# Optional env:
#   RUM_APP_NAME   — name of the RUM application (default: harness dirname)
#   RUM_APP_TYPE   — "browser" | "ios" | "android" | "react-native"
#                    | "flutter" | "kotlin-multiplatform" | "roku" | "electron"
#                    | "unity" (default: browser)
#   ENABLE_PA      — "true" to also enable Product Analytics on the new
#                    RUM app (default: true)
#
#   RUM_OUTPUT_FORMAT   — "compose" (default) | "xcconfig" | "env"
#                         compose: writes docker-compose.override.yaml with
#                                  services.web.build.args.VITE_DD_RUM_*
#                         xcconfig: writes Apple build-config file with
#                                   RUM_APPLICATION_ID = <id> lines
#                         env: writes flat KEY=VALUE .env file
#   RUM_OUTPUT_PATH     — file path to write to. Required when format is
#                         xcconfig or env. Defaults to
#                         <harness>/docker-compose.override.yaml when
#                         format is compose.
#   RUM_REBUILD_TARGET  — optional compose service name to `docker compose
#                         build` + `up -d --force-recreate` after writing
#                         the output file. Default: "web" when format is
#                         compose (backward-compatible), empty otherwise
#                         (skip rebuild).
#   RUM_OUTPUT_ID_KEY   — name of the applicationId key in the output file.
#                         Default: VITE_DD_RUM_APPLICATION_ID for compose,
#                         RUM_APPLICATION_ID for xcconfig/env.
#   RUM_OUTPUT_TOKEN_KEY — name of the clientToken key. Default:
#                         VITE_DD_RUM_CLIENT_TOKEN for compose,
#                         RUM_CLIENT_TOKEN for xcconfig/env.
#   RUM_PROVISION_DRY_RUN — "1" to skip both the API calls and the file
#                           write; instead print what would be written.
#                           Useful for shape verification.

set -euo pipefail

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
info()   { printf '%s\n' "$*" >&2; }

HARNESS_DIR="${1:-}"
if [[ -z "$HARNESS_DIR" ]]; then
  red "usage: $0 <harness-path>"
  exit 2
fi
if [[ ! -d "$HARNESS_DIR" ]]; then
  red "harness directory not found: $HARNESS_DIR"
  exit 2
fi
HARNESS_DIR="$(cd "$HARNESS_DIR" && pwd)"
HARNESS_NAME="$(basename "$HARNESS_DIR")"
RUM_APP_NAME="${RUM_APP_NAME:-${HARNESS_NAME}}"
RUM_APP_TYPE="${RUM_APP_TYPE:-browser}"
ENABLE_PA="${ENABLE_PA:-true}"

RUM_OUTPUT_FORMAT="${RUM_OUTPUT_FORMAT:-compose}"
RUM_PROVISION_DRY_RUN="${RUM_PROVISION_DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# format-specific defaults: output path, key names, rebuild target
# ---------------------------------------------------------------------------

case "$RUM_OUTPUT_FORMAT" in
  compose)
    RUM_OUTPUT_PATH="${RUM_OUTPUT_PATH:-$HARNESS_DIR/docker-compose.override.yaml}"
    RUM_OUTPUT_ID_KEY="${RUM_OUTPUT_ID_KEY:-VITE_DD_RUM_APPLICATION_ID}"
    RUM_OUTPUT_TOKEN_KEY="${RUM_OUTPUT_TOKEN_KEY:-VITE_DD_RUM_CLIENT_TOKEN}"
    RUM_REBUILD_TARGET="${RUM_REBUILD_TARGET-web}"
    ;;
  xcconfig|env)
    if [[ -z "${RUM_OUTPUT_PATH:-}" ]]; then
      red "RUM_OUTPUT_PATH is required when RUM_OUTPUT_FORMAT=$RUM_OUTPUT_FORMAT"
      exit 2
    fi
    RUM_OUTPUT_ID_KEY="${RUM_OUTPUT_ID_KEY:-RUM_APPLICATION_ID}"
    RUM_OUTPUT_TOKEN_KEY="${RUM_OUTPUT_TOKEN_KEY:-RUM_CLIENT_TOKEN}"
    RUM_REBUILD_TARGET="${RUM_REBUILD_TARGET:-}"
    ;;
  *)
    red "unsupported RUM_OUTPUT_FORMAT='$RUM_OUTPUT_FORMAT' (expected: compose|xcconfig|env)"
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# preflight (skipped on dry-run so shape checks don't need real creds)
# ---------------------------------------------------------------------------

if [[ "$RUM_PROVISION_DRY_RUN" != "1" ]]; then
  for var in DD_API_KEY DD_APP_KEY DD_SITE; do
    if [[ -z "${!var:-}" ]]; then
      red "$var not set in env. Activate Mode 5 first:"
      yellow "  eval \"\$(./scripts/dev/dd-creds-keychain.sh export --org <name>)\""
      exit 1
    fi
  done

  if ! command -v jq >/dev/null 2>&1; then
    red "jq not found. brew install jq"
    exit 1
  fi

  API_BASE="https://api.${DD_SITE}"
  DD_HEADERS=(
    -H "DD-API-KEY: $DD_API_KEY"
    -H "DD-APPLICATION-KEY: $DD_APP_KEY"
    -H "Content-Type: application/json"
  )

  # -------------------------------------------------------------------------
  # look up existing RUM app by name + type (idempotency)
  # -------------------------------------------------------------------------

  info "[rum] looking for existing RUM application '$RUM_APP_NAME' (type=$RUM_APP_TYPE) on $DD_SITE..."
  existing=$(curl -fsS "${DD_HEADERS[@]}" "$API_BASE/api/v2/rum/applications" \
    | jq -r --arg name "$RUM_APP_NAME" --arg type "$RUM_APP_TYPE" \
        '.data[] | select(.attributes.name == $name and .attributes.type == $type) | .id' \
    | head -1)

  if [[ -n "$existing" ]]; then
    yellow "[rum] reusing existing RUM application id=$existing (name='$RUM_APP_NAME', type=$RUM_APP_TYPE)"
    app_id="$existing"
    app_payload=$(curl -fsS "${DD_HEADERS[@]}" "$API_BASE/api/v2/rum/applications/$app_id")
  else
    info "[rum] creating new RUM application '$RUM_APP_NAME' (type=$RUM_APP_TYPE)"
    app_payload=$(curl -fsS "${DD_HEADERS[@]}" -X POST "$API_BASE/api/v2/rum/applications" -d "$(jq -n \
      --arg name "$RUM_APP_NAME" \
      --arg type "$RUM_APP_TYPE" \
      '{data: {type: "rum_application_create", attributes: {name: $name, type: $type}}}')")
    app_id=$(echo "$app_payload" | jq -r '.data.id')
    green "[rum] created applicationId=$app_id"
  fi

  client_token=$(echo "$app_payload" | jq -r '.data.attributes.client_token // empty')
  if [[ -z "$client_token" ]]; then
    red "[rum] response missing client_token. Raw payload:"
    echo "$app_payload" | jq . >&2 || true
    exit 1
  fi

  green "[rum] applicationId=$app_id"
  green "[rum] clientToken=${client_token:0:8}…(redacted)"

  # -------------------------------------------------------------------------
  # enable Product Analytics on the application
  # -------------------------------------------------------------------------

  if [[ "$ENABLE_PA" == "true" ]]; then
    info "[rum] enabling Product Analytics on application $app_id..."
    if curl -fsS "${DD_HEADERS[@]}" -X PATCH \
        "$API_BASE/api/v2/rum/applications/$app_id" \
        -d "$(jq -n --arg id "$app_id" \
              '{data: {type: "rum_application_update", id: $id, attributes: {product_analytics_retention_state: "MAX"}}}')" \
        >/dev/null 2>&1; then
      green "[rum] Product Analytics enabled (retention=MAX)"
    else
      yellow "[rum] Product Analytics enable PATCH failed; attribute may"
      yellow "      need to be toggled in the DD UI under RUM > Product Analytics."
      yellow "      Application id is $app_id."
    fi
  fi
else
  yellow "[rum] DRY-RUN: skipping API calls; using synthetic ids for shape preview"
  app_id="${RUM_DRY_RUN_APP_ID:-00000000-0000-0000-0000-000000000000}"
  client_token="${RUM_DRY_RUN_CLIENT_TOKEN:-pubXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX}"
fi

# ---------------------------------------------------------------------------
# render the output file in the requested format
# ---------------------------------------------------------------------------

# render_<format> functions write the file body to stdout; the dispatcher
# either writes it to RUM_OUTPUT_PATH or, on dry-run, prints it.

render_compose() {
  cat <<EOF
# Generated by scripts/rum-provision.sh — do not edit by hand.
# Pins the SPA's RUM applicationId + clientToken into Vite build args
# so they're inlined into the static bundle. Rerun rum-provision.sh to
# refresh; \`make nuke\` removes this file.
services:
  web:
    build:
      args:
        ${RUM_OUTPUT_ID_KEY}: "${app_id}"
        ${RUM_OUTPUT_TOKEN_KEY}: "${client_token}"
EOF
}

render_xcconfig() {
  # NOTE: xcconfig treats // as a comment delimiter inside values, so a
  # value like `BFF_URL = http://localhost` truncates at the //. The
  # applicationId/clientToken below contain no slashes, so they're safe.
  # If a future caller ever needs to emit a URL through this format, the
  # escape is to break the // with $() empty substitution, e.g.
  #   BFF_URL = http:$()//localhost
  cat <<EOF
// Generated by scripts/rum-provision.sh — do not edit by hand.
// Pins the RUM applicationId + clientToken for an Apple build target.
${RUM_OUTPUT_ID_KEY} = ${app_id}
${RUM_OUTPUT_TOKEN_KEY} = ${client_token}
EOF
}

render_env() {
  cat <<EOF
# Generated by scripts/rum-provision.sh — do not edit by hand.
${RUM_OUTPUT_ID_KEY}=${app_id}
${RUM_OUTPUT_TOKEN_KEY}=${client_token}
EOF
}

if [[ "$RUM_PROVISION_DRY_RUN" == "1" ]]; then
  yellow "[rum] DRY-RUN: would write to $RUM_OUTPUT_PATH (format=$RUM_OUTPUT_FORMAT):"
  printf -- '----- begin %s -----\n' "$RUM_OUTPUT_FORMAT"
  case "$RUM_OUTPUT_FORMAT" in
    compose)  render_compose ;;
    xcconfig) render_xcconfig ;;
    env)      render_env ;;
  esac
  printf -- '----- end %s -----\n' "$RUM_OUTPUT_FORMAT"
  yellow "[rum] DRY-RUN: skipping rebuild target='${RUM_REBUILD_TARGET:-<none>}'"
  exit 0
fi

info "[rum] writing $RUM_OUTPUT_PATH (format=$RUM_OUTPUT_FORMAT)"
case "$RUM_OUTPUT_FORMAT" in
  compose)  render_compose  > "$RUM_OUTPUT_PATH" ;;
  xcconfig) render_xcconfig > "$RUM_OUTPUT_PATH" ;;
  env)      render_env      > "$RUM_OUTPUT_PATH" ;;
esac

# ---------------------------------------------------------------------------
# record this artifact in the harness's dd-artifacts.json manifest so
# scripts/dd-cleanup.sh knows to (potentially) delete it later. RUM apps
# default to lifecycle=long_lived per dd-record.sh, which means
# `make dd-clean` skips them — every built client has the applicationId
# baked in, so deleting the RUM app would orphan all of them. Operator
# can opt in via `make dd-clean-rum` (--include rum_application).
# ---------------------------------------------------------------------------

# dd-record.sh is part of the multi-harness tooling and is NOT shipped with
# this standalone harness. When it is absent we simply skip the manifest
# update — nothing downstream in Carto reads dd-artifacts.json.
DD_RECORD="$(dirname "$0")/dd-record.sh"
if [[ -x "$DD_RECORD" ]]; then
  # Pass type=rum_application_<RUM_APP_TYPE> so dd-cleanup can dispatch
  # to per-platform handlers if they ever diverge. The default handler
  # treats all rum_application* as the same DELETE call.
  CALLER="rum-provision.sh" \
    "$DD_RECORD" "$HARNESS_DIR" "rum_application_${RUM_APP_TYPE}" "$app_id" "$RUM_APP_NAME" "long_lived" \
    || yellow "[rum] dd-record.sh failed; manifest may be out of sync. dd-cleanup --backfill recovers."
else
  info "[rum] dd-record.sh not present (standalone harness) — skipping artifact manifest update."
fi

# ---------------------------------------------------------------------------
# always write a backend-agnostic rum-args.env alongside the format-specific
# output so k8s/aws-eks consumers (Makefile redeploy targets, kustomize patch
# scripts, etc.) can read the RUM applicationId + clientToken without parsing
# yaml/xcconfig. Compose harnesses can also read this if they prefer, though
# the docker-compose.override.yaml is what `docker compose` itself consumes.
# ---------------------------------------------------------------------------

RUM_ARGS_ENV="$HARNESS_DIR/rum-args.env"
cat > "$RUM_ARGS_ENV" <<EOF
# Generated by scripts/rum-provision.sh — do not edit by hand.
# RUM applicationId + clientToken for harness '$HARNESS_NAME', app type '$RUM_APP_TYPE'.
# Read by per-backend redeploy targets so the SPA bundle gets baked with these
# Vite build args. Compose harnesses also use docker-compose.override.yaml.
VITE_DD_RUM_APPLICATION_ID=$app_id
VITE_DD_RUM_CLIENT_TOKEN=$client_token
VITE_DD_SITE=${DD_SITE:-datadoghq.com}
RUM_APPLICATION_ID=$app_id
RUM_CLIENT_TOKEN=$client_token
RUM_APP_NAME=$RUM_APP_NAME
RUM_APP_TYPE=$RUM_APP_TYPE
EOF
info "[rum] wrote $RUM_ARGS_ENV (backend-agnostic)"

# ---------------------------------------------------------------------------
# detect harness backend so the rebuild step picks the right path. The
# .harness-meta.yaml is emitted by assemble.py and pinned per harness.
# ---------------------------------------------------------------------------

HARNESS_BACKEND=""
META="$HARNESS_DIR/.harness-meta.yaml"
if [[ -f "$META" ]]; then
  HARNESS_BACKEND="$(awk -F': *' '$1=="backend"{print $2; exit}' "$META" 2>/dev/null || true)"
fi

# ---------------------------------------------------------------------------
# rebuild + recreate so the new ids take effect, dispatched by backend
# ---------------------------------------------------------------------------

case "$HARNESS_BACKEND" in
  ""|compose-on-colima|compose|container)
    if [[ -n "${RUM_REBUILD_TARGET:-}" ]]; then
      info "[rum] rebuilding compose service '$RUM_REBUILD_TARGET' with new RUM args..."
      ( cd "$HARNESS_DIR" && docker compose build "$RUM_REBUILD_TARGET" ) >&2

      info "[rum] recreating '$RUM_REBUILD_TARGET' container..."
      ( cd "$HARNESS_DIR" && docker compose up -d --force-recreate "$RUM_REBUILD_TARGET" ) >&2
    fi
    ;;
  k8s-on-lima-k3s)
    yellow "[rum] backend=k8s-on-lima-k3s — skipping compose rebuild (won't work here)."
    yellow "[rum] Next step to apply the new RUM ids:"
    yellow "  cd $HARNESS_DIR && make redeploy-spa-rum   # rebuild image + import to k3s + restart spa Deployment"
    yellow "[rum] Or, if 'make redeploy-spa-rum' isn't defined yet (older harness):"
    yellow "  cd $HARNESS_DIR/spa && docker build --build-arg VITE_DD_RUM_APPLICATION_ID=$app_id \\"
    yellow "    --build-arg VITE_DD_RUM_CLIENT_TOKEN=$client_token -t spa:rum . && \\"
    yellow "  limactl shell <vm> -- ctr -n k8s.io images import - < <(docker save spa:rum) && \\"
    yellow "  kubectl rollout restart deployment/spa"
    ;;
  aws-eks)
    yellow "[rum] backend=aws-eks — skipping compose rebuild (won't work here)."
    yellow "[rum] Next step to apply the new RUM ids:"
    yellow "  cd $HARNESS_DIR && make redeploy-spa-rum   # rebuild image + push to ECR + restart spa Deployment"
    yellow "[rum] The rum-args.env file at $RUM_ARGS_ENV is what 'make redeploy-spa-rum' will read."
    ;;
  *)
    yellow "[rum] unknown backend='$HARNESS_BACKEND' — skipping rebuild. Operator must rebuild the SPA bundle manually with the args from $RUM_ARGS_ENV."
    ;;
esac

green "[rum] done. RUM app '$RUM_APP_NAME' (type=$RUM_APP_TYPE) provisioned."
if [[ -n "${DD_SITE:-}" ]]; then
  green "[rum] Open: https://app.${DD_SITE}/rum/application/$app_id"
fi
