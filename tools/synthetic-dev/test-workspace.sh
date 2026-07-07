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
    "programs-api": { "mode": "local-source", "kind": "api", "repo": "saga-ed/program-hub", "dbProfile": "canonical", "sha": "abc1234" },
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
declare -A SVC_MODE=() SVC_SANDBOX=() SVC_DBPROFILE=() SVC_SHA=() RESTORED_OK=()
declare -a WS_RUN_SET=()
eval "$(sed -n '/^want_service(){/,/^}/p' "$UP")"
eval "$(sed -n '/^parse_workspace(){/,/^}/p' "$UP")"
eval "$(sed -n '/^sandbox_env(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restore_source_for(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restore_dbs_for_service(){/,/^}/p' "$UP")"
eval "$(sed -n '/^restored_db(){/,/^}/p' "$UP")"
eval "$(sed -n '/^svc_repo_dir(){/,/^}/p' "$UP")"

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
assert "sandbox(classic): iam-api no repoint"   "$(sandbox_env iam-api)"      ""
# sis-api and programs-api both originate the iam preview header (Phase 3) — slug
# form sandbox-<name>. sis flips IAM_BASEURL/IAM_TOKENURL; programs flips IAM_API_URL.
assert "sandbox(classic): sis originate-map"    "$(sandbox_env sis-api)" \
  $'IAM_BASEURL=https://iam.wootdev.com/trpc\nIAM_TOKENURL=https://iam.wootdev.com/v1/oauth/token\nPREVIEW_ORIGINATE_MAP=x-saga-preview-iam-api=sandbox-dev'
assert "sandbox(classic): programs originate-map" "$(sandbox_env programs-api)" \
  $'IAM_API_URL=https://iam.wootdev.com\nPREVIEW_ORIGINATE_MAP=x-saga-preview-iam-api=sandbox-dev'
# scheduling/sessions don't originate (no S2S iam dep / dep has no flip yet) → URL flip only.
assert "sandbox(classic): scheduling no originate" "$(sandbox_env scheduling-api)" "IAM_API_URL=https://iam.wootdev.com"
assert "sandbox(classic): sessions no originate"   "$(sandbox_env sessions-api)"   "IAM_API_URL=https://iam.wootdev.com"

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
assert "ws: programs IAM_API_URL flips + originates" "$(sandbox_env programs-api)" \
  $'IAM_API_URL=https://iam.wootdev.com\nPREVIEW_ORIGINATE_MAP=x-saga-preview-iam-api=sandbox-dev'
assert "ws: sis IAM_BASEURL flips + originates" "$(sandbox_env sis-api)" \
  $'IAM_BASEURL=https://iam.wootdev.com/trpc\nIAM_TOKENURL=https://iam.wootdev.com/v1/oauth/token\nPREVIEW_ORIGINATE_MAP=x-saga-preview-iam-api=sandbox-dev'

# 3b. dbProfile parsing (programs-api carries one; sis-api does not)
assert "ws: programs-api dbProfile"     "${SVC_DBPROFILE[programs-api]:-}" canonical
assert "ws: sis-api no dbProfile"        "${SVC_DBPROFILE[sis-api]:-}"      ""
assert "ws: iam-api(sandbox) no dbProfile" "${SVC_DBPROFILE[iam-api]:-}"    ""

# 3b''. sha parsing (programs-api carries one; sis-api and sandbox-mode iam-api don't)
assert "ws: programs-api sha"           "${SVC_SHA[programs-api]:-}"       abc1234
assert "ws: sis-api no sha"             "${SVC_SHA[sis-api]:-}"            ""
assert "ws: iam-api(sandbox) no sha"    "${SVC_SHA[iam-api]:-}"            ""

# 3b'''. svc_repo_dir: the 13-service → repo-var map checkout_workspace_shas uses.
assert "repo_dir: iam-api"     "$(svc_repo_dir iam-api)"        "/r"
assert "repo_dir: sis-api"     "$(svc_repo_dir sis-api)"        "/r"
assert "repo_dir: programs-api" "$(svc_repo_dir programs-api)" "/p"
assert "repo_dir: unknown svc is empty" "$(svc_repo_dir bogus-svc)" ""

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

# 5. checkout_workspace_shas: real scratch git repos, no network.
eval "$(sed -n '/^checkout_workspace_shas(){/,/^}/p' "$UP")"
SCRATCH="$(mktemp -d)"; trap 'rm -f "$WS"; rm -rf "$SCRATCH"' EXIT
git init -q "$SCRATCH/repo"
git -C "$SCRATCH/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
FIRST_SHA="$(git -C "$SCRATCH/repo" rev-parse HEAD)"
git -C "$SCRATCH/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
SECOND_SHA="$(git -C "$SCRATCH/repo" rev-parse HEAD)"
ROSTERING="$SCRATCH/repo"   # svc_repo_dir(iam-api) → $ROSTERING

# 5a. checks out an older sha cleanly.
SVC_SHA=([iam-api]="$FIRST_SHA")
checkout_rc="$( (checkout_workspace_shas) >/dev/null 2>&1; echo $? )"
assert "checkout: exits 0"         "$checkout_rc" 0
checkout_workspace_shas >/dev/null 2>&1
assert "checkout: HEAD moved"      "$(git -C "$SCRATCH/repo" rev-parse HEAD)" "$FIRST_SHA"

# 5b. already-there sha is a no-op (still exits 0, HEAD unchanged).
noop_rc="$( (checkout_workspace_shas) >/dev/null 2>&1; echo $? )"
assert "checkout: no-op when already on sha" "$noop_rc" 0

# 5c. dirty tree refuses to check out, even to a valid sha.
echo dirty > "$SCRATCH/repo/untracked.txt"
SVC_SHA=([iam-api]="$SECOND_SHA")
dirty_rc="$( (checkout_workspace_shas) >/dev/null 2>&1; echo $? )"
assert "checkout: dirty tree refused"  "$dirty_rc" 1
assert "checkout: dirty tree HEAD unmoved" "$(git -C "$SCRATCH/repo" rev-parse HEAD)" "$FIRST_SHA"
rm -f "$SCRATCH/repo/untracked.txt"

# 5d. unknown sha fails loudly rather than launching on whatever's checked out.
SVC_SHA=([iam-api]="0000000000000000000000000000000000dead")
bogus_rc="$( (checkout_workspace_shas) >/dev/null 2>&1; echo $? )"
assert "checkout: unknown sha fails" "$bogus_rc" 1

# 5e. a service with no svc_repo_dir mapping fails loudly, not silently.
SVC_SHA=([totally-unknown-svc]="$FIRST_SHA")
unmapped_rc="$( (checkout_workspace_shas) >/dev/null 2>&1; echo $? )"
assert "checkout: unmapped service fails" "$unmapped_rc" 1
SVC_SHA=()

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
