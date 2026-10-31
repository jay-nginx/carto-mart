# Source this to point the harness at Podman instead of Docker Desktop:
#   . ./scripts/podman-env.sh && ./km up
#
# Sets three things:
#   1. the shim dir first on PATH, so `docker compose` resolves (see the shim)
#   2. /opt/podman/bin on PATH — Podman Desktop installs there and does NOT
#      add itself to the shell profile
#   3. DOCKER_HOST, which the standalone docker-compose needs in order to find
#      the Podman machine's API socket
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export PATH="$_here/podman-shim:/opt/podman/bin:$PATH"
export DOCKER_HOST="unix://$(/opt/podman/bin/podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
unset _here
