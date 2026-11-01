# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A self-contained retail commerce demo for Datadog, built around **Carto**, a fictional Australian
retailer. It is a *demonstration harness*, not a product: the code exists to make specific Datadog
capabilities visible and to stage specific failures on cue.

Three deployment paths, one credentials file:

| Path | Entry point | Storefront |
|---|---|---|
| Compose (Podman or Docker) | `./carto up` | `http://localhost:5175` |
| Local Kubernetes (kind) | `./scripts/kind-up.sh` | `http://localhost:8080` |
| GKE, regional or single-node | `./scripts/gke-deploy.sh` | the Ingress load-balancer IP |

`./carto` is the control surface — a thin wrapper over the Makefile. `./carto help` lists it.

## Architecture in one paragraph

A React SPA talks to a Node BFF (`carto-storefront` on Compose, `carto-bff` on Kubernetes), which
orchestrates five Python FastAPI services: catalogue, checkout, fulfilment, joy (an Anthropic-backed
assistant) and guardrails (a six-pillar AI policy evaluator). Postgres holds state plus a
`transaction_ledger`. A Puppeteer load driver walks real browser journeys. **The demo's central
idea is a seam**: the warehouse and carrier stages emit no Datadog telemetry at all, so a
Carto-minted `txn_id` is stamped on every hop and reassembled by the app's own `/track` page —
showing what distributed tracing alone cannot.

Two ID systems run end to end. Business ids (`CRTX-` transactions, `CRT-` orders, `CT-CUST-`
customers, `CRTA-` agent actions) ride as **span tags and log attributes, never metric tags** —
unbounded cardinality belongs on spans and logs, not on a custom metric bill.

## Invariants — break these and things fail silently

These were all found the hard way. Each one failed *without an error message*.

1. **`NODE_OPTIONS='-r dd-trace/init'` is required for the Node services.** dd-trace-js must be
   preloaded before anything it instruments; requiring it from `main.js` is too late. Compose sets
   it on the service block, Kubernetes in `gen-k8s.py` (any `lang="nodejs"`) and `30-web.yaml`.
   Without it the BFF produces **no traces at all** and `require('dd-trace').scope().active()`
   returns null, so the manual `txn_id` span tagging silently does nothing.

2. **RUM ids are compiled in at build time.** `VITE_DD_RUM_*` are Vite build args inlined into the
   bundle. There is no runtime switch. `./carto rum` must run **before** whatever builds the image,
   and `RUM_ENABLED` is false with an empty app id — so RUM is simply absent, no error. See the
   RUM section in `README.md`.

3. **Never apply `k8s/base/02-secret.yaml`.** It is a tracked placeholder with every value empty,
   deliberately *not* listed in any `kustomization.yaml`. Applying it overwrites a populated
   `carto-secrets` with empty strings; the Agent then exits with "You must set either a DD_API_KEY"
   three steps from the cause. Verify with
   `kubectl kustomize k8s/overlays/<o> | grep -c '^kind: Secret'` → must be **0**.

4. **`GKE_NODE_COUNT` is per zone on a regional cluster.** A region has three zones, so
   `--num-nodes 3` builds **nine** nodes. `GKE_TOPOLOGY=zonal` takes the number literally and
   selects `k8s/overlays/gke-single`. This is also a Datadog cost: the Agent is a DaemonSet, so
   nodes = billed Infrastructure hosts.

5. **Side-load kind images under the name the kubelet resolves.** Deployments reference
   `carto-web:latest`, which resolves to `docker.io/library/carto-web:latest`. Podman stores a
   locally built image under `localhost/`. `podman save carto-web:latest` can therefore produce an
   archive that loads fine and is then **ignored**, leaving pods on a stale image with no error.
   `kind-up.sh` tags to the fully qualified name before saving.

6. **Two files are generated.** `k8s/base/20-services.yaml` and `k8s/base/11-postgres-init.yaml`
   come from `scripts/gen-k8s.py`. Edit the generator (or `postgres/*.sql`), re-run it, commit the
   result. The generator is idempotent — a second run must produce no diff.

