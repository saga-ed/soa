## Composable Docker Services with Profile Switching
##
## Each project composes the services it needs.
## Data services (mongo, mysql, postgres) use volume-per-profile isolation.
##
## Examples:
##   make up PROJECT=saga-api                  # start with default profile
##   make up PROJECT=saga-api PROFILE=basic    # start with specific profile
##   make switch PROJECT=saga-api PROFILE=basic
##   make reset PROJECT=saga-api PROFILE=basic # wipe + re-seed one profile
##   make down PROJECT=saga-api
##   make status
##   make list-projects
##   make list-profiles

PROJECT   ?= saga-api
PROFILE   ?= small
COMPOSE   := docker compose --env-file .env.defaults -f projects/$(PROJECT).yml

export COMPOSE_PROJECT_NAME := soa
export SEED_PROFILE := $(PROFILE)

# Load defaults, then local overrides (gitignored .env wins over .env.defaults)
-include .env.defaults
-include .env

.PHONY: up switch down reset status logs list-projects list-profiles \
        mongo-shell mysql-shell psql-shell redis-cli clean-all volumes help \
        check-ports

## ─── Lifecycle ───────────────────────────────────────────────

## Pre-flight check: fail fast if any required port is already taken.
check-ports:
	@conflicts=""; stop_cmds=""; down_projects=""; \
	for port in $(POSTGRES_PORT) $(MONGO_PORT) $(MYSQL_PORT) $(REDIS_PORT) $(RABBITMQ_PORT) $(RABBITMQ_MGMT_PORT); do \
		[ -z "$$port" ] && continue; \
		match=$$(docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}' \
			| grep -E "0\.0\.0\.0:$$port->" | head -1); \
		if [ -n "$$match" ]; then \
			cname=$$(echo "$$match" | cut -f1); \
			project=$$(echo "$$match" | cut -f3); \
			conflicts="$$conflicts\n  Port $$port is in use by container '$$cname' (project: $$project)"; \
			stop_cmds="$$stop_cmds\n    docker stop $$cname"; \
			if [ -n "$$project" ]; then \
				echo "$$down_projects" | grep -q "$$project" || \
					down_projects="$$down_projects\n    docker compose -p $$project down"; \
			fi; \
		fi; \
	done; \
	if [ -n "$$conflicts" ]; then \
		echo ""; \
		echo "  ERROR: Port conflict detected!"; \
		echo "$$conflicts"; \
		echo ""; \
		echo "  Option 1 — stop just the conflicting container(s):"; \
		echo "$$stop_cmds"; \
		echo ""; \
		echo "  Option 2 — stop the entire project (all its services):"; \
		echo "$$down_projects"; \
		echo ""; \
		exit 1; \
	fi

## Start a project's services with the given profile.
up: check-ports
	$(COMPOSE) up -d
	@echo ""
	@echo "  Project: $(PROJECT)  Profile: $(PROFILE)"
	@echo "  Services started. Use 'make status' to see what's running."

## Switch to a different profile. Instant if already seeded.
switch:
	$(COMPOSE) down
	$(COMPOSE) up -d
	@echo ""
	@echo "  Switched $(PROJECT) to profile: $(PROFILE)"

## Stop a project's services (volumes preserved).
down:
	$(COMPOSE) down
	@echo ""
	@echo "  $(PROJECT) stopped. Volumes preserved."

## ─── Profile Management ─────────────────────────────────────

## Wipe one profile's volumes, then restart so it re-seeds.
## Only deletes volumes for the specified profile — others are untouched.
reset:
	$(COMPOSE) down
	@echo "Removing volumes for profile: $(PROFILE) ..."
	@docker volume rm mongo-profile-$(PROFILE) 2>/dev/null && echo "  removed mongo-profile-$(PROFILE)" || true
	@docker volume rm mysql-profile-$(PROFILE) 2>/dev/null && echo "  removed mysql-profile-$(PROFILE)" || true
	@docker volume rm postgres-profile-$(PROFILE) 2>/dev/null && echo "  removed postgres-profile-$(PROFILE)" || true
	$(COMPOSE) up -d
	@echo ""
	@echo "  Reset profile: $(PROFILE) for $(PROJECT) — re-seeding"

## ─── Observability ──────────────────────────────────────────

