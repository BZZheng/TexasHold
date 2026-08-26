SHELL := /bin/sh
.DEFAULT_GOAL := help

NODE ?= node
NPM ?= npm
CURL ?= curl
ENV_FILE ?= .env
PRODUCTION_ENV_FILE ?= deploy/production.env
APP_HOST ?= 127.0.0.1
APP_PORT ?= 7790
SERVICE_LOG_DIR ?= .logs
SERVICE_RUN_DIR ?= .run
PID_FILE ?= $(SERVICE_RUN_DIR)/texas-holdem.pid
APP_LOG ?= $(SERVICE_LOG_DIR)/app.log
HEALTH_URL ?= http://$(APP_HOST):$(APP_PORT)/api/health

.PHONY: help install env-init env-check env-check-production doctor \
	dev dev-server dev-web test build privacy-check privacy-check-history check logs-init run start stop status health logs \
	compose-check compose-status plan

help: ## Show the available local and production commands.
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target> [ENV_FILE=path] [APP_PORT=port]\n\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install exactly the dependency versions in package-lock.json.
	$(NPM) ci

env-init: ## Create .env from the safe local template when it does not exist.
	@if [ -e "$(ENV_FILE)" ]; then \
		echo "$(ENV_FILE) already exists; left unchanged."; \
	else \
		cp .env.example "$(ENV_FILE)"; chmod 600 "$(ENV_FILE)"; \
		echo "Created $(ENV_FILE) with mode 0600."; \
	fi

env-check: ## Validate Node and local environment settings.
	$(NODE) scripts/validate-env.mjs --env-file "$(ENV_FILE)" --mode local

env-check-production: ## Validate production-only environment requirements.
	$(NODE) scripts/validate-env.mjs --env-file "$(ENV_FILE)" --mode production

doctor: env-check ## Check required local commands and print their versions.
	@command -v "$(NODE)" >/dev/null || { echo "node is missing" >&2; exit 69; }
	@command -v "$(NPM)" >/dev/null || { echo "npm is missing" >&2; exit 69; }
	@command -v "$(CURL)" >/dev/null || { echo "curl is missing" >&2; exit 69; }
	@$(NODE) --version
	@$(NPM) --version

dev: env-check ## Run the frontend and backend watchers together.
	$(NPM) exec -- concurrently -k -n server,web -c green,yellow \
		"$(NODE) --env-file='$(ENV_FILE)' --watch server/index.js" \
		"$(NPM) run dev:web"

dev-server: env-check ## Run only the watched backend.
	$(NODE) --env-file="$(ENV_FILE)" --watch server/index.js

dev-web: ## Run only the Vite frontend.
	$(NPM) run dev:web

test: ## Run the complete Node test suite.
	$(NPM) test

build: ## Build the production frontend bundle.
	$(NPM) run build

privacy-check: ## Reject secrets, infrastructure identifiers, and runtime data from public files.
	$(NPM) run privacy:check

privacy-check-history: ## Also scan every outgoing commit relative to origin/main.
	$(NPM) run privacy:check:history

check: ## Run tests and the production build.
	$(NPM) run check

logs-init: ## Create private local process/log directories.
	@umask 077; mkdir -p "$(SERVICE_LOG_DIR)" "$(SERVICE_RUN_DIR)"; chmod 700 "$(SERVICE_LOG_DIR)" "$(SERVICE_RUN_DIR)"

run: env-check-production build logs-init ## Run the production server in the foreground.
	NODE_ENV=production $(NODE) --env-file="$(ENV_FILE)" server/index.js

