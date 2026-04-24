#!/usr/bin/env bash
#
# run-integration.sh — Integration tests for infra-compose dump/restore
#
# Tests the full round-trip: seed → insert extra data → dump → restore → verify
#
# Usage:
#   cd infra && bash test/run-integration.sh
#
# Prerequisites: Docker, mongosh, mysql client, psql client
#
# Ports: uses .env.test (27118, 3407, 5533) to avoid dev conflicts
# Profiles: uses unique names (test-seed-<PID>) to avoid volume collisions

set -uo pipefail
# Note: NOT set -e — we handle errors via assert functions so all tests run

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="docker compose --env-file $SCRIPT_DIR/.env.test -f $SCRIPT_DIR/compose.yml -p infra-test"
CLI="$PKG_ROOT/bin/infra-compose"

# Test ports (must match .env.test)
MONGO_PORT=27118
MYSQL_PORT=3407
POSTGRES_PORT=5533
MYSQL_USER=mysql_admin
MYSQL_PASSWORD=password123
POSTGRES_USER=postgres_admin
POSTGRES_PASSWORD=password123

# Use unique profile names to avoid collisions with dev volumes
RUN_ID=$$
SEED_PROFILE="test-seed-${RUN_ID}"
DUMP_PROFILE="test-dump-${RUN_ID}"
DUMP_DIR="$SCRIPT_DIR/tmp-${RUN_ID}"

# Export ports so CLI picks them up
export MONGO_PORT MYSQL_PORT POSTGRES_PORT
export MYSQL_USER MYSQL_PASSWORD POSTGRES_USER POSTGRES_PASSWORD

# The CLI sources .env.defaults (which overwrites env vars), then .env from CWD.
# Create a .env in CWD so our test ports win.
ENV_BACKUP=""
if [[ -f ".env" ]]; then
    ENV_BACKUP="$(cat .env)"
fi
cat > .env <<ENVEOF
MONGO_PORT=${MONGO_PORT}
MYSQL_PORT=${MYSQL_PORT}
POSTGRES_PORT=${POSTGRES_PORT}
MYSQL_USER=${MYSQL_USER}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
ENVEOF

# Counters
PASSED=0
FAILED=0
TESTS=()

# ── Helpers ──────────────────────────────────────────────────

log()  { echo ""; echo "═══ $1 ═══"; }
info() { echo "  ▸ $1"; }
pass() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); TESTS+=("PASS: $1"); }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); TESTS+=("FAIL: $1"); }

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        pass "$label"
    else
        fail "$label (expected='$expected', actual='$actual')"
    fi
}

assert_contains() {
    local label="$1" haystack="$2" needle="$3"
    if echo "$haystack" | grep -qF "$needle"; then
        pass "$label"
    else
        fail "$label (expected to contain '$needle')"
    fi
}

assert_file_exists() {
    local label="$1" path="$2"
    if [[ -f "$path" ]]; then
        pass "$label"
    else
        fail "$label (file not found: $path)"
    fi
}

assert_not_contains() {
    local label="$1" haystack="$2" needle="$3"
    if echo "$haystack" | grep -qF "$needle"; then
        fail "$label (should NOT contain '$needle')"
    else
        pass "$label"
    fi
}

start_and_wait() {
    info "Starting services (waiting for healthchecks)..."
    $COMPOSE up -d --wait

    info "Waiting for init containers to finish seeding..."
    local init_containers
    init_containers=$($COMPOSE ps -a --format '{{.Name}}' | grep '_init' || true)
    if [[ -n "$init_containers" ]]; then
        # docker wait blocks until containers exit — no polling needed.
        # Works even if they already exited (returns immediately with exit code).
        docker wait $init_containers >/dev/null
        info "Init containers finished"
    else
        info "No init containers found"
    fi
}

create_seed_files() {
    # Copy "small" profile seed files to our test-unique profile name
    local profile="$1"
    info "Creating seed files for test profile: $profile"

    cp "$PKG_ROOT/compose/services/mongo/seed/profile-small.json" \
       "$PKG_ROOT/compose/services/mongo/seed/profile-${profile}.json"
    cp "$PKG_ROOT/compose/services/mysql/seed/profile-small.sql" \
       "$PKG_ROOT/compose/services/mysql/seed/profile-${profile}.sql"
    cp "$PKG_ROOT/compose/services/postgres/seed/profile-small.sql" \
       "$PKG_ROOT/compose/services/postgres/seed/profile-${profile}.sql"
}

