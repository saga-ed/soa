#!/usr/bin/env bash
# Unit test for up.sh's --workspace seams (no live services needed). Extracts the
# pure functions — want_service / parse_workspace / sandbox_env — and asserts:
#   1. classic --only/--sandbox still behave identically (degenerate cases),
#   2. a switchboard-exported workspace.json drives the run-set + dep-URL flips,
#   3. the loud-failure guards fire (local-image rejected, sandbox w/o name
#      rejected, non-iam sandbox warns).
# Run: ./test-workspace.sh   (exit 0 = all pass). Requires jq.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UP="$HERE/up.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

WS="$(mktemp)"; trap 'rm -f "$WS"' EXIT
cat > "$WS" <<'JSON'
{
  "version": 1,
  "generatedBy": "https://switchboard.wootdev.com",
  "defaultPolicy": "main",
  "services": {
    "programs-api": { "mode": "local-source", "kind": "api", "repo": "saga-ed/program-hub", "dbProfile": "canonical" },
    "sis-api": { "mode": "local-source", "kind": "api", "repo": "saga-ed/rostering" },
    "iam-api": { "mode": "sandbox", "kind": "api", "sandboxName": "dev", "previewHeader": "x-saga-preview-iam-api" }
  }
}
JSON

# Minimal env + stubs so the extracted functions run standalone.
SANDBOX_BASE="wootdev.com"
err(){ echo "ERR: $*" >&2; }; warn(){ echo "WARN: $*" >&2; }; say(){ :; }; ok(){ :; }
ONLY_SERVICE=""; SANDBOX_NAME=""; WORKSPACE_FILE=""; DO_PLAYBACK=0; IAM_SANDBOX=""
# Repo-path vars the restore map interpolates (values irrelevant to the map's shape).
ROSTERING="/r"; PROGRAM_HUB="/p"
declare -A SVC_MODE=() SVC_SANDBOX=() SVC_DBPROFILE=() RESTORED_OK=()
declare -a WS_RUN_SET=()
eval "$(sed -n '/^want_service(){/,/^}/p' "$UP")"
eval "$(sed -n '/^parse_workspace(){/,/^}/p' "$UP")"
eval "$(sed -n '/^sandbox_env(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restore_source_for(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restore_dbs_for_service(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restored_db(){/,/^}/p' "$UP")"

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
yn(){ if "$@"; then echo yes; else echo no; fi; }
# Run parse_workspace on a one-off manifest in a SUBSHELL; echo the exit code.
# (Subshell so a guard's `exit 1` doesn't kill the test runner.)
parse_rc(){ # json
  local f; f="$(mktemp)"; printf '%s' "$1" > "$f"
  ( SVC_MODE=(); SVC_SANDBOX=(); SVC_DBPROFILE=(); WS_RUN_SET=(); IAM_SANDBOX=""
    parse_workspace "$f" ) >/dev/null 2>&1; local rc=$?; rm -f "$f"; echo "$rc"
}

# 1. classic --only regression
ONLY_SERVICE="programs-api"; WORKSPACE_FILE=""
assert "only: target wanted"      "$(yn want_service programs-api)" yes
assert "only: non-target skipped" "$(yn want_service iam-api)"      no

# 2. classic --sandbox regression (arg-parse seeds IAM_SANDBOX from SANDBOX_NAME)
ONLY_SERVICE="programs-api"; SANDBOX_NAME="dev"; IAM_SANDBOX="dev"; WORKSPACE_FILE=""
assert "sandbox(classic): programs IAM_API_URL" "$(sandbox_env programs-api)" "IAM_API_URL=https://iam.wootdev.com"
assert "sandbox(classic): iam-api no repoint"   "$(sandbox_env iam-api)"      ""

# 3. workspace mode (parse_workspace seeds IAM_SANDBOX from the manifest)
ONLY_SERVICE=""; SANDBOX_NAME=""; IAM_SANDBOX=""; WORKSPACE_FILE="$WS"
parse_workspace "$WS"
assert "ws: programs-api local-source"  "${SVC_MODE[programs-api]}" local-source
assert "ws: sis-api local-source"       "${SVC_MODE[sis-api]}"      local-source
assert "ws: iam-api sandbox"            "${SVC_MODE[iam-api]}"      sandbox
assert "ws: iam-api sandbox name"       "${SVC_SANDBOX[iam-api]}"   dev
assert "ws: IAM_SANDBOX scalar set"     "$IAM_SANDBOX"              dev
assert "ws: programs-api in run-set"    "$(yn want_service programs-api)" yes
assert "ws: sis-api in run-set"         "$(yn want_service sis-api)"      yes
assert "ws: iam-api NOT in run-set"     "$(yn want_service iam-api)"      no
assert "ws: programs IAM_API_URL flips" "$(sandbox_env programs-api)" "IAM_API_URL=https://iam.wootdev.com"
assert "ws: sis IAM_BASEURL flips"      "$(sandbox_env sis-api)" \
  $'IAM_BASEURL=https://iam.wootdev.com/trpc\nIAM_TOKENURL=https://iam.wootdev.com/v1/oauth/token'

