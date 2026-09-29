# Eval cost rise — root cause analysis

Written against post-c vs. baseline; the same escaped-vs-clean split applied to all five states in `../eval/README.md` confirms the pattern generalizes through final.


Compares `so-baseline` (worktree `so-base`, commit 182668b6) vs `so-postC`
(worktree `so-postC`, commit eb66de26) `runs.jsonl` records, cross-checked
against the actual file contents in both worktrees and in the shared main
checkout `/home/spaul/dev/soa` (currently on unrelated branch
`feat/ss-janus-mock-signer`, commit a35eb30b).

## Headline finding: the harness leaks into the main checkout, and that leak is what moved

`fact-eval.py` runs `claude -p` with `cwd=<worktree>` and
`--allowedTools "Read,Grep,Glob"`. Nothing sandboxes `Read`/`Glob` to that
cwd — the model can and does emit absolute paths under
`/home/spaul/dev/soa/...` that skip the `.claude/worktrees/<label>/` prefix
entirely, landing in the live main checkout. This happens in **both**
states, but at very different rates and with very different consequences:

| state | escaped-to-main-repo reads / total abs soa-path reads | runs with ≥1 escaped read |
|---|---|---|
| so-baseline | 113/292 (39%) | 34/96 (35%) |
| so-postC | 217/343 (63%) | 50/96 (52%) |

Splitting every run into "clean" (stayed inside its own worktree) vs
"escaped" and comparing mean cost:

| | so-baseline clean | so-postC clean | so-baseline escaped | so-postC escaped |
|---|---|---|---|---|
| n | 62 | 46 | 34 | 50 |
| mean tokens | 136,259 | 140,276 | 311,756 | 326,055 |
| mean turns | 5.3 | 5.0 | 10.4 | 11.0 |

**Clean-run cost is nearly identical between states (+3% tokens, turns
actually lower).** Escaped-run cost is also nearly identical between states
(+5% tokens). The 109k→122k overall shift is arithmetic: escaping is ~2.3x
more expensive regardless of state, and postC simply had more runs escape
(52% vs 35%). This is the dominant driver, and it is **not** a comparable-doc-quality
signal — it's a harness confound (main checkout not kept in sync with either
worktree's doc state).