# ── Cleanup ──────────────────────────────────────────────────

cleanup() {
    log "Cleanup"

    info "Stopping test containers..."
    $COMPOSE down 2>/dev/null || true

    info "Removing test volumes..."
    for profile in "$SEED_PROFILE" "$DUMP_PROFILE"; do
        docker volume rm "mongo-profile-${profile}" 2>/dev/null || true
        docker volume rm "mysql-profile-${profile}" 2>/dev/null || true
        docker volume rm "postgres-profile-${profile}" 2>/dev/null || true
    done

    info "Removing temp files..."
    rm -rf "$DUMP_DIR"

    info "Removing test seed/dump files..."
    for svc_ext in "mongo/seed:json" "mysql/seed:sql" "postgres/seed:sql"; do
        local svc_dir="${svc_ext%%:*}"
        local ext="${svc_ext##*:}"
        rm -f "$PKG_ROOT/compose/services/${svc_dir}/profile-${SEED_PROFILE}.${ext}"
        rm -f "$PKG_ROOT/compose/services/${svc_dir}/profile-${DUMP_PROFILE}.${ext}"
    done

    info "Restoring .env..."
    if [[ -n "$ENV_BACKUP" ]]; then
        echo "$ENV_BACKUP" > .env
    else
        rm -f .env
    fi
}

trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────

log "Preflight checks"

for cmd in docker mongosh mysql psql; do
    if command -v "$cmd" &>/dev/null; then
        pass "$cmd available"
    else
        fail "$cmd not found — required for integration tests"
    fi
done

if [[ $FAILED -gt 0 ]]; then
    echo ""
    echo "Aborting: missing required tools"
    exit 1
fi

# Check test ports are free
for port in $MONGO_PORT $MYSQL_PORT $POSTGRES_PORT; do
    if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q "0.0.0.0:${port}->"; then
        fail "Port $port already in use"
    else
        pass "Port $port is free"
    fi
done

if [[ $FAILED -gt 0 ]]; then
    echo ""
    echo "Aborting: port conflicts detected"
    exit 1
fi

# ══════════════════════════════════════════════════════════════
# TEST 1: Start services with test profile and verify seeding
# ══════════════════════════════════════════════════════════════

log "Test 1: Start services + verify seed data"

# Create test seed files (copy from small)
create_seed_files "$SEED_PROFILE"

export SEED_PROFILE
start_and_wait

# ── Mongo: verify seed data ──
info "Checking Mongo seed data..."
MONGO_ORGS=$(mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval \
    "db.getSiblingDB('saga_db').organizations.countDocuments()" 2>/dev/null) || MONGO_ORGS="ERROR"
assert_eq "Mongo: saga_db.organizations has 1 doc" "1" "$MONGO_ORGS"

MONGO_USERS=$(mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval \
    "db.getSiblingDB('saga_db').users.countDocuments()" 2>/dev/null) || MONGO_USERS="ERROR"
assert_eq "Mongo: saga_db.users has 3 docs" "3" "$MONGO_USERS"

# ── MySQL: verify seed data ──
info "Checking MySQL seed data..."
MYSQL_ORGS=$(MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -N -e "SELECT COUNT(*) FROM saga_db.organizations" 2>/dev/null) || MYSQL_ORGS="ERROR"
assert_eq "MySQL: saga_db.organizations has 1 row" "1" "$MYSQL_ORGS"

MYSQL_USERS=$(MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -N -e "SELECT COUNT(*) FROM saga_db.users" 2>/dev/null) || MYSQL_USERS="ERROR"
assert_eq "MySQL: saga_db.users has 3 rows" "3" "$MYSQL_USERS"

# ── Postgres: verify seed data ──
info "Checking Postgres seed data..."
PG_ORGS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -t -A -c "SELECT COUNT(*) FROM organizations" 2>/dev/null) || PG_ORGS="ERROR"
assert_eq "Postgres: organizations has 1 row" "1" "$PG_ORGS"

PG_USERS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -t -A -c "SELECT COUNT(*) FROM users" 2>/dev/null) || PG_USERS="ERROR"
assert_eq "Postgres: users has 3 rows" "3" "$PG_USERS"

