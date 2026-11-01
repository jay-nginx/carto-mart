#!/usr/bin/env bash
# ===========================================================================
#  Deploy the harness to Google Kubernetes Engine.
#
#  Everything it needs comes from carto.env. Nothing is hardcoded to one
#  project, region or org, so this is the script a colleague runs unchanged.
#
#  Usage:
#    ./scripts/gke-deploy.sh                 create cluster if needed, build,
#                                            push, deploy
#    ./scripts/gke-deploy.sh --skip-build    deploy only (images already pushed)
#    ./scripts/gke-deploy.sh --dry-run       print the manifests, change nothing
#
#  Topology comes from GKE_TOPOLOGY in carto.env:
#    regional (default)  3 nodes minimum -- --num-nodes is PER ZONE and a region
#                        has three. Uses k8s/overlays/gke.
#    zonal               exactly GKE_NODE_COUNT nodes, default 1. Uses
#                        k8s/overlays/gke-single, which collapses replicas to 1.
#                        The cheapest real cluster; no zone redundancy.
#
#  It will NOT delete anything. Tear down explicitly, with the flag matching the
#  topology you created:
#    gcloud container clusters delete "$GKE_CLUSTER_NAME" --region "$GCP_REGION"
#    gcloud container clusters delete "$GKE_CLUSTER_NAME" --zone   "$GCP_ZONE"
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

SKIP_BUILD=false; DRY_RUN=false
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run)    DRY_RUN=true ;;
    *) die "unknown flag: $a" ;;
  esac
done

[[ -f carto.env ]] || die "carto.env missing — cp carto.env.example carto.env and fill it in"
set -a; . ./carto.env; set +a

# --- preflight: fail with the exact missing variable, not a stack trace ----
missing=()
for v in GCP_PROJECT_ID GCP_REGION GKE_CLUSTER_NAME DD_API_KEY DD_SITE; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
[[ ${#missing[@]} -eq 0 ]] || die "set these in carto.env: ${missing[*]}"
command -v gcloud  >/dev/null || die "gcloud not installed — https://cloud.google.com/sdk/docs/install"
command -v kubectl >/dev/null || die "kubectl not installed"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "not authenticated — run: gcloud auth login"

NS="${K8S_NAMESPACE:-carto}"
REGION="$GCP_REGION"
CLUSTER="$GKE_CLUSTER_NAME"

# --- topology: regional (default) or zonal single-node --------------------
# A REGIONAL cluster spreads nodes over the region's three zones and multiplies
# --num-nodes by three, so its smallest form is three nodes. A ZONAL cluster
# takes --num-nodes literally, so one means one. Everything downstream that
# addresses the cluster has to use the matching flag, which is why this is
# resolved once into LOC_FLAG rather than repeated.
case "${GKE_TOPOLOGY:-regional}" in
  zonal)
    [[ -n "${GCP_ZONE:-}" ]] || die "GKE_TOPOLOGY=zonal needs GCP_ZONE in carto.env (e.g. ${REGION}-a)"
    LOC_FLAG=(--zone "$GCP_ZONE")
    LOC_DESC="zone=$GCP_ZONE"
    NODES="${GKE_NODE_COUNT:-1}"
    TOTAL_NODES="$NODES"
    OVERLAY="gke-single"
    ;;
  regional)
    LOC_FLAG=(--region "$REGION")
    LOC_DESC="region=$REGION"
    NODES="${GKE_NODE_COUNT:-1}"
    TOTAL_NODES="$(( NODES * 3 ))"
    OVERLAY="gke"
    ;;
  *) die "GKE_TOPOLOGY must be 'regional' or 'zonal', got '${GKE_TOPOLOGY}'" ;;
esac
TAG="${IMAGE_TAG:-latest}"
# Default to Artifact Registry in the configured region/project.
REGISTRY="${IMAGE_REGISTRY:-${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/carto}"

info "project=$GCP_PROJECT_ID $LOC_DESC cluster=$CLUSTER"
info "topology=${GKE_TOPOLOGY:-regional} overlay=$OVERLAY nodes=$TOTAL_NODES x ${GKE_MACHINE_TYPE:-e2-standard-4}"
if [[ "${GKE_TOPOLOGY:-regional}" == "zonal" && "$TOTAL_NODES" -gt 1 ]]; then
  warn "GKE_NODE_COUNT=$NODES on a zonal cluster: that is $TOTAL_NODES nodes, not a single-node deploy"
fi
info "registry=$REGISTRY tag=$TAG namespace=$NS"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null 2>&1

