#!/usr/bin/env bash
# ===========================================================================
#  Bring the harness up on a local Kubernetes cluster running inside Podman.
#
#  Why kind and not `podman kube play`: the manifests are written for GKE and
#  use Deployments, Services, an Ingress and probes. `podman kube play` ignores
#  most of that, so a green local run would tell you nothing about whether GKE
#  works. kind runs a real kubelet and a real API server.
#
#  Usage:  ./scripts/kind-up.sh [--rebuild]
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${KIND_CLUSTER_NAME:-carto}"
NS="${K8S_NAMESPACE:-carto}"
export KIND_EXPERIMENTAL_PROVIDER=podman
export PATH="/opt/podman/bin:$PATH"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v kind    >/dev/null || die "kind not installed — brew install kind"
command -v kubectl >/dev/null || die "kubectl not installed — brew install kubectl"
[[ -f carto.env ]] || die "carto.env missing — cp carto.env.example carto.env and fill it in"
set -a; . ./carto.env; set +a
[[ -n "${DD_API_KEY:-}" ]] || die "DD_API_KEY is empty in carto.env"

# --- the cluster ----------------------------------------------------------
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  info "creating kind cluster '$CLUSTER' on podman"
  # extraPortMappings publish the ingress to the host; without them the
  # storefront is only reachable via kubectl port-forward.
  cat <<'YAML' | kind create cluster --name "$CLUSTER" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - { containerPort: 80,  hostPort: 8080, protocol: TCP }
      - { containerPort: 443, hostPort: 8443, protocol: TCP }
YAML
  ok "cluster created"
else
  ok "cluster '$CLUSTER' already exists"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

# --- ingress controller ---------------------------------------------------
if ! kubectl get ns ingress-nginx >/dev/null 2>&1; then
  info "installing ingress-nginx"
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml >/dev/null
  # `kubectl wait` fails with "no matching resources found" if it runs before
  # the controller Deployment exists, so wait for the object to appear first
  # and only then for it to become available. Without this the script printed
  # that error and then claimed success anyway.
  for _ in $(seq 1 30); do
    kubectl -n ingress-nginx get deploy ingress-nginx-controller >/dev/null 2>&1 && break
    sleep 2
  done
  if kubectl -n ingress-nginx wait --for=condition=available \
       deploy/ingress-nginx-controller --timeout=180s >/dev/null 2>&1; then
    ok "ingress-nginx ready"
  else
    warn "ingress-nginx did not become available in 180s; the storefront may not"
    warn "be reachable on localhost:8080 yet (kubectl -n ingress-nginx get pods)"
  fi
else
  ok "ingress-nginx already installed"
fi

# --- images ---------------------------------------------------------------
# kind cannot pull carto-* from anywhere: they only exist in the local Podman
# store, so they are built here and side-loaded into the node.
IMAGES=(catalogue checkout fulfilment guardrails joy bff web load)
if [[ "${1:-}" == "--rebuild" ]] || ! podman image exists carto-bff 2>/dev/null; then
  info "building images with compose"
  # docker-compose.override.yaml carries the RUM applicationId and clientToken
  # as Vite build args, which get inlined into the SPA bundle at build time.
  # Leaving it out built a storefront with RUM_ENABLED false -- no RUM and no
  # Session Replay on the cluster, silently, because the SPA just does not call
  # datadogRum.init() when the app id is empty.
  KCF="compose.yaml:docker-compose.podman.yaml"
  if [[ -f docker-compose.override.yaml ]]; then
    KCF="compose.yaml:docker-compose.override.yaml:docker-compose.podman.yaml"
  else
    warn "no docker-compose.override.yaml — the storefront will build WITHOUT RUM."
    warn "run ./carto rum first if you want RUM and Session Replay on the cluster."
  fi
  COMPOSE_FILE="$KCF" \
    /usr/local/bin/docker-compose build "${IMAGES[@]}" >/dev/null
  ok "images built"
fi
for i in "${IMAGES[@]}"; do
  podman image exists "carto-$i" || die "image carto-$i missing; run with --rebuild"
done
info "side-loading ${#IMAGES[@]} images into the cluster (this is the slow part)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# The Deployments reference the bare name `carto-<svc>:latest`, which the
# kubelet resolves to docker.io/library/carto-<svc>:latest. Podman, though,
# stores a locally built `carto-<svc>` under localhost/. Saving the short name
# can therefore produce an archive tagged localhost/... which loads fine and is
# then ignored, leaving the pod on a stale image with no error anywhere. Tag to
# the fully qualified name the kubelet will actually ask for before saving.
for i in "${IMAGES[@]}"; do
  podman tag "carto-$i:latest" "docker.io/library/carto-$i:latest" 2>/dev/null || true
  podman save -o "$TMP/$i.tar" "docker.io/library/carto-$i:latest"
  kind load image-archive "$TMP/$i.tar" --name "$CLUSTER" >/dev/null 2>&1
  rm -f "$TMP/$i.tar"
  printf '    loaded carto-%s\n' "$i"
done
ok "images loaded"

# --- manifests ------------------------------------------------------------
info "applying k8s/overlays/kind"
kubectl apply -k k8s/overlays/kind >/dev/null
ok "manifests applied"

# The Secret is created from carto.env rather than committed, so no credential
# ever lands in git. --dry-run|apply makes it idempotent.
info "creating secrets from carto.env"
kubectl -n "$NS" create secret generic carto-secrets \
  --from-literal=DD_API_KEY="${DD_API_KEY:-}" \
  --from-literal=DD_APP_KEY="${DD_APP_KEY:-}" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-webapppw}" \
  --from-literal=GUARDRAIL_AGENT_TOKEN="${GUARDRAIL_AGENT_TOKEN:-carto-agent-attestation}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# The Agent and the apps read the key at start, so they need a restart if the
# Secret changed after they were created.
kubectl -n "$NS" rollout restart daemonset/datadog-agent >/dev/null 2>&1 || true
ok "secrets in place"

info "waiting for rollouts (postgres first; the apps block on it)"
kubectl -n "$NS" rollout status statefulset/postgres --timeout=240s || true
for d in catalogue checkout fulfilment guardrails joy bff web load; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=240s || true
done

echo
kubectl -n "$NS" get pods -o wide
echo
ok "storefront:    http://localhost:8080/"
ok "demo flow:     http://localhost:8080/demo-walkthrough.html"
ok "architecture:  http://localhost:8080/architecture.html"
ok "AI guardrails: http://localhost:8080/guardrails"
echo
info "tear down with: kind delete cluster --name $CLUSTER"
