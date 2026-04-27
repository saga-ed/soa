#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# create.sh — author the `demo-small` fixture on a running saga-mesh.
#
# Composes the mesh-fixture CLI's idempotent iam:* + pgm:* primitives into
# the smallest end-to-end rostering + program-hub shape: one district, one
# school, one section, one tutor, one student, one program, one period,
# one enrollment + period assignment.
#
# Entities (all tagged source=demo, sourceId=<slug>):
#   district  demo-small-org
#     ├─ school   demo-small-site
#     │   └─ section  demo-small-scholars
#     │        └─ enrolled in program "Demo Small Program", period "Morning Block"
#     ├─ user  demo-tutor     (also the fixture-admin used for devLogin)
#     └─ user  demo-scholar-1 (member of the scholars section)
#
# Prereqs (user runs these before this script):
#   saga-mesh.sh doctor && saga-mesh.sh setup
#
# Every command below is dedup-by-natural-key — re-running this script on a
# populated mesh is a no-op (except the enrollment upsert, which always
# re-applies). See ../../README.md for mesh-fixture CLI flag reference.
#
# After this script completes, snapshot via:
#   mesh-fixture fixture:store --fixture-id demo-small
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
FIXTURE_ID="${FIXTURE_ID:-demo-small}"
ADMIN_EMAIL="${SAGA_MESH_ADMIN_EMAIL:-demo-tutor@fixture.test}"

# Resolve the CLI. Honors env override for the worktree dev path; otherwise
# falls back to the built bin shim next to this script (fixtures/demo-small/ is
# two dirs below the package root). As of the oclif port (2026-04), commands
# are invoked with colon topic separator (iam:create-org, not "iam create-org").
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_FIXTURE_CLI="${MESH_FIXTURE_CLI:-$SCRIPT_DIR/../../bin/run.js}"

if [[ ! -f "$MESH_FIXTURE_CLI" ]]; then
  echo "error: mesh-fixture CLI not found at $MESH_FIXTURE_CLI" >&2
  echo "       run 'pnpm -C $SCRIPT_DIR/../.. build' first, or set MESH_FIXTURE_CLI" >&2
  exit 1
fi

cli() { node "$MESH_FIXTURE_CLI" "$@"; }

# ─── 1. Groups (district / school / section) ────────────────────────────────
echo "==> iam: groups"
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug demo-small-org --kind district --display-name "Demo Small District"
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug demo-small-site --kind school --display-name "Demo Small School" --parent demo-small-org
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug demo-small-scholars --kind section --display-name "Demo Scholars" --parent demo-small-site

# ─── 2. Users ───────────────────────────────────────────────────────────────
# demo-tutor doubles as the fixture-admin — pgm:* commands devLogin as this
# email to get a session cookie for programs-api.
echo "==> iam: users"
cli iam:create-user --fixture-id "$FIXTURE_ID" --username demo-tutor --email "$ADMIN_EMAIL" --name-last Tutor
cli iam:create-user --fixture-id "$FIXTURE_ID" --username demo-scholar-1 --email demo-scholar-1@fixture.test --name-last Scholar

# ─── 3. Memberships ─────────────────────────────────────────────────────────
# iam enforces parent-first ordering (district → school → section). Tutor
# lives at the district; scholar lives at every tier so enrollment tree
# walks resolve them under the section.
echo "==> iam: memberships"
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user demo-tutor --group demo-small-org
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user demo-scholar-1 --group demo-small-org
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user demo-scholar-1 --group demo-small-site
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user demo-scholar-1 --group demo-small-scholars

# ─── 4. Program + period ────────────────────────────────────────────────────
echo "==> pgm: program + period"
cli pgm:create-program --fixture-id "$FIXTURE_ID" --name "Demo Small Program" --org demo-small-org
cli pgm:create-period --fixture-id "$FIXTURE_ID" --program "Demo Small Program" --name "Morning Block" --org demo-small-org

# ─── 5. Enrollment + period assignment ──────────────────────────────────────
# setProgramEnrollment is upsert-shaped so we always re-apply; this is the
# one command in the flow that isn't a strict no-op on re-run (idempotent
# outcome, non-idempotent side effects — e.g. updated_at bumps).
echo "==> pgm: enrollment"
cli pgm:enroll \
  --fixture-id "$FIXTURE_ID" \
  --program "Demo Small Program" \
  --school demo-small-site \
  --section demo-small-scholars \
  --org demo-small-org \
  --period "Morning Block"

echo
echo "✓ fixture '$FIXTURE_ID' authored. Snapshot with:"
echo "    mesh-fixture fixture:store --fixture-id $FIXTURE_ID"
