# Fact-discovery eval — soa

`questions.json` is the visible half of a 32-question set (fact / pattern /
negative); the held-out half is committed alongside it as
`questions-heldout.json` after the cleanup lands. Runner and format: the
documentation-system plugin's `scripts/fact-eval.py`; method and metric
definitions: student-data-system `claude/projects/docs-cleanup/eval/README.md`.
Runs go in `runs/` as `<date>-<state>-<half>.jsonl`, one `.summary.json`
alongside each.

Every expected answer was verified against code/config, then independently
fact-checked (3 of 32 corrected before the baseline: a substring-fragile path
token, a false 'zero hits' claim on a negative, a wrong line citation).

## Outcome (haiku, 3 runs/question; essential-claims judge)

All five states — baseline, post-a, post-b, post-c, final — scored with the
same judge and question file. `n` = number of runs; `ctx` = median context
tokens; `rdCur`/`rdHist`/`rdMem` = share of runs that read the current-tier
docs / `docs/history/` / this machine's auto-memory.

### All five states, as the harness reports them (raw)

| state | n | pass | turns | ctx | rdCur | rdHist | rdMem | fails |
|---|---|---|---|---|---|---|---|---|
| baseline | 96 | 100% | 5.0 | 110k | 49% | 26% | 0% | — |
| post-a | 96 | 99% | 5.0 | 109k | 51% | 28% | 0% | q26#0 |
| post-b | 96 | 100% | 5.0 | 109k | 48% | 30% | 0% | — |
| post-c | 96 | 99% | 5.0 | 122k | 54% | 30% | 2% | q17#1 |
| final | 96 | 100% | 6.0 | 145k | 54% | 26% | 0% | — |

### Same five states, clean runs only

A run is "clean" if every `Read`/`Glob` path it touched stayed inside that
state's own worktree; "escaped" if any path resolved into the shared main
checkout (or another worktree) instead — see the harness caveat below.

| state | n (of 96) | pass | turns | ctx | rdCur | rdHist | rdMem |
|---|---|---|---|---|---|---|---|
| baseline | 62 (65%) | 100% | 4.0 | 106k | 40% | 26% | 0% |
| post-a | 47 (49%) | 100% | 4 | 105k | 43% | 17% | 0% |
| post-b | 46 (48%) | 100% | 4.0 | 106k | 30% | 20% | 0% |
| post-c | 44 (46%) | 98% | 4.0 | 105k | 43% | 25% | 0% |
| final | 43 (45%) | 100% | 5 | 107k | 35% | 19% | 0% |

Clean-run context is flat across all five states (106k → 107k median); the
raw table's 110k → 145k rise tracks the escape rate climbing (35% → 55%),
not doc quality. Every raw-table fail (`q26#0`, `q17#1`) is a single-run
fluke unrelated to a content change — `q17#1` (post-c) is confirmed by
byte-identical source files in both states; see the cost-analysis doc.

### By question kind (median ctx, raw vs. clean, all 96-run states)

| kind | baseline raw/clean | post-a raw/clean | post-b raw/clean | post-c raw/clean | final raw/clean |
|---|---|---|---|---|---|
| fact | 105k / 104k | 104k / 104k | 105k / 105k | 106k / 105k | 107k / 105k |
| pattern | 165k / 162k | 142k / 135k | 165k / 124k | 187k / 108k | 200k / 125k |
| negative | 278k / 196k | 329k / 175k | 311k / 185k | 303k / 233k | 399k / 156k |

`negative` questions carry the highest escape rate at every state (50% →
83%) because they require an exhaustive sweep, which is exactly the access
pattern most likely to wander into `/home/spaul/dev/soa/...` absolute paths.
Final's raw `negative` median (399k) reads as a regression; its clean
median (156k) is the lowest of any state — the same escape-rate artifact,
not evidence the final docs are harder to search.

### Harness caveat

Every state above escapes into the shared main checkout at a different
rate (35% baseline → 55% final) because `fact-eval.py` does not sandbox
`Read`/`Glob` to the worktree under test, and the main checkout was never
kept in sync with any of the five states. `claude/` → `docs/history/` in
particular created a dangling-path magnet: a stale `claude/...` reference
still resolves, with pre-cleanup content, once tried against the shared
checkout. Full method and per-state breakdown:
[`research/03-eval-cost-analysis.md`](../research/03-eval-cost-analysis.md).
Fix tracked in `followups.md`.

### What was and was not gained

Pass rate was already saturated at baseline (100%, tied for highest in the
program) and stayed at or near 100% through every phase — this repo had no
fact-discovery headroom to gain back. The cleanup's value is structural,
not fact-discovery cost: `claude/` retired entirely (819 lines across 4
reference trees), the validator dropped from 60 errors/4 warnings/12 info
(pre-Phase-A) to 5/3/11 (final, `docs-check.py --all`), 4 new
`.claude/rules/*.md` files replaced the misplaced reference trees, 7 files
were promoted from `claude/` into `docs/` (`esm.md`, `frontend/`'s 5 files,
`tooling/pnpm.md`) with verified banners, and 6 files (~800 lines) across
3 closed initiatives were archived to git history at `f110606a`.