# ══════════════════════════════════════════════════════════════
# TEST 2: Insert extra data (to verify dump captures live state)
# ══════════════════════════════════════════════════════════════

log "Test 2: Insert extra data into live databases"

# Mongo: add an extra org
mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval '
    db.getSiblingDB("saga_db").organizations.insertOne({
        name: "Test Dump Org",
        slug: "test-dump-org",
        status: "active",
        created_at: "2026-03-17T00:00:00Z"
    })
' >/dev/null 2>&1 || fail "Mongo: insert extra org failed"

MONGO_ORGS_AFTER=$(mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval \
    "db.getSiblingDB('saga_db').organizations.countDocuments()" 2>/dev/null) || MONGO_ORGS_AFTER="ERROR"
assert_eq "Mongo: organizations now has 2 docs after insert" "2" "$MONGO_ORGS_AFTER"

# MySQL: add an extra user
MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -e "INSERT INTO saga_db.users (id, org_id, email, role, display_name) VALUES ('user-test', 'org-001', 'test@dump.test', 'TESTER', 'Dump Tester')" 2>/dev/null \
    || fail "MySQL: insert extra user failed"

MYSQL_USERS_AFTER=$(MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -N -e "SELECT COUNT(*) FROM saga_db.users" 2>/dev/null) || MYSQL_USERS_AFTER="ERROR"
assert_eq "MySQL: users now has 4 rows after insert" "4" "$MYSQL_USERS_AFTER"

# Postgres: add an extra user
PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -c "INSERT INTO users (id, org_id, email, role, display_name) VALUES ('user-test', 'org-001', 'test@dump.test', 'TESTER', 'Dump Tester')" >/dev/null 2>&1 \
    || fail "Postgres: insert extra user failed"

PG_USERS_AFTER=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -t -A -c "SELECT COUNT(*) FROM users" 2>/dev/null) || PG_USERS_AFTER="ERROR"
assert_eq "Postgres: users now has 4 rows after insert" "4" "$PG_USERS_AFTER"

# ══════════════════════════════════════════════════════════════
# TEST 3: Dump to custom output directory
# ══════════════════════════════════════════════════════════════

log "Test 3: Dump databases to profile files"

mkdir -p "$DUMP_DIR"

"$CLI" dump --profile "$DUMP_PROFILE" --output-dir "$DUMP_DIR" || fail "dump command failed"

# Verify files created (--output-dir creates per-service subdirectories)
assert_file_exists "Mongo dump file created" "$DUMP_DIR/mongo/profile-${DUMP_PROFILE}.json"
assert_file_exists "MySQL dump file created" "$DUMP_DIR/mysql/profile-${DUMP_PROFILE}.sql"
assert_file_exists "Postgres dump file created" "$DUMP_DIR/postgres/profile-${DUMP_PROFILE}.sql"

# ══════════════════════════════════════════════════════════════
# TEST 4: Verify dump file format and content
# ══════════════════════════════════════════════════════════════

log "Test 4: Verify dump file format and content"

# ── Mongo JSON format ──
MONGO_DUMP_FILE="$DUMP_DIR/mongo/profile-${DUMP_PROFILE}.json"
if [[ -f "$MONGO_DUMP_FILE" ]]; then
    MONGO_DUMP=$(cat "$MONGO_DUMP_FILE")
    assert_contains "Mongo dump: has _meta key"           "$MONGO_DUMP" '"_meta"'
    assert_contains "Mongo dump: _meta type is snapshot"   "$MONGO_DUMP" '"type": "snapshot"'
    assert_contains "Mongo dump: contains saga_db"         "$MONGO_DUMP" '"saga_db"'
    assert_contains "Mongo dump: contains organizations"   "$MONGO_DUMP" '"organizations"'
    assert_contains "Mongo dump: contains Test Dump Org"   "$MONGO_DUMP" '"Test Dump Org"'
    assert_not_contains "Mongo dump: excludes _profile_meta" "$MONGO_DUMP" '"_profile_meta"'

    # Verify _id fields are preserved
    assert_contains "Mongo dump: preserves _id fields" "$MONGO_DUMP" '"_id"'
else
    fail "Mongo dump file missing — skipping content checks"
fi

