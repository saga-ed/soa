#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# create.sh — author the `adm-combined` fixture on a running saga-mesh.
#
# Composes the three idempotent prod-mirror→postgres seed pipelines into a
# coherent fixture against three target programs (Chicago LVLHS + Simeon +
# Pecos-6th). Each step writes caller-specified UUIDs that round-trip
# across the iam-api / programs-api / ads-adm-api boundaries:
#
#   1. iam:seed-from-prod-mirror   — iam_local + iam_pii_local
#                                    (orgs as Group(kind=ORG), programs as
#                                    Group(kind=PROGRAM, parentGroupId=org),
#                                    users with deterministic UUID-v5 ids,
#                                    de-identified PII, group memberships)
#   2. pgm:seed-from-prod-mirror   — Program + TutoringPeriod + School/Section
#                                    mappings + period assignments. Program.id
#                                    matches prod-mirror programs_rules.id, so
#                                    adm_attendance.program_id resolves.
#   3. ads:seed-attendance         — adm_attendance rows referencing the same
#                                    program/period/user UUIDs. Per the
#                                    architecture audit (phase-3/), this also
#                                    fires the registry addCommand so
#                                    fixture:show / fixture:list surface the run.
#
# Order matters — iam writes the User + Group rows the others reference;
# pgm writes Program + TutoringPeriod rows ads-adm-api joins against. Each
# command is upsert-shaped: re-runnable on (a) clean mesh, (b) post-
# truncate, (c) post-prior-run (the seeds dedup on natural keys).
#
# Prereqs (user runs these first):
#   1. saga-mesh.sh doctor && saga-mesh.sh setup
#   2. VPN connected (mongo5.mirror.internal access)
#   3. iam-api / programs-api / ads-adm-api running
#   4. All three seed packages built:
#        pnpm -C ~/dev/rostering/packages/node/iam-seed build
#        pnpm -C ~/dev/program-hub/packages/node/pgm-seed build
#        pnpm -C ~/dev/sds-fixture/packages/node/ads-adm-seed build
#   5. PII env loaded (rostering/.env.local supplies PII_CRYPTO_PIIDEKHEX +
#      PII_CRYPTO_PIIHMACKEYHEX; the iam-seed bin reads it directly).
#
# After this script completes, snapshot via:
#   mesh-fixture fixture:store --fixture-id adm-combined
# (run automatically as the last step below).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

FIXTURE_ID="${FIXTURE_ID:-adm-combined}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_FIXTURE_CLI="${MESH_FIXTURE_CLI:-$SCRIPT_DIR/../../bin/run.js}"

if [[ ! -f "$MESH_FIXTURE_CLI" ]]; then
  echo "error: mesh-fixture CLI not found at $MESH_FIXTURE_CLI" >&2
  echo "       run 'pnpm -C $SCRIPT_DIR/../.. build' first, or set MESH_FIXTURE_CLI" >&2
  exit 1
fi

cli() { node "$MESH_FIXTURE_CLI" "$@"; }

echo "==> Authoring fixture '${FIXTURE_ID}'"

echo "--> 1/4 iam:seed-from-prod-mirror"
cli iam:seed-from-prod-mirror --fixture-id "$FIXTURE_ID" --source prod-mirror

echo "--> 2/4 pgm:seed-from-prod-mirror"
cli pgm:seed-from-prod-mirror --fixture-id "$FIXTURE_ID" --source prod-mirror

echo "--> 3/4 ads:seed-attendance"
cli ads:seed-attendance --fixture-id "$FIXTURE_ID" --source prod-mirror

echo "--> 4/4 fixture:store"
cli fixture:store --fixture-id "$FIXTURE_ID"

echo
echo "✓ fixture '$FIXTURE_ID' authored + stored. Restore on a clean mesh with:"
echo "    mesh-fixture fixture:restore --fixture-id $FIXTURE_ID"
