#!/bin/bash
#
# init-and-seed.sh — MySQL profile seeder
#
# 1. Check if this profile has already been seeded (sentinel table)
# 2. If not, load profile-<name>.sql
#
# Runs via: bash /seed/init-and-seed.sh
# Expects: SEED_PROFILE env var, mysql service reachable at mysql:3306

set -e

PROFILE="${SEED_PROFILE:-small}"
SEED_FILE="/seed/profile-${PROFILE}.sql"
HOST="mysql"
PORT="3306"

echo "MySQL seed: profile=${PROFILE}"

# Wait for MySQL to accept connections (healthcheck can pass before full readiness)
for i in $(seq 1 15); do
  if mysql -h "$HOST" -P "$PORT" -u "${MYSQL_USER:-mysql_admin}" -e "SELECT 1" >/dev/null 2>&1; then
    echo "MySQL seed: connection ready"
    break
  fi
  echo "MySQL seed: waiting for connection (attempt $i/15)..."
  sleep 2
done

# Check sentinel — does the _profile_meta database + table exist with this profile?
SEEDED=$(mysql -h "$HOST" -P "$PORT" -u "${MYSQL_USER:-mysql_admin}" -N -e \
  "SELECT seeded_at FROM _profile_meta._seeded WHERE profile='${PROFILE}'" 2>/dev/null || true)

if [ -n "$SEEDED" ]; then
  echo "MySQL seed: profile '${PROFILE}' already seeded at ${SEEDED} — skipping"
  exit 0
fi

if [ ! -f "$SEED_FILE" ]; then
  echo "MySQL seed: WARNING — ${SEED_FILE} not found, nothing to seed"
  exit 0
fi

echo "MySQL seed: loading ${SEED_FILE} ..."
mysql -h "$HOST" -P "$PORT" -u "${MYSQL_USER:-mysql_admin}" < "$SEED_FILE"

# Write sentinel
mysql -h "$HOST" -P "$PORT" -u "${MYSQL_USER:-mysql_admin}" <<SQL
CREATE DATABASE IF NOT EXISTS _profile_meta;
CREATE TABLE IF NOT EXISTS _profile_meta._seeded (
  profile VARCHAR(64) PRIMARY KEY,
  seeded_at DATETIME NOT NULL,
  seed_file VARCHAR(255)
);
INSERT INTO _profile_meta._seeded (profile, seeded_at, seed_file)
VALUES ('${PROFILE}', NOW(), '${SEED_FILE}')
ON DUPLICATE KEY UPDATE seeded_at = NOW();
SQL

echo "MySQL seed: profile '${PROFILE}' complete"
