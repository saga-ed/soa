#!/bin/bash
#
# init-and-seed.sh — PostgreSQL profile seeder
#
# 1. Check if this profile has already been seeded (sentinel table)
# 2. If not, load profile-<name>.sql
#
# Runs via: bash /seed/init-and-seed.sh
# Expects: SEED_PROFILE env var, postgres service reachable at postgres:5432

set -e

PROFILE="${SEED_PROFILE:-small}"
SEED_FILE="/seed/profile-${PROFILE}.sql"
HOST="postgres"
PORT="5432"
USER="${PGUSER:-postgres_admin}"

echo "Postgres seed: profile=${PROFILE}"

# Wait for Postgres to accept connections (healthcheck can pass before full readiness)
for i in $(seq 1 15); do
  if psql -h "$HOST" -p "$PORT" -U "$USER" -c "SELECT 1" >/dev/null 2>&1; then
    echo "Postgres seed: connection ready"
    break
  fi
  echo "Postgres seed: waiting for connection (attempt $i/15)..."
  sleep 2
done

# Check sentinel — does the _profile_meta schema + table exist with this profile?
SEEDED=$(psql -h "$HOST" -p "$PORT" -U "$USER" -t -A -c \
  "SELECT seeded_at FROM _profile_meta.seeded WHERE profile='${PROFILE}'" 2>/dev/null || true)

if [ -n "$SEEDED" ]; then
  echo "Postgres seed: profile '${PROFILE}' already seeded at ${SEEDED} — skipping"
  exit 0
fi

if [ ! -f "$SEED_FILE" ]; then
  echo "Postgres seed: WARNING — ${SEED_FILE} not found, nothing to seed"
  exit 0
fi

echo "Postgres seed: loading ${SEED_FILE} ..."
psql -h "$HOST" -p "$PORT" -U "$USER" -f "$SEED_FILE"

# Write sentinel
psql -h "$HOST" -p "$PORT" -U "$USER" <<SQL
CREATE SCHEMA IF NOT EXISTS _profile_meta;
CREATE TABLE IF NOT EXISTS _profile_meta.seeded (
  profile VARCHAR(64) PRIMARY KEY,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seed_file VARCHAR(255)
);
INSERT INTO _profile_meta.seeded (profile, seed_file)
VALUES ('${PROFILE}', '${SEED_FILE}')
ON CONFLICT (profile) DO UPDATE SET seeded_at = NOW();
SQL

echo "Postgres seed: profile '${PROFILE}' complete"
