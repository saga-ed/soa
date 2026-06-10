#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify.sh — assert the synthetic-dev stack is fully up and seeded.
#
# Unlike `up.sh --status` (which just prints), this EXITS NON-ZERO on any red,
# so it's a one-shot "is my setup correct?" gate for a new engineer (or CI).
# Checks:
#   • all six service health endpoints return 200,
#   • the mesh Postgres is reachable + the iam roster is seeded (users > 0),
#   • SOURCE POSTURE (overlay-aware): each sibling repo is on the branch your
#     personal overlay expects (main by default, or local/integration for repos
#     you've overlaid), and every overlaid PR is actually merged into its
#     local/integration. This makes "the code I think I'm running" an assertion,
#     not a hope — health alone passes even on stale/wrong code.
#     (Caveat: it verifies the CHECKOUT; a running service built before a
#     refresh can still lag — restart/HMR closes that. See getting-started.md.)
#
# Usage:  ./verify.sh        (run after ./up.sh up --reset --seed roster)
#   DEV=~/work ./verify.sh   non-default sibling-repo parent
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/integration-suite.local.tsv"
DEV=${DEV:-$HOME/dev}
# Repos refresh-suite manages / up.sh builds from sibling branches. A managed
# repo listed in your local overlay is expected on local/integration (with those
# PRs merged); without an overlay entry, on main. soa + student-data-system are
# always on main.
MANAGED_REPOS="rostering program-hub saga-dash"
ALWAYS_MAIN_REPOS="soa student-data-system"

pass=0; fail=0; warn=0
okline()  { printf "  \033[32m✓\033[0m %s\n" "$*"; pass=$((pass+1)); }
badline() { printf "  \033[31m✗\033[0m %s\n" "$*"; fail=$((fail+1)); }
# Warn = real drift worth surfacing but not a failure (e.g. a legitimate ad-hoc
# overlay). Does NOT touch pass/fail, so it never flips the exit code.
warnline(){ printf "  \033[33m⚠\033[0m %s\n" "$*"; warn=$((warn+1)); }

probe(){ # name port path
  local name=$1 port=$2 path=$3 code
  # curl's -w always emits a code (000 on connect failure); it exits non-zero
  # then, but we don't `set -e`, so capture it directly. ${code:-000} covers
  # the degenerate no-curl case without doubling the 000.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$port$path" 2>/dev/null); code=${code:-000}
  if [[ "$code" == 200 ]]; then okline "$(printf '%-15s :%s%s → 200' "$name" "$port" "$path")"
  else badline "$(printf '%-15s :%s%s → %s (expected 200)' "$name" "$port" "$path" "$code")"; fi
}

printf "\033[1m── service health ──\033[0m\n"
probe iam-api        3010 /health
probe sis-api        3100 /health
probe programs-api   3006 /health
probe scheduling-api 3008 /health
probe ads-adm-api    5005 /health
probe saga-dash      8900 /

printf "\033[1m── data ──\033[0m\n"
users=$(docker exec soa-postgres-1 psql -U iam -d iam_local -tAc "SELECT count(*) FROM users" 2>/dev/null || echo "")
if [[ -z "$users" ]]; then
  badline "iam_local unreachable (is the mesh up?)"
elif [[ "$users" -gt 0 ]]; then
  okline "iam roster seeded — users=$users"
  # Determinism (db:seed model, synthetic-dev-align d2.1): the canonical seed is
  # 205 (190 roster + 6 personas + dev + 8 Connect Demo). A non-205 count isn't a
  # hard fail (partial/journey seeds vary) but is worth flagging.
  [[ "$users" == 205 ]] || printf "    \033[33m·\033[0m note: users=%s — canonical db:seed is 205 (190 roster+6 personas+dev+8 demo)\n" "$users"
  # Deterministic dev id = userId('dev') from @saga-ed/iam-seed-ids. Present ⇒
  # seeded via db:seed; ABSENT ⇒ the old scenario (random UUIDs) seeded it.
  if docker exec soa-postgres-1 psql -U iam -d iam_local -tAc \
       "SELECT 1 FROM users WHERE id='1e2ca0d8-8f6a-5a97-a141-b38d472a1186'" 2>/dev/null | grep -q 1; then
    okline "deterministic ids present (dev = userId('dev'))"
  else
    badline "deterministic dev id absent — not seeded via db:seed (scenario uses random ids)"
  fi
  # Per-district admin personas (#397): seed + Lincoln + riverside/metro/oakdale/frontier = 6.
  ap=$(docker exec soa-postgres-1 psql -U iam -d iam_local -tAc "SELECT count(*) FROM personas WHERE name='admin'" 2>/dev/null || echo 0)
  if [[ "${ap:-0}" -ge 6 ]]; then okline "admin personas present ($ap — incl 4 per-district, #397)"
  else badline "admin personas=$ap (<6) — per-district admins missing (#397 not seeded)"; fi
