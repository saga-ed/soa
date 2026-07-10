#!/usr/bin/env bash
# Unit test for clone-repos.sh (no network — stubs `gh` on PATH so `gh auth
# status` succeeds and `gh repo clone` fabricates a checkout, or fails on demand).
# Asserts:
#   1. all repos present  → "7 present, 0 cloned", exit 0, nothing cloned.
#   2. missing repos      → each of the 7 required is cloned, exit 0, and coach
#      is NOT among them (it is opt-in, matching saga-stack-cli's
#      EXCLUDED_FROM_BOOTSTRAP — regression guard against re-adding it).
#   3. idempotency        → a second run over the result of (2) clones nothing.
#   4. worktree checkout  → `.git` as a FILE counts as present, is never cloned
#      over (the bug the `-e` test exists to prevent).
#   5. non-empty dir, no `.git` → skipped, NOT cloned into, and exit is NON-ZERO
#      so `clone-repos.sh && bootstrap.sh` stops here.
#   6. clone failure      → exit non-zero.
#   7. --dry-run          → reports, clones nothing, exit 0.
#   8. --with-optional    → adds coach + fleek (9 repos).
#   9. --help             → prints usage and exits 0 even when `$0` is not a
#      readable file (the `gh api … | bash -s -- --help` pipe).
#  10. unknown flag       → exit 1.
# Run: ./test-clone-repos.sh   (exit 0 = all pass).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/clone-repos.sh"

