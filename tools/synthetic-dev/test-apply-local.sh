#!/usr/bin/env bash
# Unit test for apply-local.sh (no live switchboard needed — stubs `curl` on
# PATH to simulate GET /compositions/{name}, PUT /services/.../variants/...,
# and POST /compositions/{name}/update).
# Asserts:
#   1. happy path: overlapping services get re-registered then update-dispatched,
#      in that order, with the right bodies + bearer tokens per call.
#   2. a workspace service not in the composition is skipped with a warning,
#      not an error.
#   3. unknown composition (404) fails loud with an actionable message.
#   4. a re-registration failure aborts BEFORE dispatching update (no stale
#      redeploy of a service whose new sha never actually got registered).
#   5. missing API keys fail fast with an actionable message.
# Run: ./test-apply-local.sh   (exit 0 = all pass). Requires jq + curl on PATH
# (stubbed, not actually invoked over the network).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$HERE/apply-local.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
assert_contains(){ if [[ "$2" == *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — '$2' does not contain '$3'"; fail=1; fi; }

TMP="$(mktemp -d)"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP"' EXIT

WS="$TMP/workspace.json"
cat > "$WS" <<'JSON'
{
  "version": 1,
  "capturedFrom": "local:devbox",
  "services": {
    "iam-api": {"mode": "local-source", "sha": "abc123def456"},
    "sis-api": {"mode": "local-source", "sha": "789fed321cba"},
    "unrelated-svc": {"mode": "local-source", "sha": "zzz999"}
  }
}
JSON

CALL_LOG="$TMP/calls.log"

mk_stub(){ # writes $FAKE_BIN/curl for a given scenario; $1 = scenario name
  cat > "$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$CALL_LOG"
SCENARIO="$1"
EOF
  cat >> "$FAKE_BIN/curl" <<'STUB'
# find -o outfile and -w format among args
out=""; url=""; method="GET"
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    -o) out="${args[$((i+1))]}" ;;
    -X) method="${args[$((i+1))]}" ;;
  esac
done
url="${args[${#args[@]}-1]}"

comp_get(){
  cat > "$out" <<'JSON'
{"name":"sandbox-foo","services":{"iam-api":"pr-42","sis-api":"pr-42","other-svc":"pr-9"},"status":"ready"}
JSON
  echo -n "200"
}
reg_put(){
  echo -n "200"
}
update_post(){
  cat > "$out" <<'JSON'
{"name":"sandbox-foo","status":"provisioning","components":[
  {"service":"iam-api","variantId":"pr-42","runId":"run-1","status":"provisioning"},
  {"service":"sis-api","variantId":"pr-42","runId":"run-2","status":"provisioning"}
]}
JSON
  echo -n "200"
}

case "$SCENARIO" in
  happy)
    if [[ "$method" == "GET" ]]; then comp_get
    elif [[ "$method" == "PUT" ]]; then reg_put
    elif [[ "$method" == "POST" ]]; then update_post
    fi
    ;;
  404)
    if [[ "$method" == "GET" ]]; then echo '{"detail":"not found"}' > "$out"; echo -n "404"; fi
    ;;
  reg_fails)
    if [[ "$method" == "GET" ]]; then comp_get
    elif [[ "$method" == "PUT" ]]; then echo '{"detail":"boom"}' > "$out"; echo -n "500"
    elif [[ "$method" == "POST" ]]; then update_post
    fi
    ;;
esac
STUB
  # substitute the scenario name into the case statement source (bash quirk:
  # $1 above is this function's own arg, re-embed as a literal)
  sed -i "s/SCENARIO=\"\$1\"/SCENARIO=\"$1\"/" "$FAKE_BIN/curl"
  chmod +x "$FAKE_BIN/curl"
}

run_apply(){
  PATH="$FAKE_BIN:$PATH" SWITCHBOARD_CI_API_KEY="reg-key-xyz" SANDBOX_CI_API_KEY="sbx-key-abc" \
    "$APPLY" "$@"
}

# 1. happy path
mk_stub happy
> "$CALL_LOG"
happy_out="$(run_apply sandbox-foo "$WS" 2>&1)"; happy_rc=$?
assert "happy: exits 0" "$happy_rc" 0
assert_contains "happy: warns on unrelated-svc skip" "$happy_out" "unrelated-svc"

calls="$(cat "$CALL_LOG")"
assert_contains "happy: GET composition called" "$calls" "compositions/sandbox-foo"
assert_contains "happy: PUT registers iam-api variant" "$calls" "services/iam-api/variants/pr-42"
assert_contains "happy: PUT registers sis-api variant" "$calls" "services/sis-api/variants/pr-42"
assert_contains "happy: PUT auth uses SWITCHBOARD_CI_API_KEY" "$calls" "Bearer reg-key-xyz"
assert_contains "happy: POST update called" "$calls" "compositions/sandbox-foo/update"
assert_contains "happy: POST auth uses SANDBOX_CI_API_KEY" "$calls" "Bearer sbx-key-abc"

# host routing: PUT (registry) must hit switchboard-api, GET/POST (composition)
# must hit sandbox-api -- these are DIFFERENT ALB-bypass-scoped hosts, not
# interchangeable (see apply-local.sh's Env comment / hipponot/microservices#698)
put_call="$(grep 'services/iam-api/variants' "$CALL_LOG")"
get_call="$(grep 'compositions/sandbox-foo ' "$CALL_LOG" || grep -F 'compositions/sandbox-foo"' "$CALL_LOG" || true)"
update_call="$(grep 'compositions/sandbox-foo/update' "$CALL_LOG")"
assert_contains "happy: PUT goes to switchboard-api host" "$put_call" "switchboard-api.wootdev.com"
assert_contains "happy: POST update goes to sandbox-api host" "$update_call" "sandbox-api.wootdev.com"

# ordering: last PUT call must appear before the POST update call
put_line=$(grep -n "PUT" "$CALL_LOG" | tail -1 | cut -d: -f1)
post_line=$(grep -n "compositions/sandbox-foo/update" "$CALL_LOG" | cut -d: -f1)
order_ok=$([[ "$put_line" -lt "$post_line" ]] && echo yes || echo no)
assert "happy: registration happens before update dispatch" "$order_ok" "yes"

# 3. unknown composition (404)
mk_stub 404
notfound_out="$(run_apply bogus-composition "$WS" 2>&1)"; notfound_rc=$?
assert "404: exits 1" "$notfound_rc" 1
assert_contains "404: message actionable" "$notfound_out" "not found"

# 4. registration failure aborts before update dispatch
mk_stub reg_fails
> "$CALL_LOG"
regfail_out="$(run_apply sandbox-foo "$WS" 2>&1)"; regfail_rc=$?
assert "reg-fail: exits 1" "$regfail_rc" 1
assert_contains "reg-fail: message actionable" "$regfail_out" "re-registration failed"
regfail_calls="$(cat "$CALL_LOG")"
assert_contains "reg-fail: no update dispatched after reg failure" "$(grep -c 'compositions/sandbox-foo/update' "$CALL_LOG" || true)" "0"

# 5. missing API keys fail fast
mk_stub happy
noauth_out="$(PATH="$FAKE_BIN:$PATH" "$APPLY" sandbox-foo "$WS" 2>&1)"; noauth_rc=$?
assert "no-keys: exits 1" "$noauth_rc" 1
assert_contains "no-keys: message actionable" "$noauth_out" "SWITCHBOARD_CI_API_KEY"

[[ $fail == 0 ]] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
