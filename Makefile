# ===========================================================================
# Carto Group digital commerce demo — harness control surface.
#
#   make up            build + start everything (stack, Agent, load driver)
#   make rum           mint/reuse this org's RUM app and rebuild the storefront
#   make assets        push every [Carto] dashboard, monitor, SLO, synthetic
#   make doctor        end-to-end health check
#   make demo-*        inject / clear a failure scenario
#   make down          stop, keep data
#   make nuke          remove containers, volumes and built images
#
# Credentials come from carto.env (gitignored, literal keys). Every DD-touching
# target runs through scripts/creds-from-env.sh so nothing depends on the
# ambient shell.
# ===========================================================================
SHELL := /bin/bash
.DEFAULT_GOAL := help

# Compose file composition.
#
# compose.yaml is the base. Two generated overrides are layered on when they
# exist, and ORDER MATTERS — docker-compose.override.yaml carries the RUM app id
# and client token from `make rum`, and docker-compose.rum-dns.yaml adds the
# same-origin RUM proxy plus pinned intake addresses from `make rum-unblock`.
# Compose only auto-loads the first of those two, so COMPOSE_FILE is set
# explicitly here rather than relying on the default.
COMPOSE_FILES := compose.yaml
ifneq (,$(wildcard docker-compose.override.yaml))
COMPOSE_FILES := $(COMPOSE_FILES):docker-compose.override.yaml
endif
ifneq (,$(wildcard docker-compose.rum-dns.yaml))
COMPOSE_FILES := $(COMPOSE_FILES):docker-compose.rum-dns.yaml
endif
export COMPOSE_FILE := $(COMPOSE_FILES)