IMAGES=(catalogue checkout fulfilment guardrails joy bff web load)

if [[ "$DRY_RUN" == false ]]; then
  # --- APIs -------------------------------------------------------------
  info "enabling required APIs (no-op if already on)"
  gcloud services enable container.googleapis.com artifactregistry.googleapis.com \
    --quiet >/dev/null 2>&1 || warn "could not enable APIs; continuing in case they already are"

  # --- cluster ----------------------------------------------------------
  if ! gcloud container clusters describe "$CLUSTER" "${LOC_FLAG[@]}" >/dev/null 2>&1; then
    info "creating GKE cluster '$CLUSTER' (several minutes)"
    if [[ "${GKE_MODE:-standard}" == "autopilot" ]]; then
      # Autopilot refuses the host mounts and hostPID the Agent DaemonSet
      # needs, so the Agent will not come up as written. Said plainly rather
      # than discovered at 3am.
      warn "GKE_MODE=autopilot: the Datadog Agent DaemonSet needs hostPID and host"
      warn "mounts that Autopilot blocks. Use Standard, or switch to the Datadog"
      warn "Operator/Helm chart which has an Autopilot-compatible mode."
      gcloud container clusters create-auto "$CLUSTER" "${LOC_FLAG[@]}" --quiet
    else
      gcloud container clusters create "$CLUSTER" \
        "${LOC_FLAG[@]}" \
        --num-nodes "$NODES" \
        --machine-type "${GKE_MACHINE_TYPE:-e2-standard-4}" \
        --enable-ip-alias \
        --workload-pool="${GCP_PROJECT_ID}.svc.id.goog" \
        --logging=SYSTEM --monitoring=SYSTEM \
        --quiet
    fi
    ok "cluster created"
  else
    ok "cluster '$CLUSTER' already exists"
  fi

  info "fetching cluster credentials"
  gcloud container clusters get-credentials "$CLUSTER" "${LOC_FLAG[@]}" --quiet
  ok "kubectl context: $(kubectl config current-context)"

  # --- images -----------------------------------------------------------
  if [[ "$SKIP_BUILD" == false ]]; then
    REPO_NAME="$(basename "$REGISTRY")"
    if ! gcloud artifacts repositories describe "$REPO_NAME" --location "$REGION" >/dev/null 2>&1; then
      info "creating Artifact Registry repository '$REPO_NAME'"
      gcloud artifacts repositories create "$REPO_NAME" \
        --repository-format=docker --location "$REGION" --quiet
    fi
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null

    # GKE nodes are amd64. Building on an Apple Silicon laptop without
    # --platform produces arm64 images that will CrashLoopBackOff with "exec
    # format error" — the single most common failure deploying this from a Mac.
    BUILDER="${CONTAINER_CLI:-docker}"

    # The SPA inlines its RUM applicationId and clientToken at BUILD time, so
    # they have to be build args -- there is no runtime config to set later.
    # This builds each service with a plain `build`, not compose, so it does not
    # pick up docker-compose.override.yaml the way the Compose and kind paths
    # do. Without this block the storefront shipped to GKE had RUM_ENABLED
    # false: no RUM, no Session Replay, and no error anywhere to say so.
    #
    # Prefer explicit carto.env values; otherwise read what ./carto rum wrote.
    RUM_APP="${DD_RUM_APPLICATION_ID:-}"
    RUM_TOK="${DD_RUM_CLIENT_TOKEN:-}"
    if [[ -z "$RUM_APP" || -z "$RUM_TOK" ]] && [[ -f docker-compose.override.yaml ]]; then
      RUM_APP="${RUM_APP:-$(sed -n 's/.*VITE_DD_RUM_APPLICATION_ID: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' docker-compose.override.yaml | head -1)}"
      RUM_TOK="${RUM_TOK:-$(sed -n 's/.*VITE_DD_RUM_CLIENT_TOKEN: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' docker-compose.override.yaml | head -1)}"
    fi
    if [[ -n "$RUM_APP" && -n "$RUM_TOK" ]]; then
      ok "RUM app id found — the storefront will ship with RUM + Session Replay"
    else
      warn "no RUM app id/token (carto.env or docker-compose.override.yaml)."
      warn "the storefront will build WITHOUT RUM. Run ./carto rum first to mint one."
    fi

    info "building and pushing linux/amd64 images with $BUILDER"
    for i in "${IMAGES[@]}"; do
      printf '    carto-%s\n' "$i"
      BUILD_ARGS=()
      if [[ "$i" == "web" ]]; then
        BUILD_ARGS=(
          --build-arg "VITE_DD_RUM_APPLICATION_ID=$RUM_APP"
          --build-arg "VITE_DD_RUM_CLIENT_TOKEN=$RUM_TOK"
          --build-arg "VITE_DD_SITE=${DD_SITE}"
          --build-arg "VITE_DD_ENV=${DD_ENV:-prd}"
          --build-arg "VITE_DD_SERVICE=carto-web"
        )
      fi
      "$BUILDER" build --platform linux/amd64 "${BUILD_ARGS[@]}" \
        -t "${REGISTRY}/carto-${i}:${TAG}" "./${i}" >/dev/null
      "$BUILDER" push "${REGISTRY}/carto-${i}:${TAG}" >/dev/null
    done
    ok "images pushed to $REGISTRY"
  else
    ok "skipping build"
  fi