## Show running containers and which profiles are active.
status:
	@echo "SOA containers:"
	@echo ""
	@out=$$(docker ps --filter "name=soa-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null); \
	if [ -z "$$out" ] || [ "$$(echo "$$out" | wc -l)" -le 1 ]; then \
		echo "  (none)"; \
	else \
		echo "$$out"; \
	fi
	@echo ""
	@echo "Other running containers:"
	@echo ""
	@other=$$(docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null | grep -v "^soa-"); \
	if [ -z "$$other" ]; then \
		echo "  (none)"; \
	else \
		echo "$$other" | column -t -s '	'; \
	fi
	@echo ""
	@echo "Profile volumes:"
	@docker volume ls --filter "name=-profile-" --format "  {{.Name}}" 2>/dev/null || echo "  (none)"

## Tail logs for a project.
logs:
	$(COMPOSE) logs -f

## List all profile-related Docker volumes.
volumes:
	@echo "All profile volumes:"
	@docker volume ls --filter "name=-profile-" --format "  {{.Name}}" 2>/dev/null

## ─── Discovery ──────────────────────────────────────────────

## List available projects.
list-projects:
	@echo "Available projects:"
	@for f in projects/*.yml; do \
		name=$$(basename "$$f" .yml); \
		services=$$(grep 'path:' "$$f" | sed 's|.*services/||;s|/compose.yml||' | tr '\n' ' '); \
		echo "  $$name  →  $$services"; \
	done

## List available seed profiles (by scanning seed directories).
list-profiles:
	@echo "Mongo profiles:"
	@ls services/mongo/seed/profile-*.json 2>/dev/null | while read f; do \
		echo "  - $$(basename "$$f" .json | sed 's/^profile-//')"; \
	done
	@echo "MySQL profiles:"
	@ls services/mysql/seed/profile-*.sql 2>/dev/null | while read f; do \
		echo "  - $$(basename "$$f" .sql | sed 's/^profile-//')"; \
	done
	@echo "Postgres profiles:"
	@ls services/postgres/seed/profile-*.sql 2>/dev/null | while read f; do \
		echo "  - $$(basename "$$f" .sql | sed 's/^profile-//')"; \
	done

## ─── Shell Access ───────────────────────────────────────────

mongo-shell:
	mongosh mongodb://localhost:$${MONGO_PORT:-27018}

mysql-shell:
	MYSQL_PWD=$${MYSQL_PASSWORD:-password123} mysql -h 127.0.0.1 -P $${MYSQL_PORT:-3307} -u $${MYSQL_USER:-mysql_admin}

psql-shell:
	PGPASSWORD=$${POSTGRES_PASSWORD:-password123} psql -h localhost -p $${POSTGRES_PORT:-5433} -U $${POSTGRES_USER:-postgres_admin}

redis-cli:
	redis-cli -p $${REDIS_PORT:-6380}

## ─── Cleanup ────────────────────────────────────────────────

## Destroy ALL volumes and containers for a project. All profile data gone.
clean-all:
	$(COMPOSE) down -v
	@echo "Removing all profile volumes for services in $(PROJECT) ..."
	@docker volume ls --filter "name=-profile-" --format "{{.Name}}" | xargs -r docker volume rm 2>/dev/null || true
	@docker volume rm redis-data 2>/dev/null || true
	@docker volume rm rabbitmq-data 2>/dev/null || true
	@echo ""
	@echo "  All data destroyed for $(PROJECT)."

## ─── Help ───────────────────────────────────────────────────

help:
	@echo "Usage: make <target> [PROJECT=name] [PROFILE=name]"
	@echo ""
	@echo "Lifecycle:"
	@echo "  up              Start project services (default: saga-api, small)"
	@echo "  switch          Switch to a different seed profile"
	@echo "  down            Stop services (keep volumes)"
	@echo ""
	@echo "Profile Management:"
	@echo "  reset           Wipe + re-seed one profile's volumes"
	@echo ""
	@echo "Observability:"
	@echo "  status          Show running containers and volumes (all projects)"
	@echo "  logs            Tail container logs"
	@echo "  volumes         List all profile volumes"
	@echo ""
	@echo "Discovery:"
	@echo "  list-projects   Show available project compositions"
	@echo "  list-profiles   Show available seed profiles per service"
	@echo ""
	@echo "Shell Access:"
	@echo "  mongo-shell     Open mongosh"
	@echo "  mysql-shell     Open mysql client"
	@echo "  psql-shell      Open psql"
	@echo "  redis-cli       Open redis-cli"
	@echo ""
	@echo "Cleanup:"
	@echo "  clean-all       Destroy ALL volumes and containers"