COMPOSE := docker compose
CREDS   := ./scripts/creds-from-env.sh
PROFILES ?= agent
BFF ?= http://localhost:8091
WEB ?= $(or $(WEB_URL),http://localhost:5175)

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: prereqs
prereqs: ## Check carto.env is present and docker is reachable
	@test -f carto.env || { echo "carto.env missing — copy carto.env.example and fill in your keys"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "docker is not reachable"; exit 1; }
	@grep -q '^DD_API_KEY=.\+' carto.env || { echo "DD_API_KEY is empty in carto.env"; exit 1; }

.PHONY: scan
scan: ## Fail if a literal DD API/APP key shape is committed anywhere tracked
	@./scripts/scan-for-secrets.sh

.PHONY: sync-common
sync-common: ## Copy common/*.py into each Python service build context
	@./scripts/sync-common.sh

.PHONY: build
build: prereqs sync-common ## Build all images
	@set -a; . ./carto.env; set +a; COMPOSE_PROFILES=$(PROFILES) $(COMPOSE) build

.PHONY: up
up: prereqs sync-common ## Build and start the harness
	@set -a; . ./carto.env; set +a; COMPOSE_PROFILES=$(PROFILES) $(COMPOSE) up -d --build
	@echo
	@echo "  storefront      $(WEB)"
	@echo "  demo flow       $(WEB)/demo-walkthrough.html"
	@echo "  architecture    $(WEB)/architecture.html"
	@echo "  tracking        $(WEB)/track"
	@echo "  telemetry       $(WEB)/telemetry"
	@echo
	@echo "  compose files: $(COMPOSE_FILE)"
	@echo
	@echo "  next: make rum     (RUM app + token, rebuilds the storefront bundle)"
	@echo "        make assets  (dashboards, monitors, SLOs, synthetics)"

.PHONY: stop
stop: ## Gracefully quiesce and stop the stack, keeping containers and data
	@./scripts/stack.sh stop

.PHONY: start
start: ## Start a stopped stack in dependency order and wait until it serves
	@./scripts/stack.sh start

.PHONY: cycle
cycle: ## stop + start (the one to use around a laptop reboot)
	@./scripts/stack.sh restart

.PHONY: status
status: ## Container states plus a live endpoint check
	@./scripts/stack.sh status

.PHONY: down
down: ## Remove containers (keeps volumes). Prefer `make stop` for a demo laptop.
	@COMPOSE_PROFILES=agent,dual,synthetics $(COMPOSE) down

.PHONY: restart
restart: down up ## Restart the stack

.PHONY: ps
ps: ## Service status
	@$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs from every service
	@$(COMPOSE) logs -f --tail=80

.PHONY: rum
rum: prereqs ## Mint (or reuse) this org's RUM app + token, then rebuild the storefront
	@set -a; . ./carto.env; set +a; RUM_APP_NAME=carto-web ./scripts/rum-provision.sh .

.PHONY: rum-unblock
rum-unblock: ## Serve RUM intake same-origin when local DNS blocks browser-intake-*
	@./scripts/rum-unblock.sh .

.PHONY: assets
assets: prereqs ## Push every [Carto] dashboard, monitor, SLO, synthetic and catalog entity
	@$(CREDS) ./scripts/dd-push.py all

.PHONY: dashboards monitors slos synthetics catalog
dashboards: ## Push just the dashboards
	@$(CREDS) ./scripts/dd-push.py dashboards
monitors: ## Push just the monitors
	@$(CREDS) ./scripts/dd-push.py monitors
slos: ## Push just the SLOs
	@$(CREDS) ./scripts/dd-push.py slos
synthetics: ## Push just the synthetic tests (needs the private location worker)
	@$(CREDS) ./scripts/dd-push.py synthetics
catalog: ## Push just the Software Catalog entities
	@$(CREDS) ./scripts/dd-push.py catalog

.PHONY: synthetics-worker
synthetics-worker: ## Start the Synthetics private location worker on the carto network
	@set -a; . ./carto.env; set +a; COMPOSE_PROFILES=agent,synthetics $(COMPOSE) up -d synthetics-pl

.PHONY: validate
validate: prereqs ## Prove a triggered failure lands in RUM and a clean run does not (CYCLES=3)
	@$(CREDS) ./scripts/validate-rum-cycle.sh $(or $(CYCLES),3)

.PHONY: doctor
doctor: ## End-to-end health: containers, endpoints, signals, ids
	@./scripts/doctor.sh

.PHONY: smoke
smoke: ## Drive one full transaction through the API and print its ledger
	@./scripts/smoke.sh

# --- demo scenarios --------------------------------------------------------
.PHONY: demo-state
demo-state: ## Show every injected condition and flag rollout
	@curl -s $(BFF)/api/demo/state | python3 -m json.tool

.PHONY: demo-new-range-break demo-new-range-fix
demo-new-range-break: ## New range published but not served — 200s, empty shelf
	@curl -s $(BFF)/api/demo/new-range-break | python3 -m json.tool
demo-new-range-fix: ## Clear the content failure
	@curl -s $(BFF)/api/demo/new-range-fix | python3 -m json.tool

.PHONY: demo-payment-break demo-payment-fix
demo-payment-break: ## Degrade the card gateway for one fulfilment method (METHOD=EXPRESS_DELIVERY)
	@curl -s "$(BFF)/api/demo/payment-break?method=$(or $(METHOD),EXPRESS_DELIVERY)" | python3 -m json.tool
demo-payment-fix: ## Clear the gateway degradation
	@curl -s $(BFF)/api/demo/payment-fix | python3 -m json.tool

.PHONY: demo-peak demo-peak-fix
demo-peak: ## Peak trade: gateway latency + an inventory lock (MS=700 LOCK_S=180)
	@curl -s "$(BFF)/api/demo/peak?ms=$(or $(MS),700)&lock_s=$(or $(LOCK_S),180)" | python3 -m json.tool
demo-peak-fix: ## Clear peak-trade conditions
	@curl -s $(BFF)/api/demo/peak-fix | python3 -m json.tool

.PHONY: demo-stall demo-stall-fix
demo-stall: ## Fulfilment black box goes quiet (STAGE=at_carrier)
	@curl -s "$(BFF)/api/demo/fulfilment-stall?stage=$(or $(STAGE),at_carrier)" | python3 -m json.tool
demo-stall-fix: ## Release stalled shipments
	@curl -s $(BFF)/api/demo/fulfilment-fix | python3 -m json.tool

.PHONY: demo-user-break demo-user-fix demo-user
demo-user-break: ## Fail checkout for ONE shopper only (CUSTOMER=CT-CUST-9001, Raj)
	@curl -s "$(BFF)/api/demo/user-break?customer=$(or $(CUSTOMER),CT-CUST-9001)" | python3 -m json.tool
demo-user-fix: ## Clear the single-shopper failure
	@curl -s "$(BFF)/api/demo/user-fix?customer=$(or $(CUSTOMER),CT-CUST-9001)" | python3 -m json.tool
demo-user: ## Show one shopper's ids, latest transaction and Datadog links
	@curl -s "$(BFF)/api/demo/user?customer=$(or $(CUSTOMER),CT-CUST-9001)" | python3 -m json.tool

.PHONY: demo-errors demo-reset
demo-errors: ## Widen the regressed express-checkout cohort (PCT=60)
	@curl -s "$(BFF)/api/demo/errors?pct=$(or $(PCT),60)" | python3 -m json.tool
demo-reset: ## Clear every injected failure and restore flag rollouts
	@curl -s $(BFF)/api/demo/reset | python3 -m json.tool

# --- cleanup ---------------------------------------------------------------
.PHONY: clean
clean: ## Stop and remove containers, networks and volumes for this harness
	@COMPOSE_PROFILES=agent,dual,synthetics $(COMPOSE) down -v --remove-orphans

.PHONY: nuke
nuke: clean ## clean + remove images built for this harness + the RUM override
	@docker image rm -f carto-web carto-bff carto-catalogue carto-checkout \
	  carto-fulfilment carto-joy carto-load 2>/dev/null || true
	@rm -f docker-compose.override.yaml
	@echo "nuked. carto.env and synthetics-pl-config.json are left alone."
