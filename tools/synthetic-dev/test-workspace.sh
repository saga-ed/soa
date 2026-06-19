#!/usr/bin/env bash
# Unit test for up.sh's --workspace seams (no live services needed). Extracts the
# four pure functions — want_service / iam_sandbox_name / parse_workspace /
# sandbox_env — and asserts that:
#   1. classic --only/--sandbox still behave identically (degenerate cases), and
#   2. a switchboard-exported workspace.json drives the run-set + dep-URL flips.
# Run: ./test-workspace.sh   (exit 0 = all pass). Requires jq.
set -euo pipefail
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
    "sis-api": { "mode": "local-image", "kind": "api", "imageDigest": "sha256:deadbeef", "artifactRef": "ecr/sis-api:pr-9", "dbProfile": "" },
    "iam-api": { "mode": "sandbox", "kind": "api", "sandboxName": "dev", "previewHeaderValue": "sandbox-dev" }
  }
}
JSON

# Minimal env + stubs so the extracted functions run standalone.
SANDBOX_BASE="wootdev.com"
err(){ echo "ERR: $*" >&2; }; warn(){ :; }; say(){ :; }; ok(){ :; }
ONLY_SERVICE=""; SANDBOX_NAME=""; WORKSPACE_FILE=""; DO_PLAYBACK=0; IAM_SANDBOX=""
declare -A SVC_MODE=() SVC_SANDBOX=() SVC_IMAGE=()
declare -a WS_RUN_SET=()
eval "$(sed -n '/^want_service(){/,/^}/p' "$UP")"
eval "$(sed -n '/^parse_workspace(){/,/^}/p' "$UP")"
eval "$(sed -n '/^sandbox_env(){/,/^}/p' "$UP")"

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
yn(){ if "$@"; then echo yes; else echo no; fi; }

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
assert "ws: sis-api local-image"        "${SVC_MODE[sis-api]}"      local-image
assert "ws: sis-api image ref"          "${SVC_IMAGE[sis-api]}"     "sha256:deadbeef"
assert "ws: iam-api sandbox"            "${SVC_MODE[iam-api]}"      sandbox
assert "ws: iam-api sandbox name"       "${SVC_SANDBOX[iam-api]}"   dev
assert "ws: programs-api in run-set"    "$(yn want_service programs-api)" yes
assert "ws: sis-api in run-set"         "$(yn want_service sis-api)"      yes
assert "ws: iam-api NOT in run-set"     "$(yn want_service iam-api)"      no
assert "ws: programs IAM_API_URL flips" "$(sandbox_env programs-api)" "IAM_API_URL=https://iam.wootdev.com"
assert "ws: sis IAM_BASEURL flips"      "$(sandbox_env sis-api)" \
  $'IAM_BASEURL=https://iam.wootdev.com/trpc\nIAM_TOKENURL=https://iam.wootdev.com/v1/oauth/token'

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