fi

# --- manifests ------------------------------------------------------------
# Point the overlay at the real registry without editing a tracked file.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -R k8s "$TMP/k8s"
# The images: block lives in the gke overlay, and gke-single inherits it, so
# the rewrite targets gke even when deploying gke-single. Pointing this at
# $OVERLAY would write an images: block into gke-single that overrides
# nothing, and the real one would stay on the bare carto-* names.
( cd "$TMP/k8s/overlays/gke"
  for i in "${IMAGES[@]}"; do
    kubectl kustomize --help >/dev/null 2>&1
    python3 - "$i" "$REGISTRY" "$TAG" <<'PY'
import re, sys
img, registry, tag = sys.argv[1], sys.argv[2], sys.argv[3]
p = 'kustomization.yaml'
s = open(p).read()
s = re.sub(r"(- \{ name: carto-%s,\s*)newTag: \S+ \}" % img,
           r"\1newName: %s/carto-%s, newTag: %s }" % (registry, img, tag), s)
open(p, 'w').write(s)
PY
  done )

if [[ "$DRY_RUN" == true ]]; then
  kubectl kustomize "$TMP/k8s/overlays/$OVERLAY"
  exit 0
fi

info "applying manifests"
kubectl apply -k "$TMP/k8s/overlays/$OVERLAY" >/dev/null
ok "manifests applied"

info "creating secrets from carto.env"
kubectl -n "$NS" create secret generic carto-secrets \
  --from-literal=DD_API_KEY="${DD_API_KEY}" \
  --from-literal=DD_APP_KEY="${DD_APP_KEY:-}" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-webapppw}" \
  --from-literal=GUARDRAIL_AGENT_TOKEN="${GUARDRAIL_AGENT_TOKEN:-carto-agent-attestation}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# DD_SITE and the cluster name are the two values the tracked ConfigMap cannot
# know. DD_CLUSTER_NAME ships as "carto-demo"; left alone, Datadog groups this
# cluster under a name that does not match the GKE cluster in the console.
kubectl -n "$NS" patch configmap carto-config --type merge \
  -p "{\"data\":{\"DD_SITE\":\"${DD_SITE}\",\"DD_CLUSTER_NAME\":\"${CLUSTER}\"}}" >/dev/null
kubectl -n "$NS" rollout restart daemonset/datadog-agent >/dev/null 2>&1 || true
ok "secrets in place"

info "waiting for rollouts"
kubectl -n "$NS" rollout status statefulset/postgres --timeout=300s || true
for d in catalogue checkout fulfilment guardrails joy bff web load; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s || true
done

echo
kubectl -n "$NS" get pods
echo
IP="$(kubectl -n "$NS" get ingress carto -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
if [[ -n "$IP" ]]; then
  ok "storefront: http://$IP/"
  # Datadog monitors and dashboards deep-link to WEB_URL. On GKE that is the
  # load balancer, which has no address until now -- so it cannot be set in
  # carto.env ahead of time. Say what to do, rather than leaving every "open
  # the tracking page" link in Datadog pointing at somebody's laptop.
  if [[ "${WEB_URL:-}" != "http://$IP" ]]; then
    warn "WEB_URL in carto.env is '${WEB_URL:-unset}', not http://$IP"
    warn "Datadog monitors and dashboards will deep-link there instead."
    warn "to point them at this cluster:  WEB_URL=http://$IP ./carto assets"
  fi
else
  warn "the GCE load balancer has no IP yet; it takes a few minutes on first apply"
  warn "watch it with: kubectl -n $NS get ingress carto -w"
fi
