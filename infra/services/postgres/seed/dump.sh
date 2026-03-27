#!/bin/bash
#
# dump.sh — Export all PostgreSQL data to profile seed format
#
# Usage: PROFILE=name OUTPUT_DIR=/path HOST=localhost PORT=5433 USER=postgres_admin bash dump.sh
#
# Produces: profile-<PROFILE>.sql in OUTPUT_DIR
# Format: standard SQL — same as init-and-seed.sh expects
#
# Uses docker exec to run pg_dump inside the container, avoiding host/server
# version mismatches (e.g., host pg_dump 16 vs container Postgres 18).
#
# @infra-compose/dump-script

set -euo pipefail

PROFILE="${PROFILE:?ERROR: PROFILE is required}"
OUTPUT_DIR="${OUTPUT_DIR:?ERROR: OUTPUT_DIR is required}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5433}"
USER="${USER:-postgres_admin}"
PGPASSWORD="${PGPASSWORD:-password123}"
# Container name for docker exec — auto-detected if not set
CONTAINER="${PG_CONTAINER:-}"

OUT_FILE="${OUTPUT_DIR}/profile-${PROFILE}.sql"

echo "Postgres dump: profile=${PROFILE} output=${OUT_FILE}"

# Auto-detect postgres container if not explicitly set
if [[ -z "$CONTAINER" ]]; then
    CONTAINER=$(docker ps --format '{{.Names}}' \
        | grep -E 'postgres-1$' \
        | head -1) || true
fi

# Get list of non-template, non-system databases
DATABASES=$(PGPASSWORD="$PGPASSWORD" psql -h "$HOST" -p "$PORT" -U "$USER" -t -A -c \
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres')")

if [ -z "$DATABASES" ]; then
    echo "Postgres dump: no user databases found — nothing to dump"
    exit 0
fi

# Write header
cat > "$OUT_FILE" <<EOF
-- @infra-compose/snapshot
-- Profile: ${PROFILE}
-- Dumped at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
-- Source: pg_dump via infra-compose dump
--

EOF

for DB in $DATABASES; do
    echo "  db: ${DB}"

    if [[ -n "$CONTAINER" ]]; then
        # Use docker exec to run pg_dump inside the container (avoids version mismatch)
        docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
            pg_dump -U "$USER" \
            --no-owner \
            --no-acl \
            --exclude-schema='_profile_meta' \
            "$DB" \
            >> "$OUT_FILE"
    else
        # Fallback: use host pg_dump (requires matching version)
        PGPASSWORD="$PGPASSWORD" pg_dump -h "$HOST" -p "$PORT" -U "$USER" \
            --no-owner \
            --no-acl \
            --exclude-schema='_profile_meta' \
            "$DB" \
            >> "$OUT_FILE"
    fi
    echo "" >> "$OUT_FILE"
done

echo "Postgres dump: wrote ${OUT_FILE} ($(wc -c < "$OUT_FILE") bytes)"