else
  badline "iam roster EMPTY (users=0) — run: ./up.sh --reset --seed roster"
fi

# sis_db schema present (sis-api's reconciliation tables)
if docker exec soa-postgres-1 psql -U postgres_admin -d sis_db -tAc \
     "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null | grep -q t; then
  okline "sis_db migrated"
else
  badline "sis_db not migrated (run ./up.sh up — prep deploys the schema)"
fi

# ── source posture (overlay-aware) ───────────────────────────────────
# Read your local overlay, then assert each repo's checkout matches it. A repo
# on the wrong branch — or on local/integration but missing an overlaid PR
# (stale, forgot to re-run refresh-suite) — fails here even though health is
# green. No overlay is the DEFAULT: every managed repo is asserted on main below.
printf "\033[1m── source posture ──\033[0m\n"
declare -A PINS=()
if [[ -f "$MANIFEST" ]]; then
  while IFS=$'\t' read -r repo prs; do
    repo="${repo//[[:space:]]/}"; [[ -z "$repo" ]] && continue
    PINS["$repo"]="${prs//[[:space:]]/}"
  done < <(grep -vE '^\s*(#|$)' "$MANIFEST")
else
  printf "  \033[2m· no local overlay — asserting every repo on origin/main\033[0m\n"
fi

# Flag any overlay repo we don't know how to posture-check (avoid silent skips).
for repo in "${!PINS[@]}"; do
  case " $MANAGED_REPOS " in *" $repo "*) ;; *) badline "overlay lists '$repo' but it's not in MANAGED_REPOS — verify can't posture-check it"; esac
done

on_branch(){ git -C "$DEV/$1" branch --show-current 2>/dev/null; }

check_posture(){ # repo expected_branch
  local repo=$1 want=$2 dir="$DEV/$repo" have
  [[ -d "$dir/.git" ]] || { badline "$repo: not a git repo at $dir"; return; }
  have=$(on_branch "$repo")
  if [[ "$have" == "$want" ]]; then okline "$(printf '%-20s on %s' "$repo" "$want")"
  else badline "$(printf '%-20s on '\''%s'\'' (expected '\''%s'\'')' "$repo" "$have" "$want")"; fi
}

# Un-overlaid managed repo: expected on main. But refresh-suite can leave the
# repo on local/integration even with no overlay — and an empty local/integration
# is identical to main (refresh-suite builds it as origin/main + PRs; with
# zero PRs that's just origin/main). Accept that as equivalent instead of crying
# wolf; only fail if the tree actually differs from main — a stray overlaid PR not
# in your overlay, or a stale/behind branch — both real drift worth flagging.
check_posture_main(){ # repo
  local repo=$1 dir="$DEV/$repo" have
  [[ -d "$dir/.git" ]] || { badline "$repo: not a git repo at $dir"; return; }
  have=$(on_branch "$repo")
  if [[ "$have" == main ]]; then
    okline "$(printf '%-20s on main' "$repo")"
  elif [[ "$have" == local/integration ]] && git -C "$dir" diff --quiet origin/main HEAD 2>/dev/null; then
    okline "$(printf '%-20s on local/integration ≡ main (no overlay)' "$repo")"
  else
    badline "$(printf '%-20s on '\''%s'\'' (expected '\''main'\'')' "$repo" "$have")"
  fi
}

