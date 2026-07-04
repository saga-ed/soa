#!/usr/bin/env bash
# Unit test for capture-local.sh (no real sibling checkouts needed — builds
# throwaway git repos under a tmpdir and points ROSTERING/PROGRAM_HUB/etc at them).
# Asserts:
#   1. a clean multi-repo mesh captures one sha per service, keyed correctly
#      (program-hub's 4 services all share ITS one repo sha, not each other's).
#   2. a dirty repo refuses to capture by default, with an actionable message.
#   3. --allow-dirty captures HEAD anyway and warns.
#   4. a missing (uncloned) repo is skipped with a warning, not a crash.
#   5. the real up.sh parse_workspace() accepts the captured output verbatim.
# Run: ./test-capture-local.sh   (exit 0 = all pass). Requires jq + git.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$HERE/capture-local.sh"
UP="$HERE/up.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
assert_contains(){ if [[ "$2" == *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — '$2' does not contain '$3'"; fail=1; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkrepo(){ # dir
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" config user.email test@example.com
  git -C "$1" config user.name test
  echo x > "$1/f"
  git -C "$1" add f
  git -C "$1" commit -qm init
}

mkrepo "$TMP/rostering"
mkrepo "$TMP/program-hub"
mkrepo "$TMP/saga-dash"
mkrepo "$TMP/coach"
mkrepo "$TMP/student-data-system"
mkrepo "$TMP/qboard"
mkrepo "$TMP/rtsm"
# soa deliberately NOT created — capture-local.sh doesn't walk it at all.

run_capture(){
  DEV="$TMP" ROSTERING="$TMP/rostering" PROGRAM_HUB="$TMP/program-hub" \
  SAGA_DASH="$TMP/saga-dash" COACH="$TMP/coach" SDS="$TMP/student-data-system" \
  QBOARD="$TMP/qboard" RTSM="$TMP/rtsm" "$CAPTURE" "$@"
}

# 1. clean mesh — one sha per repo, shared across that repo's services
OUT="$(mktemp)"
run_capture -o "$OUT" >/dev/null 2>&1
rc=$?
assert "capture: exits 0 on clean mesh" "$rc" 0

PH_SHA=$(git -C "$TMP/program-hub" rev-parse HEAD)
ROST_SHA=$(git -C "$TMP/rostering" rev-parse HEAD)
assert "capture: iam-api sha"          "$(jq -r '.services["iam-api"].sha' "$OUT")"          "$ROST_SHA"
assert "capture: sis-api sha"          "$(jq -r '.services["sis-api"].sha' "$OUT")"          "$ROST_SHA"
assert "capture: programs-api sha"     "$(jq -r '.services["programs-api"].sha' "$OUT")"     "$PH_SHA"
assert "capture: scheduling-api sha"   "$(jq -r '.services["scheduling-api"].sha' "$OUT")"   "$PH_SHA"
assert "capture: sessions-api sha"     "$(jq -r '.services["sessions-api"].sha' "$OUT")"     "$PH_SHA"
assert "capture: content-api sha"      "$(jq -r '.services["content-api"].sha' "$OUT")"      "$PH_SHA"
assert "capture: iam-api mode"         "$(jq -r '.services["iam-api"].mode' "$OUT")"         "local-source"
assert_contains "capture: capturedFrom" "$(jq -r '.capturedFrom' "$OUT")"                     "local:"
assert "capture: no dbProfile captured" "$(jq -r '.services["iam-api"] | has("dbProfile")' "$OUT")" "false"
rm -f "$OUT"

# 2. dirty repo refuses by default
echo dirty > "$TMP/rostering/f"
dirty_out="$(run_capture 2>&1 1>/dev/null)"; dirty_rc=$?
assert "guard: dirty repo exits 1" "$dirty_rc" 1
assert_contains "guard: dirty repo message actionable" "$dirty_out" "uncommitted changes"

# 3. --allow-dirty captures HEAD anyway (not the dirty working tree) + warns
OUT2="$(mktemp)"
allowdirty_out="$(run_capture --allow-dirty -o "$OUT2" 2>&1 1>/dev/null)"
assert "allow-dirty: exits 0"       "$?" 0
assert "allow-dirty: sha is still HEAD, not dirty" "$(jq -r '.services["iam-api"].sha' "$OUT2")" "$ROST_SHA"
assert_contains "allow-dirty: warns" "$allowdirty_out" "uncommitted changes"
git -C "$TMP/rostering" checkout -q -- f
rm -f "$OUT2"

# 4. missing repo skipped with a warning, not a crash
rm -rf "$TMP/rtsm"
OUT3="$(mktemp)"
missing_out="$(run_capture -o "$OUT3" 2>&1 1>/dev/null)"
assert "missing repo: still exits 0"        "$?" 0
assert "missing repo: rtsm-api absent"      "$(jq -r 'has("rtsm-api")' <<<"$(jq .services "$OUT3")")" "false"
assert_contains "missing repo: warns"       "$missing_out" "not cloned"
rm -f "$OUT3"

# 5. round-trip through up.sh's REAL parse_workspace
OUT4="$(mktemp)"
run_capture -o "$OUT4" >/dev/null 2>&1
( ONLY_SERVICE=""; SANDBOX_NAME=""; WORKSPACE_FILE=""; DO_PLAYBACK=0; IAM_SANDBOX=""
  err(){ :; }; warn(){ :; }; say(){ :; }; ok(){ :; }
  declare -A SVC_MODE=() SVC_SANDBOX=() SVC_DBPROFILE=() SVC_SHA=() RESTORED_OK=()
  declare -a WS_RUN_SET=()
  eval "$(sed -n '/^parse_workspace(){/,/^}/p' "$UP")"
  parse_workspace "$OUT4"
  echo "${SVC_MODE[programs-api]}|${SVC_SHA[programs-api]}" > "$TMP/roundtrip.out"
)
roundtrip="$(cat "$TMP/roundtrip.out")"
assert "round-trip: up.sh parses captured manifest" "$roundtrip" "local-source|$PH_SHA"
rm -f "$OUT4"

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