start: env-check-production build logs-init ## Build and start the production server in the background.
	@set -eu; \
	if [ -f "$(PID_FILE)" ]; then \
		pid="$$(cat "$(PID_FILE)" 2>/dev/null || true)"; \
		if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
			echo "Service already appears to be running (pid $$pid)." >&2; exit 1; \
		fi; \
		rm -f "$(PID_FILE)"; \
	fi; \
	umask 077; \
	nohup env NODE_ENV=production $(NODE) --env-file="$(ENV_FILE)" server/index.js >>"$(APP_LOG)" 2>&1 & \
	pid=$$!; printf '%s\n' "$$pid" >"$(PID_FILE)"; \
	sleep 1; \
	if kill -0 "$$pid" 2>/dev/null; then \
		echo "Started TexasHold (pid $$pid); log: $(APP_LOG)"; \
	else \
		echo "TexasHold failed to start; inspect $(APP_LOG)." >&2; rm -f "$(PID_FILE)"; exit 1; \
	fi

stop: ## Gracefully stop the Make-managed background server.
	@set -eu; \
	if [ ! -f "$(PID_FILE)" ]; then echo "TexasHold is not Make-managed or is already stopped."; exit 0; fi; \
	pid="$$(cat "$(PID_FILE)" 2>/dev/null || true)"; \
	case "$$pid" in ''|*[!0-9]*) echo "Invalid PID file; refusing to signal a process." >&2; exit 65;; esac; \
	command="$$(ps -p "$$pid" -o command= 2>/dev/null || true)"; \
	if [ -z "$$command" ]; then rm -f "$(PID_FILE)"; echo "Removed a stale PID file."; exit 0; fi; \
	case "$$command" in *server/index.js*) ;; *) echo "PID $$pid is not TexasHold; refusing to stop it." >&2; exit 65;; esac; \
	kill "$$pid"; count=0; \
	while kill -0 "$$pid" 2>/dev/null && [ "$$count" -lt 15 ]; do sleep 1; count=$$((count + 1)); done; \
	if kill -0 "$$pid" 2>/dev/null; then \
		echo "Process $$pid did not exit after 15 seconds; no force-kill was sent." >&2; exit 1; \
	fi; \
	rm -f "$(PID_FILE)"; echo "TexasHold stopped cleanly."

status: ## Show PID state, then probe health when the service is running.
	@set -eu; \
	if [ ! -f "$(PID_FILE)" ]; then \
		if payload="$$( $(CURL) --fail --silent --show-error --max-time 5 "$(HEALTH_URL)" 2>/dev/null )"; then \
			echo "status=healthy-unmanaged (no Make PID file)"; printf '%s\n' "$$payload"; \
		else \
			echo "status=stopped (no Make PID file and health endpoint unavailable)"; \
		fi; \
		exit 0; \
	fi; \
	pid="$$(cat "$(PID_FILE)" 2>/dev/null || true)"; \
	if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
		echo "status=running pid=$$pid"; \
		$(CURL) --fail --silent --show-error --max-time 5 "$(HEALTH_URL)" || true; echo; \
	else \
		echo "status=stale pid=$${pid:-unknown}"; \
	fi

health: ## Fail unless the configured HTTP health endpoint is reachable.
	@$(CURL) --fail --silent --show-error --max-time 5 "$(HEALTH_URL)"; echo

logs: logs-init ## Follow the Make-managed production log.
	@touch "$(APP_LOG)"; chmod 600 "$(APP_LOG)"; tail -n 100 -f "$(APP_LOG)"

compose-check: env-check-production ## Validate the production Compose model without starting it.
	@docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)." >&2; exit 69; }
	docker compose --env-file "$(ENV_FILE)" -f docker-compose.production.yml config --quiet

compose-status: ## Show containers for the production Compose project without changing them.
	@docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)." >&2; exit 69; }
	docker compose --project-name texas-holdem --env-file "$(ENV_FILE)" -f docker-compose.production.yml ps

plan: ## Print dry-run commands for development and Make-managed production start.
	@$(MAKE) --no-print-directory -n dev ENV_FILE="$(ENV_FILE)"
	@$(MAKE) --no-print-directory -n start ENV_FILE="$(PRODUCTION_ENV_FILE)"