fail=0
assert(){ if [[ "$2" == "$3" ]]; then echo "ok: $1"; else echo "FAIL: $1 — got '$2' want '$3'"; fail=1; fi; }
assert_contains(){ if [[ "$2" == *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — output does not contain '$3'"; fail=1; fi; }
assert_missing(){ if [[ "$2" != *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — output unexpectedly contains '$3'"; fail=1; fi; }

TMP="$(mktemp -d)"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP"' EXIT

# `gh` stub. GH_CLONE_RC controls whether `gh repo clone` succeeds. A successful
# clone fabricates a normal checkout (`.git` as a DIRECTORY).
cat > "$FAKE_BIN/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "auth status") exit 0 ;;
  "repo clone")
    [[ "${GH_CLONE_RC:-0}" != 0 ]] && { echo "stub: clone failed" >&2; exit "$GH_CLONE_RC"; }
    dest="$4"; mkdir -p "$dest/.git"; echo "stub-clone $3" > "$dest/.git/HEAD"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$FAKE_BIN/gh"

REQUIRED=(soa rostering program-hub saga-dash student-data-system qboard rtsm)

# Run clone-repos.sh against a scratch $DEV with the stubbed gh first on PATH.
# Sets $o (combined output) and $RC in the CALLER's shell — do NOT wrap this in
# `$(...)`, which would run it in a subshell and lose $RC.
run(){ # dev_dir [args...]
    local dev="$1"; shift
    o="$(PATH="$FAKE_BIN:$PATH" DEV="$dev" "$SCRIPT" "$@" 2>&1)"; RC=$?
}

mkclone(){ mkdir -p "$1/.git"; }                                  # normal checkout
mkworktree(){ mkdir -p "$1"; echo "gitdir: /elsewhere" > "$1/.git"; }  # linked worktree: .git is a FILE

# ── 1. all present ────────────────────────────────────────────────────────────
D="$TMP/all-present"; mkdir -p "$D"
for r in "${REQUIRED[@]}"; do mkclone "$D/$r"; done
run "$D"
assert "all-present: exit 0" "$RC" 0
assert_contains "all-present: counts" "$o" "7 present, 0 cloned"

# ── 2. all missing → all cloned, including coach ──────────────────────────────
D="$TMP/all-missing"; mkdir -p "$D"
run "$D"
assert "all-missing: exit 0" "$RC" 0
assert_contains "all-missing: counts" "$o" "0 present, 7 cloned"
for r in "${REQUIRED[@]}"; do
    if [[ -d "$D/$r/.git" ]]; then echo "ok: all-missing: cloned $r"; else echo "FAIL: all-missing: $r not cloned"; fail=1; fi
done
# coach/fleek are opt-in — this guards against silently re-adding them to REQUIRED.
assert_missing "all-missing: coach NOT cloned by default" "$o" "coach cloned"
assert_missing "all-missing: fleek NOT cloned by default" "$o" "fleek cloned"
assert "all-missing: no coach checkout" "$([[ -e "$D/coach" ]] && echo present || echo absent)" absent

# ── 3. idempotency: re-run over (2) clones nothing ────────────────────────────
run "$D"
assert "idempotent: exit 0" "$RC" 0
assert_contains "idempotent: counts" "$o" "7 present, 0 cloned"

# ── 4. a git WORKTREE (.git is a file) counts as present, never cloned over ───
D="$TMP/worktree"; mkdir -p "$D"
for r in "${REQUIRED[@]}"; do mkclone "$D/$r"; done
rm -rf "$D/soa"; mkworktree "$D/soa"
run "$D"
assert "worktree: exit 0" "$RC" 0
assert_contains "worktree: counts" "$o" "7 present, 0 cloned"
assert "worktree: .git still a FILE (not cloned over)" "$([[ -f "$D/soa/.git" ]] && echo file)" file
assert_contains "worktree: .git contents preserved" "$(cat "$D/soa/.git")" "gitdir:"

# ── 5. non-empty dir with no .git → skipped, NOT cloned into, exit NON-ZERO ───
D="$TMP/stray"; mkdir -p "$D"
for r in "${REQUIRED[@]}"; do mkclone "$D/$r"; done
rm -rf "$D/rostering"; mkdir -p "$D/rostering"; echo stray > "$D/rostering/README"
run "$D"
assert "stray: exit NON-zero (chained bootstrap must not proceed)" "$([[ $RC -ne 0 ]] && echo nonzero)" nonzero
assert_contains "stray: warns SKIPPED" "$o" "SKIPPED"
assert_contains "stray: says still missing" "$o" "still missing"
assert "stray: not cloned into" "$([[ -e "$D/rostering/.git" ]] && echo cloned || echo untouched)" untouched

# ── 6. clone failure → exit non-zero ──────────────────────────────────────────
D="$TMP/clonefail"; mkdir -p "$D"
out="$(PATH="$FAKE_BIN:$PATH" DEV="$D" GH_CLONE_RC=1 "$SCRIPT" 2>&1)"; RC=$?
assert "clone-fail: exit NON-zero" "$([[ $RC -ne 0 ]] && echo nonzero)" nonzero
assert_contains "clone-fail: reports failures" "$out" "7 failed"

# ── 7. --dry-run reports but clones nothing ───────────────────────────────────
D="$TMP/dryrun"; mkdir -p "$D"
run "$D" --dry-run
assert "dry-run: exit 0" "$RC" 0
assert_contains "dry-run: counts" "$o" "7 to clone"
assert "dry-run: nothing on disk" "$(ls -A "$D" | wc -l)" 0

# ── 8. --with-optional adds fleek ─────────────────────────────────────────────
D="$TMP/optional"; mkdir -p "$D"
run "$D" --with-optional --dry-run
assert "with-optional: exit 0" "$RC" 0
assert_contains "with-optional: 9 repos" "$o" "9 to clone"
assert_contains "with-optional: includes coach" "$o" "coach"
assert_contains "with-optional: includes fleek" "$o" "fleek"

# ── 9. --help works when $0 is NOT a readable file (the `| bash -s --` pipe) ──
out="$(PATH="$FAKE_BIN:$PATH" bash -s -- --help < "$SCRIPT" 2>&1)"; RC=$?
assert "help-via-pipe: exit 0" "$RC" 0
assert_contains "help-via-pipe: prints usage" "$out" "clone whichever saga-stack sibling repos are missing"
assert_missing  "help-via-pipe: no sed error" "$out" "No such file"

# ── 10. unknown flag → exit 1 ─────────────────────────────────────────────────
out="$(PATH="$FAKE_BIN:$PATH" DEV="$TMP/x" "$SCRIPT" --bogus 2>&1)"; RC=$?
assert "unknown-flag: exit 1" "$RC" 1
assert_contains "unknown-flag: names it" "$out" "unknown: --bogus"

echo
if [[ $fail == 0 ]]; then echo "all clone-repos.sh tests passed"; else echo "SOME TESTS FAILED"; fi
exit $fail