# ── MySQL SQL format ──
MYSQL_DUMP_FILE="$DUMP_DIR/mysql/profile-${DUMP_PROFILE}.sql"
if [[ -f "$MYSQL_DUMP_FILE" ]]; then
    MYSQL_DUMP_HEAD=$(head -1 "$MYSQL_DUMP_FILE")
    assert_contains "MySQL dump: has snapshot header" "$MYSQL_DUMP_HEAD" "@infra-compose/snapshot"

    MYSQL_DUMP=$(cat "$MYSQL_DUMP_FILE")
    assert_contains "MySQL dump: contains saga_db"     "$MYSQL_DUMP" "saga_db"
    assert_contains "MySQL dump: contains test user"   "$MYSQL_DUMP" "test@dump.test"
    assert_not_contains "MySQL dump: excludes _profile_meta" "$MYSQL_DUMP" "_profile_meta"
else
    fail "MySQL dump file missing — skipping content checks"
fi

# ── Postgres SQL format ──
PG_DUMP_FILE="$DUMP_DIR/postgres/profile-${DUMP_PROFILE}.sql"
if [[ -f "$PG_DUMP_FILE" ]]; then
    PG_DUMP_HEAD=$(head -1 "$PG_DUMP_FILE")
    assert_contains "Postgres dump: has snapshot header" "$PG_DUMP_HEAD" "@infra-compose/snapshot"

    PG_DUMP=$(cat "$PG_DUMP_FILE")
    assert_contains "Postgres dump: contains test user" "$PG_DUMP" "test@dump.test"
    assert_not_contains "Postgres dump: excludes _profile_meta" "$PG_DUMP" "_profile_meta"
else
    fail "Postgres dump file missing — skipping content checks"
fi

# ══════════════════════════════════════════════════════════════
# TEST 5: Dump --force overwrites, no --force fails
# ══════════════════════════════════════════════════════════════

log "Test 5: --force flag behavior"

# Without --force should fail (mongo json already exists)
err=$("$CLI" dump --profile "$DUMP_PROFILE" --output-dir "$DUMP_DIR" 2>&1 || true)
assert_contains "Dump without --force fails on existing file" "$err" "already exists"

# With --force should succeed
"$CLI" dump --profile "$DUMP_PROFILE" --output-dir "$DUMP_DIR" --force \
    && pass "Dump with --force succeeds on existing file" \
    || fail "Dump with --force should succeed"

# ══════════════════════════════════════════════════════════════
# TEST 6: Dump with --services filter
# ══════════════════════════════════════════════════════════════

log "Test 6: --services filter"

filter_dir="$DUMP_DIR/filtered"
mkdir -p "$filter_dir"

"$CLI" dump --profile "$DUMP_PROFILE" --services mongo --output-dir "$filter_dir" \
    || fail "Filtered dump command failed"

assert_file_exists "Filtered dump: mongo file created" "$filter_dir/mongo/profile-${DUMP_PROFILE}.json"

if [[ ! -f "$filter_dir/mysql/profile-${DUMP_PROFILE}.sql" ]]; then
    pass "Filtered dump: no SQL file created (mongo only)"
else
    fail "Filtered dump: SQL file should not exist for mongo-only dump"
fi

# ══════════════════════════════════════════════════════════════
# TEST 7: Dump to default seed dirs + restore round-trip
# ══════════════════════════════════════════════════════════════

log "Test 7: Dump to default seed dirs"

# Dump to default locations (services/<svc>/seed/)
"$CLI" dump --profile "$DUMP_PROFILE" || fail "Default dump command failed"

assert_file_exists "Default dump: mongo seed file" "$PKG_ROOT/compose/services/mongo/seed/profile-${DUMP_PROFILE}.json"
assert_file_exists "Default dump: mysql seed file" "$PKG_ROOT/compose/services/mysql/seed/profile-${DUMP_PROFILE}.sql"
assert_file_exists "Default dump: postgres seed file" "$PKG_ROOT/compose/services/postgres/seed/profile-${DUMP_PROFILE}.sql"

# ══════════════════════════════════════════════════════════════
# TEST 8: list-profiles shows type distinction
# ══════════════════════════════════════════════════════════════

log "Test 8: list-profiles type detection"

LIST_OUTPUT=$("$CLI" list-profiles)

assert_contains "list-profiles: small is seed type"        "$LIST_OUTPUT" "small (seed)"
assert_contains "list-profiles: dump profile is snapshot"  "$LIST_OUTPUT" "${DUMP_PROFILE} (snapshot)"

