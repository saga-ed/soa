#!/bin/bash
#
# dump.sh — Export all MySQL data to profile seed format
#
# Usage: PROFILE=name OUTPUT_DIR=/path HOST=127.0.0.1 PORT=3307 USER=mysql_admin bash dump.sh
#
# Produces: profile-<PROFILE>.sql in OUTPUT_DIR
# Format: standard SQL (CREATE DATABASE/TABLE + INSERT) — same as init-and-seed.sh expects
#
# @infra-compose/dump-script

set -euo pipefail

PROFILE="${PROFILE:?ERROR: PROFILE is required}"
OUTPUT_DIR="${OUTPUT_DIR:?ERROR: OUTPUT_DIR is required}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3307}"
USER="${USER:-root}"

EXCLUDED_DBS="'information_schema','mysql','performance_schema','sys','_profile_meta'"
OUT_FILE="${OUTPUT_DIR}/profile-${PROFILE}.sql"

echo "MySQL dump: profile=${PROFILE} output=${OUT_FILE}"

# Get list of user databases
DATABASES=$(mysql -h "$HOST" -P "$PORT" -u "$USER" -N -e \
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (${EXCLUDED_DBS})")

if [ -z "$DATABASES" ]; then
    echo "MySQL dump: no user databases found — nothing to dump"
    exit 0
fi

# Write header
cat > "$OUT_FILE" <<EOF
-- @infra-compose/snapshot
-- Profile: ${PROFILE}
-- Dumped at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
-- Source: mysqldump via infra-compose dump
--

EOF

for DB in $DATABASES; do
    echo "  db: ${DB}"
    mysqldump -h "$HOST" -P "$PORT" -u "$USER" \
        --no-tablespaces \
        --skip-comments \
        --routines \
        --triggers \
        --databases "$DB" \
        >> "$OUT_FILE"
    echo "" >> "$OUT_FILE"
done

echo "MySQL dump: wrote ${OUT_FILE} ($(wc -c < "$OUT_FILE") bytes)"