# pinned PR actually merged into the current checkout? (resolve #→head SHA via gh)
check_pin_merged(){ # repo pr#
  local repo=$1 n=$2 dir="$DEV/$repo" oid
  oid=$( cd "$dir" && gh pr view "$n" --json headRefOid --jq '.headRefOid' 2>/dev/null || true )
  if [[ -z "$oid" ]]; then badline "$repo #$n: couldn't resolve head via gh (auth? PR exists?)"; return; fi
  if git -C "$dir" merge-base --is-ancestor "$oid" HEAD 2>/dev/null; then
    okline "$(printf '%-20s #%s merged in' "$repo" "$n")"
  else
    badline "$(printf '%-20s #%s NOT in checkout — run ./refresh-suite.sh' "$repo" "$n")"
  fi
}

# What's ACTUALLY overlaid vs what your overlay lists. The overlay checks above
# only ask "is every listed PR present?" — they're blind to branches merged in by
# an ad-hoc `refresh-suite --prs` that AREN'T listed. Those are legitimate
# (warn, not fail) but invisible and silently dropped by the next refresh-suite,
# so surface them. Overlay set = PR-branch merges in origin/main..HEAD (commits
# local/integration carries but main hasn't landed — landed PRs are ancestors of
# main and fall out of the range automatically). Subtract the pinned branches;
# whatever's left is an unpinned overlay.
check_unpinned_overlays(){ # repo  pinned_csv
  local repo=$1 pins=$2 dir="$DEV/$repo" b n num
  [[ "$(on_branch "$repo")" == local/integration ]] || return   # only meaningful on integration
  local merged
  merged=$( cd "$dir" && git log --merges --pretty=%s origin/main..HEAD 2>/dev/null \
            | sed -nE "s/.*Merge remote-tracking branch 'origin\/([^']+)'.*/\1/p" \
            | grep -vxE 'main|master' | sort -u )
  [[ -z "$merged" ]] && return
  # pinned branches: resolve each pinned # → headRefName (the branch that gets merged)
  declare -A PINNED_BRANCH=()
  IFS=',' read -ra nums <<<"$pins"
  for n in "${nums[@]}"; do
    [[ -z "$n" ]] && continue
    b=$( cd "$dir" && gh pr view "$n" --json headRefName --jq '.headRefName' 2>/dev/null || true )
    [[ -n "$b" ]] && PINNED_BRANCH["$b"]=$n
  done
  local extras=()
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    [[ -n "${PINNED_BRANCH[$b]:-}" ]] && continue            # pinned — already reported as ✓
    num=$( cd "$dir" && gh pr list --head "$b" --state all --json number --jq '.[0].number' 2>/dev/null || true )
    extras+=( "${num:+#$num }$b" )
  done <<<"$merged"
  if [[ ${#extras[@]} -gt 0 ]]; then
    warnline "$(printf '%-20s +%d unpinned overlay(s): %s' "$repo" "${#extras[@]}" "${extras[*]}")"
    warnline "$(printf '%-20s   ad-hoc (refresh-suite --prs) — not in your overlay; dropped on next refresh-suite' '')"
  fi
}

for repo in $MANAGED_REPOS; do
  prs="${PINS[$repo]:-}"
  if [[ -n "$prs" ]]; then
    check_posture "$repo" "local/integration"
    if [[ "$(on_branch "$repo")" == "local/integration" ]]; then   # only meaningful if branch is right
      IFS=',' read -ra nums <<<"$prs"
      for n in "${nums[@]}"; do [[ -n "$n" ]] && check_pin_merged "$repo" "$n"; done
      check_unpinned_overlays "$repo" "$prs"   # surface ad-hoc overlays not in your overlay file
    fi
  else
    check_posture_main "$repo"   # main, or an empty local/integration that ≡ main
  fi
done
# soa + student-data-system must be literally main (never integration-parked).
for repo in $ALWAYS_MAIN_REPOS; do check_posture "$repo" "main"; done

printf "\n"
if [[ $fail -eq 0 ]]; then
  if [[ $warn -gt 0 ]]; then
    printf "\033[32m✓ all %d checks passed\033[0m \033[33m(%d warning(s) — see ⚠ above)\033[0m — stack is ready\n" "$pass" "$warn"
  else
    printf "\033[32m✓ all %d checks passed — stack is ready\033[0m\n" "$pass"
  fi
  exit 0
else
  printf "\033[31m✗ %d/%d checks failed\033[0m — tail /tmp/sds-synthetic/<service>.log for reds\n" "$fail" "$((pass+fail))"; exit 1
fi