# 3b. dbProfile parsing (programs-api carries one; sis-api does not)
assert "ws: programs-api dbProfile"     "${SVC_DBPROFILE[programs-api]:-}" canonical
assert "ws: sis-api no dbProfile"        "${SVC_DBPROFILE[sis-api]:-}"      ""
assert "ws: iam-api(sandbox) no dbProfile" "${SVC_DBPROFILE[iam-api]:-}"    ""

# 3b'. restored_db keys on ACTUAL restore success (RESTORED_OK), not the dbProfile
# request — so a failed/not-yet-run restore still falls through to db:seed.
RESTORED_OK=()
assert "skip: programs not-yet-restored → seed" "$(yn restored_db programs-api)" no
RESTORED_OK[programs]=1
assert "skip: programs restored → skip seed"    "$(yn restored_db programs-api)" yes
# iam-api owns TWO DBs: skip its seed ONLY when BOTH restored (partial → still seed).
RESTORED_OK[iam_local]=1
assert "skip: iam partial (1/2) → still seed"   "$(yn restored_db iam-api)"      no
RESTORED_OK[iam_pii_local]=1
assert "skip: iam both restored → skip seed"    "$(yn restored_db iam-api)"      yes
assert "skip: sis-api never restored"            "$(yn restored_db sis-api)"      no
RESTORED_OK=()

# 3c. restore map: service → mesh DB(s), mesh DB → snapshot source/owner.
# iam-api owns TWO DBs; the four single-DB services map 1:1; sis/others have none.
assert "map: iam-api → two DBs"          "$(restore_dbs_for_service iam-api)"        "iam_local iam_pii_local"
assert "map: programs-api → programs"    "$(restore_dbs_for_service programs-api)"   "programs"
assert "map: content-api → content"      "$(restore_dbs_for_service content-api)"    "content"
assert "map: sis-api → no source"        "$(restore_dbs_for_service sis-api)"        ""
# Source spec is "source|role|pw|migdir"; assert the source + owner role per DB.
assert "src: iam_local source"           "$(restore_source_for iam_local | cut -d'|' -f1)"   "rostering-iam-canonical"
assert "src: iam_local owner"            "$(restore_source_for iam_local | cut -d'|' -f2)"   "iam"
assert "src: iam_pii owner+no-migdir"    "$(restore_source_for iam_pii_local | cut -d'|' -f2,4)" "iam_pii|"
assert "src: programs owner saga_user"   "$(restore_source_for programs | cut -d'|' -f2)"    "saga_user"
assert "src: scheduling source"          "$(restore_source_for scheduling | cut -d'|' -f1)"  "program-hub-scheduling-canonical"
assert "src: content source"             "$(restore_source_for content | cut -d'|' -f1)"     "content-api-postgres"
assert "src: sis_db has no source"       "$(restore_source_for sis_db)"                      ""

# 4. loud-failure guards (each parse must exit non-zero / warn)
assert "guard: local-image rejected" \
  "$(parse_rc '{"version":1,"services":{"sis-api":{"mode":"local-image","imageDigest":"sha256:x"}}}')" 1
assert "guard: sandbox w/o name rejected" \
  "$(parse_rc '{"version":1,"services":{"iam-api":{"mode":"sandbox"}}}')" 1
assert "guard: invalid mode rejected" \
  "$(parse_rc '{"version":1,"services":{"x":{"mode":"bogus"}}}')" 1
assert "guard: empty services rejected" \
  "$(parse_rc '{"version":1,"services":{}}')" 1
# non-iam sandbox is RECORDED (rc 0) but warns — capture the warning.
nonimam_warn="$( ( SVC_MODE=(); SVC_SANDBOX=(); WS_RUN_SET=(); IAM_SANDBOX=""; f="$(mktemp)"
  printf '%s' '{"version":1,"services":{"sis-api":{"mode":"sandbox","sandboxName":"x"}}}' > "$f"
  parse_workspace "$f" 2>&1 >/dev/null; rm -f "$f" ) | grep -c 'dep-repoint is iam-only' || true )"
assert "guard: non-iam sandbox warns" "$nonimam_warn" 1

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
