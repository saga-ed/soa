#!/usr/bin/env bash
# Unit test for capture-sandbox.sh (no live AWS needed — stubs `aws` on PATH).
# Asserts:
#   1. a realistic queryState response folds into the right per-service
#      workspace.json rows (sha from gitRef, dbProfile from the db resource,
#      a service missing from ecr resources entirely is excluded).
#   2. a service whose ecr resource has no gitRef is captured WITHOUT a sha
#      (not a false empty-string pin) and triggers the missing-sha warning.
#   3. the real up.sh parse_workspace() accepts the captured output verbatim
#      (the round-trip this whole tool exists for).
#   4. preflight failures (no auth, unknown identifier, no args) fail loud
#      with an actionable message and a non-zero exit, not a raw stack trace.
# Run: ./test-capture-sandbox.sh   (exit 0 = all pass). Requires jq.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$HERE/capture-sandbox.sh"
UP="$HERE/up.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
assert_contains(){ if [[ "$2" == *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — '$2' does not contain '$3'"; fail=1; fi; }

FAKE_BIN="$(mktemp -d)"
RESP="$(mktemp)"
trap 'rm -rf "$FAKE_BIN"; rm -f "$RESP"' EXIT

cat > "$RESP" <<'JSON'
{
  "identifier": "sandbox-foo",
  "tier": "sandbox",
  "services": ["iam-api", "sis-api", "programs-api"],
  "resources": [
    { "kind": "ecr", "resourceId": "sha256:aaa", "source": "switchboard", "state": "active",
      "attrs": { "artifactRef": "iam-api:abc123", "imageDigest": "sha256:aaa",
                 "serviceName": "iam-api", "gitRef": "abc123def4567890abc123def4567890abc123d" } },
    { "kind": "ecr", "resourceId": "sha256:bbb", "source": "switchboard", "state": "active",
      "attrs": { "artifactRef": "sis-api:pr-42-new", "imageDigest": "sha256:bbb",
                 "serviceName": "sis-api", "gitRef": "" } },
    { "kind": "db", "resourceId": "iam-api", "source": "sandbox-composition", "state": "ready",
      "attrs": { "dbProfile": "canary" } },
    { "kind": "db", "resourceId": "sis-api", "source": "sandbox-composition", "state": "ready",
      "attrs": { "dbProfile": "canary-large" } }
  ]
}
JSON

# Stub `aws`: sts succeeds, lambda invoke copies $RESP to the output path arg.
cat > "$FAKE_BIN/aws" <<EOF
#!/usr/bin/env bash
if [[ "\$1 \$2" == "sts get-caller-identity" ]]; then echo '{"Account":"123"}'; exit 0; fi
if [[ "\$1 \$2" == "lambda invoke" ]]; then out="\${@: -1}"; cp "$RESP" "\$out"; exit 0; fi
echo "unhandled: \$*" >&2; exit 1
EOF
chmod +x "$FAKE_BIN/aws"

run_capture(){ PATH="$FAKE_BIN:$PATH" "$CAPTURE" "$@"; }

# 1+2. happy path + missing-sha handling
OUT="$(mktemp)"
capture_stderr="$(run_capture sandbox-foo -o "$OUT" 2>&1 1>/dev/null)"
assert "capture: exits 0"                 "$?" 0
assert "capture: iam-api mode"            "$(jq -r '.services["iam-api"].mode' "$OUT")"      local-source
assert "capture: iam-api sha from gitRef" "$(jq -r '.services["iam-api"].sha' "$OUT")"        abc123def4567890abc123def4567890abc123d
assert "capture: iam-api dbProfile"       "$(jq -r '.services["iam-api"].dbProfile' "$OUT")"  canary
assert "capture: sis-api no sha (empty gitRef, not pinned)" "$(jq -r '.services["sis-api"].sha // "MISSING"' "$OUT")" MISSING
assert "capture: sis-api dbProfile"       "$(jq -r '.services["sis-api"].dbProfile' "$OUT")"  canary-large
assert "capture: programs-api absent (no ecr resource)" "$(jq -r 'has("programs-api")' <<<"$(jq .services "$OUT")")" false
assert "capture: capturedFrom"            "$(jq -r '.capturedFrom' "$OUT")"                   sandbox:sandbox-foo
assert_contains "capture: warns on missing sha" "$capture_stderr" "sis-api' has no gitRef"

# 3. round-trip through up.sh's REAL parse_workspace
( ONLY_SERVICE=""; SANDBOX_NAME=""; WORKSPACE_FILE=""; DO_PLAYBACK=0; IAM_SANDBOX=""
  err(){ :; }; warn(){ :; }; say(){ :; }; ok(){ :; }
  declare -A SVC_MODE=() SVC_SANDBOX=() SVC_DBPROFILE=() SVC_SHA=() RESTORED_OK=()
  declare -a WS_RUN_SET=()
  eval "$(sed -n '/^parse_workspace(){/,/^}/p' "$UP")"
  parse_workspace "$OUT"
  echo "${SVC_MODE[iam-api]}|${SVC_SHA[iam-api]}|${SVC_DBPROFILE[iam-api]}|${SVC_SHA[sis-api]:-NONE}" > "$FAKE_BIN/roundtrip.out"
)
roundtrip="$(cat "$FAKE_BIN/roundtrip.out")"
assert "round-trip: up.sh parses captured manifest" "$roundtrip" \
  "local-source|abc123def4567890abc123def4567890abc123d|canary|NONE"
rm -f "$OUT"

# 4a. no AWS auth → fail loud with remediation, not a raw error
cat > "$FAKE_BIN/aws" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "sts get-caller-identity" ]]; then echo "no creds" >&2; exit 254; fi
echo "unhandled" >&2; exit 1
EOF
chmod +x "$FAKE_BIN/aws"
noauth_out="$(run_capture sandbox-foo 2>&1)"; noauth_rc=$?
assert "guard: no-auth exits 1"        "$noauth_rc" 1
assert_contains "guard: no-auth message actionable" "$noauth_out" "aws sso login"

# 4b. unknown identifier (queryState returns null) → fail loud, not a crash
cat > "$FAKE_BIN/aws" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "sts get-caller-identity" ]]; then echo '{"Account":"123"}'; exit 0; fi
if [[ "$1 $2" == "lambda invoke" ]]; then out="${@: -1}"; echo 'null' > "$out"; exit 0; fi
echo "unhandled" >&2; exit 1
EOF
chmod +x "$FAKE_BIN/aws"
notfound_out="$(run_capture bogus-identifier 2>&1)"; notfound_rc=$?
assert "guard: unknown identifier exits 1" "$notfound_rc" 1
assert_contains "guard: unknown identifier message" "$notfound_out" "no environment found"

# 4c. no args → usage, exit 1
noargs_rc="$("$CAPTURE" >/dev/null 2>&1; echo $?)"
assert "guard: no args exits 1" "$noargs_rc" 1

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