7. **`docs/` mirrors `web/public/`.** `architecture.html` and `demo-walkthrough.html` exist in both
   and must stay byte-identical. Edit `web/public/`, then copy.

8. **Python dependencies are pinned, per service, on purpose.** They were `>=` floors, and one
   from-scratch build resolved FastAPI 0.128.8 for `catalogue` and 0.141.1 for everything else.
   `catalogue` pins differ because it runs Python 3.9 — see invariant 9. Moving a pin means
   rebuild, `./carto doctor`, `./carto smoke`, then commit.

9. **`catalogue` runs an EOL Python 3.9 / Debian bullseye base deliberately.** The stale OS CVEs
   and the EOL interpreter *are* the SBOM/vulnerability-management story. Do not "fix" it to
   slim/bookworm. Its `apt` sources point at `archive.debian.org` because bullseye's pool is purged.

10. **`WEB_URL` drives the Datadog deep links.** Monitors, dashboards and catalog entities embed
    `${WEB_URL}`, expanded by `scripts/dd-push.py`. It differs per runtime (`:5175` Compose,
    `:8080` kind, the LB IP on GKE), so set it before `./carto assets`.

11. **`./carto doctor` needs a running stack.** Credentials are one of eight sections; the rest
    check containers, endpoints and signals. Use `./carto doctor --creds-only` before a build.

## Conventions

- **Comments explain *why*, at length, especially where the code looks wrong.** This codebase
  carries a lot of load-bearing commentary about failure modes. Match that density — a change that
  removes a "do not do X" comment loses the reason someone already tried X.
- Credentials live only in `carto.env` (gitignored). `carto.env.example` is tracked, documents
  every variable, and contains no secrets. Nothing else hardcodes a key, project, region or org.
- Datadog assets are code: `monitors/`, `dashboards/`, `slos/`, `synthetics/`, `catalog/`, pushed
  with `./carto assets`. Monitor names are prefixed `[Carto]`.
- Scripts fail with the exact missing variable or tool, not a stack trace.
- Verify behaviour against the running system, not the manifest. "The YAML says so" has been wrong
  here more than once.

## Known limitations

- **RUM cannot reach Datadog from a cluster on a network whose DNS blocks
  `browser-intake-<site>`.** `make rum-unblock` works around it for Compose only; there is no
  Kubernetes equivalent. The real fix is a DNS allowlist entry.
- **Node lockfiles are absent.** `bff/`, `load/` and `web/` have no `package-lock.json`, so builds
  resolve caret ranges fresh. Direct deps are a mix of exact pins and carets, so drift is bounded
  to minor versions. Generating them was blocked by a supply-chain firewall over two transitive
  advisories; do not disable that control to create the file.
- **The GKE path has never been run against real GKE.** Manifests, overlays and script logic are
  verified (including dry-runs against a stubbed `gcloud`), but cluster creation, the GCE load
  balancer and the actual bill are unexercised.
- `./carto validate` checks the RUM cycle against a *running* stack; the name suggests config
  validation and it is not that.

## Useful checks

```bash
./carto doctor --creds-only                  # keys only, before any build
./carto doctor                               # full: containers, endpoints, signals, ids
./carto smoke                                # drive one journey end to end
./scripts/scan-for-secrets.sh                # no literal key shapes committed
python3 scripts/gen-k8s.py                   # must leave no diff
for o in kind gke gke-single; do kubectl kustomize k8s/overlays/$o >/dev/null && echo "$o ok"; done
```

## House rules for changes here

- Run the thing. This repo has had several bugs that every static check passed: untraced Node
  services, RUM compiled out, a Secret clobbered on apply, TLS verification silently off on GKE.
- When a deploy "succeeds", check what actually arrived in Datadog before saying it worked.
- Keep `carto.env` out of git and keep `02-secret.yaml` empty.
- Carto is fictional. Do not reintroduce a real retailer's name, branding or palette.
