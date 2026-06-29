#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# create.sh — author the `iam-small` fixture on a running saga-mesh.
#
# A rostering-only / iam-only scenario fixture (rostering#123). Composes ONLY
# the mesh-fixture CLI's idempotent iam:* primitives into a small district
# roster — it touches iam_local + iam_pii_local and no other mesh DB.
#
# SCOPE (v1, scoped-down — see ./README.md and rostering#123):
#   groups + users + memberships + PII, via the EXISTING iam:* verbs.
#   It does NOT author roles, personas, permissions, or policies — those have
#   no iam:* authoring command yet (tracked in rostering#667). Users seed at the
#   default UserRole (USER); memberships carry no persona. The standard
#   permission/policy catalog is preserved via the registry-seeded base the
#   snapshot is authored on (see ./README.md §Permissions).
#
# Entities (all tagged source=demo, sourceId=<slug>):
#   district  iam-small-district
#     ├─ school   iam-small-north
#     │   ├─ section  iam-small-north-a
#     │   └─ section  iam-small-north-b
#     └─ school   iam-small-south
#         └─ section  iam-small-south-a
#   users: iam-small-admin-1, iam-small-tutor-1, iam-small-tutor-2,
#          iam-small-student-1 .. iam-small-student-4 (each with PII)
#
# Prereqs (user runs these before this script):
#   saga-mesh.sh doctor && saga-mesh.sh setup
#   + the standard IAM registry seeded on iam_local (see ./README.md §Permissions)
#
# Every command below is dedup-by-natural-key — re-running on a populated mesh
# is a no-op. See ../../README.md for the mesh-fixture CLI flag reference.
#
# After this script completes, snapshot via:
#   mesh-fixture snapshot:store --fixture-id iam-small
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
FIXTURE_ID="${FIXTURE_ID:-iam-small}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_FIXTURE_CLI="${MESH_FIXTURE_CLI:-$SCRIPT_DIR/../../bin/run.js}"

if [[ ! -f "$MESH_FIXTURE_CLI" ]]; then
  echo "error: mesh-fixture CLI not found at $MESH_FIXTURE_CLI" >&2
  echo "       run 'pnpm -C $SCRIPT_DIR/../.. build' first, or set MESH_FIXTURE_CLI" >&2
  exit 1
fi

cli() { node "$MESH_FIXTURE_CLI" "$@"; }

# ─── 1. Groups (district → schools → sections) ──────────────────────────────
# iam enforces parent-first ordering, so create the tree top-down.
echo "==> iam: groups"
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-district --kind district --display-name "IAM Small District"
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-north --kind school --display-name "North School" --parent iam-small-district
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-south --kind school --display-name "South School" --parent iam-small-district
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-north-a --kind section --display-name "North — Section A" --parent iam-small-north
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-north-b --kind section --display-name "North — Section B" --parent iam-small-north
cli iam:create-org --fixture-id "$FIXTURE_ID" --slug iam-small-south-a --kind section --display-name "South — Section A" --parent iam-small-south

# ─── 2. Users (+ PII) ───────────────────────────────────────────────────────
# All seed at the default UserRole (USER) — the --role flag arrives with #667.
echo "==> iam: users"
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-admin-1 --email iam-small-admin-1@fixture.test --name-first Ada --name-last Min
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-tutor-1 --email iam-small-tutor-1@fixture.test --name-first Tess --name-last Tutor
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-tutor-2 --email iam-small-tutor-2@fixture.test --name-first Ted --name-last Tutor
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-student-1 --email iam-small-student-1@fixture.test --name-first Stu --name-last One
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-student-2 --email iam-small-student-2@fixture.test --name-first Stu --name-last Two
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-student-3 --email iam-small-student-3@fixture.test --name-first Stu --name-last Three
cli iam:create-user --fixture-id "$FIXTURE_ID" --username iam-small-student-4 --email iam-small-student-4@fixture.test --name-first Stu --name-last Four

# ─── 3. Memberships ─────────────────────────────────────────────────────────
# Parent-first (district → school → section). Admin at the district; each tutor
# at the district + a school; each student at the district + one school + one
# section (member at every tier so roster tree-walks resolve them).
echo "==> iam: memberships"
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-admin-1 --group iam-small-district

cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-tutor-1 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-tutor-1 --group iam-small-north
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-tutor-2 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-tutor-2 --group iam-small-south

cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-1 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-1 --group iam-small-north
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-1 --group iam-small-north-a
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-2 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-2 --group iam-small-north
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-2 --group iam-small-north-b
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-3 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-3 --group iam-small-south
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-3 --group iam-small-south-a
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-4 --group iam-small-district
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-4 --group iam-small-south
cli iam:add-membership --fixture-id "$FIXTURE_ID" --user iam-small-student-4 --group iam-small-south-a

echo
echo "✓ fixture '$FIXTURE_ID' authored. Snapshot with:"
echo "    mesh-fixture snapshot:store --fixture-id $FIXTURE_ID"