# ══════════════════════════════════════════════════════════════
# TEST 9: Restore from dump (full round-trip)
# ══════════════════════════════════════════════════════════════

log "Test 9: Restore from dump — full round-trip"

# Stop current services
$COMPOSE down 2>/dev/null || true

# Start with the dumped profile — the init-and-seed scripts consume the dump files
export SEED_PROFILE="$DUMP_PROFILE"
start_and_wait

# ── Verify Mongo restored data ──
info "Checking Mongo restored data..."
RESTORED_MONGO_ORGS=$(mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval \
    "db.getSiblingDB('saga_db').organizations.countDocuments()" 2>/dev/null) || RESTORED_MONGO_ORGS="ERROR"
assert_eq "Restore Mongo: organizations has 2 docs (original + extra)" "2" "$RESTORED_MONGO_ORGS"

RESTORED_MONGO_USERS=$(mongosh "mongodb://localhost:${MONGO_PORT}" --quiet --eval \
    "db.getSiblingDB('saga_db').users.countDocuments()" 2>/dev/null) || RESTORED_MONGO_USERS="ERROR"
assert_eq "Restore Mongo: users has 3 docs" "3" "$RESTORED_MONGO_USERS"

# ── Verify MySQL restored data ──
info "Checking MySQL restored data..."
RESTORED_MYSQL_USERS=$(MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -N -e "SELECT COUNT(*) FROM saga_db.users" 2>/dev/null) || RESTORED_MYSQL_USERS="ERROR"
assert_eq "Restore MySQL: users has 4 rows (original + extra)" "4" "$RESTORED_MYSQL_USERS"

RESTORED_MYSQL_TEST=$(MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -P "$MYSQL_PORT" -u root \
    -N -e "SELECT email FROM saga_db.users WHERE id='user-test'" 2>/dev/null) || RESTORED_MYSQL_TEST="ERROR"
assert_eq "Restore MySQL: test user email preserved" "test@dump.test" "$RESTORED_MYSQL_TEST"

# ── Verify Postgres restored data ──
info "Checking Postgres restored data..."
RESTORED_PG_USERS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -t -A -c "SELECT COUNT(*) FROM users" 2>/dev/null) || RESTORED_PG_USERS="ERROR"
assert_eq "Restore Postgres: users has 4 rows (original + extra)" "4" "$RESTORED_PG_USERS"

RESTORED_PG_TEST=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" \
    -t -A -c "SELECT email FROM users WHERE id='user-test'" 2>/dev/null) || RESTORED_PG_TEST="ERROR"
assert_eq "Restore Postgres: test user email preserved" "test@dump.test" "$RESTORED_PG_TEST"

# ══════════════════════════════════════════════════════════════
# TEST 10: CLI error handling
# ══════════════════════════════════════════════════════════════

log "Test 10: CLI error handling"

# dump without --profile
err=$("$CLI" dump 2>&1 || true)
assert_contains "dump: requires --profile" "$err" "requires --profile"

# dump with invalid profile name
err=$("$CLI" dump --profile 'bad name!' 2>&1 || true)
assert_contains "dump: rejects invalid profile name" "$err" "invalid profile name"

# restore with nonexistent profile
err=$("$CLI" restore --profile nonexistent-xyz 2>&1 || true)
assert_contains "restore: fails for missing profile" "$err" "no seed files found"

# ══════════════════════════════════════════════════════════════
# TEST 11: Completion script
# ══════════════════════════════════════════════════════════════

log "Test 11: Completion script"

COMP_OUTPUT=$("$CLI" completion)
assert_contains "completion: outputs bash function" "$COMP_OUTPUT" "_infra_compose_completions"
assert_contains "completion: registers with complete" "$COMP_OUTPUT" "complete -F"
assert_contains "completion: includes dump command" "$COMP_OUTPUT" "dump"
assert_contains "completion: includes restore command" "$COMP_OUTPUT" "restore"

# ══════════════════════════════════════════════════════════════
# RESULTS
# ══════════════════════════════════════════════════════════════

log "Results"
echo ""
for t in "${TESTS[@]}"; do
    echo "  $t"
done
echo ""
echo "  Total: $((PASSED + FAILED))  Passed: $PASSED  Failed: $FAILED"
echo ""

if [[ $FAILED -gt 0 ]]; then
    echo "FAILED"
    exit 1
else
    echo "ALL TESTS PASSED"
    exit 0
fi