**Why postC escapes more, though:** per-question escape counts shifted up in
13 of 18 changed questions (q04, q07, q21–q26, q28, q29, q31, q32, q08), down
in only 2 — a broad, systematic shift, not a couple of noisy outliers. The
mechanism: postC deleted `claude/` and renamed it to `docs/history/`, and the
old `claude/...` paths still exist, unchanged, in the shared main checkout
(which hasn't been reorganized). Any model exploration that lands on an
old-style relative path resolves to nothing inside the postC worktree but
resolves successfully — with stale content — once tried as a bare
`/home/spaul/dev/soa/claude/...` path. Baseline has no such dangling-path
magnet: its old-style paths still exist inside its own worktree, so an
escape there mostly just re-finds identical content in the main checkout
(e.g. `apps/node/CLAUDE.md`, `packages/CLAUDE.md`, `main.ts`/`inversify.config.ts`
are byte-identical between so-base and main — confirmed via `diff`), making
baseline's escapes cheap/harmless. postC's escapes instead surface a
genuinely different, pre-cleanup `apps/node/CLAUDE.md` / `apps/node/rest-api/CLAUDE.md`
(confirmed different via `diff` — old paths like `claude/testing.md`,
"Node.js 20+" vs the worktree's "Node.js >=24" and `.claude/rules/testing-node.md`),
forcing extra turns to reconcile contradictory info.

## 1. Top 6 questions by context delta (mean, 3 runs each)

| qid | kind | baseline ctx | postC ctx | Δ | baseline turns | postC turns |
|---|---|---|---|---|---|---|
| q08 | fact | 436,608 | 791,597 | +354,989 | 15.7 | 22.7 |
| q32 | negative | 135,331 | 368,532 | +233,201 | 8.7 | 15.3 |
| q04 | fact | 138,084 | 301,460 | +163,376 | 4.3 | 8.3 |
| q12 | pattern | 151,944 | 308,128 | +156,184 | 6.0 | 11.7 |
| q25 | pattern | 92,298 | 230,636 | +138,338 | 4.3 | 9.0 |
| q31 | negative | 138,530 | 236,515 | +97,985 | 5.7 | 9.0 |

All 6 fit the escape pattern above: q08's escape count held at high-but-equal
(2/3→3/3) — its blowup is mostly that it's an inherently expensive multi-file
source question (4 apps × 2–3 files each) where postC's escaped runs *also*
picked up stale `apps/node/CLAUDE.md`/`apps/node/rest-api/CLAUDE.md` on top of
the source files, adding extra reconciliation turns baseline's escapes didn't
need. q32, q25 went 1/3→3/3 escaped. q04 went 1/3→2/3. q12's escape rate was
already high in baseline (implicit via `infra/bin/infra-compose` reads which
exist identically in both) but postC pulled in one extra file
(`infra/docs/infra-compose-overview.html`, new in the reorg) per run, a small
genuine addition, not an escape artifact.

Note: q08's baseline itself has huge internal variance (173k vs 736k across
3 runs) — the within-state noise floor for source-heavy questions is already
large, so treat the q08 delta as the least reliable of the six.

## 2. What postC read that baseline didn't

Not a longer `docs/history/README.md` index (2,770 bytes) vs old `claude/`
content — comparable in size to individual old `claude/*.md` files, not
bloated. Not the `.claude/rules/*` glob machinery causing runaway autoloads
either — `so-base` has no `.claude/rules/` at all (0 rule files); postC's 4
new rule files (`testing-node.md`, `testing-web.md`, `event-driven.md`,
`python-uv.md`) load only on matching path globs and their effect is already
absorbed into the near-flat clean-run comparison above.

The one real, direct addition: postC's root `CLAUDE.md` grew 2,109→3,103
bytes (+47%, new "Authority by location" + "Path-scoped rules" sections).
That's ~250 extra tokens on every run — real but far too small to explain a
13k-token median shift. The rest of the increase is the escape-rate effect
above, not new in-worktree content.

## 3. q17#1 failure — a fluke, not a doc regression

Question: "What file path does infra-compose write the currently-active
seed profile to, read back by `get_active_profile()`?" Expected:
`~/.fixtures/active-profile` per `infra/CLAUDE.md` / `infra/src/api.js:15`.

The failing run read only `infra/src/ec2/profiles.js` (a same-shaped but
unrelated mechanism — EC2 db-host profile *registry*, answer
`<data_dir>/.profile-registry.json`) and never touched `infra/CLAUDE.md` or
`infra/src/api.js` at all. **`infra/CLAUDE.md` is byte-identical between
so-base and so-postC** (`diff` exit 0), and `infra/src/ec2/profiles.js` is
also byte-identical in both worktrees. Nothing in the docs-cleanup branch
touched either file — this is haiku grabbing the wrong same-named-concept
source file on one of three tries, confirmed by primary source to be
unrelated to any content change.

## 4. rdMem 2% — noise, not a driver

Both memory reads are in postC only (2/96 runs, matching the reported 2%):
`q21` run0 and `q22` run0, both reading
`/home/spaul/.claude/projects/-home-spaul-dev-soa/memory/MEMORY.md` (a
2-line file). Both runs **passed**. q21's cost was in line with baseline
(105,586 vs 105,690 mean); q22 run0 was expensive (235,941 tokens) but that
run *also* escaped to the main repo's stale `claude/projects/synthetic-dev-align/`
tree in the same breath — the memory read is incidental, not the cost driver.
Content in `docs/history/synthetic-dev-align/decisions/d1.1-base-journey-split.md`
(postC) is byte-identical to the old
`claude/projects/synthetic-dev-align/decisions/d1.1-base-journey-split.md`
(baseline) — confirmed via `diff`, same content, renamed path.

## 5. docs/history vs claude/ — mostly same-content-new-path

Every case checked (`synthetic-dev-align` decision doc, `apps/node/CLAUDE.md`'s
old `claude/testing.md`/`claude/esm.md` pointers) is a rename with unchanged
content, not new information. The genuinely *new* file found only in postC
was `infra/docs/infra-compose-overview.html` (q12) — a real addition from the
cleanup, not a rename.

## Conclusion

The 109k→122k mean-context rise is **overwhelmingly a harness artifact, not
evidence the post-C docs are worse to navigate.** Clean (in-worktree) runs
cost almost the same in both states (136k vs 140k, turns flat-to-lower);
escaped runs also cost almost the same per-escape (312k vs 326k). What
changed is the *rate* of escaping (35%→52%), driven by `claude/` having been
deleted from the worktree but still existing, unmodified, in the shared main
checkout that `Read`/`Glob` can freely reach — a dangling-path magnet created
specifically by the removal, not by any content defect in the new `docs/`
layout. `q17#1` and the rdMem reads are both confirmed-by-diff unrelated to
docs-cleanup content.

**Recommendation:** don't chase this with a docs-only fix (no rule's `paths:`
glob or index length is implicated). Fix the eval harness instead — either
restrict `Read`/`Glob` to the worktree (no clean flag exists in
`fact-eval.py`; would need a wrapper/sandbox), or refresh
`/home/spaul/dev/soa`'s main checkout to match each state before running so
an escape can't surface stale content. Until then, treat cross-state
`total_tokens` deltas as unreliable and compare **clean-run-only** subsets,
where post-C shows no regression.
