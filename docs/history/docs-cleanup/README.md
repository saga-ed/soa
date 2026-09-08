# docs-cleanup — soa (2026-09-08)

Status: OPEN
Entry point: this file

Seventh and last repo in the documentation-cleanup program. Method,
principles and program-level decisions live in **student-data-system**
`claude/projects/docs-cleanup/` (d1 cleanup design, d2 archive, d4 layout:
`docs/history/<initiative>/` + `docs/decisions/`); the reference tooling is
the `documentation-system` plugin's `docs-check.py` validator; qboard's d5
adds the cited-file carve-out and "behavioral decisions go to the repo's
spec surface"; rostering's d6 adds "reference misfiled as history gets
promoted to `docs/` (or `.claude/rules/`), not archived"; coach's d7 adds
the verified-banner rewrite of a stale root section; saga-dash's d8 adds the
"relocate an oversized leaf's reference sections, keep a ≤200-line leaf"
pattern. soa is itself the precedent every one of those repos points back
to — its root `CLAUDE.md` and the `pnpm soa:link:on/off/status` toggle are
what "canonical source for shared patterns" means across the program.

What is different about this repo (first look, before the surveys):

- Cleanest validator baseline in the program: **60 errors, 4 warnings, 12
  info** — no `claude-md-cap` violations at all, decision-status vocabulary
  already consistent, zero commented-out code.
- The one structural gap none of the other 6 repos had this badly: **zero
  `.claude/rules/`** and **no `docs/decisions/`**, despite being the repo
  every sibling names as canonical.
- `packages/node/saga-stack-cli` — 18 files under its own `docs/`, the
  largest single-package doc surface in the repo, powering 4 of 10 active
  initiatives — has no `CLAUDE.md` and is absent from the tier index.
- Four current-tier reference trees (`apps/node/claude/`, `apps/web/claude/`,
  `packages/node/claude/`, `python/claude/`, 819 lines) sit under a
  history-reserved `claude/` dirname — the `misplaced-history-dir` check's
  textbook case, and simultaneously the repo's first `.claude/rules/`
  candidates.
- A decision file cited 4× from live production code
  (`d-consumer-resilience.md`) is genuinely missing, no deletion record, no
  fragment findable elsewhere.
- 8 root-level loose files + 2 personal-notes dirs, none of it cross-linked,
  3 of it a dead CI-report trio from the same December merge.

Surveys (unedited subagent output): `01-doc-state.md` (validator baseline,
per-initiative table, root clutter, largest-leaves fact-check, rules
candidates, top 10, cross-repo angle), `02-inline-comments.md` (comment
density, large-block census, historic-marker census, never-touch inventory,
removable estimate). Decision: `docs-cleanup-d9-soa-shape.md`. Plan:
`cleanup-plan.md`. Eval set and runs: pending — this initiative has not yet
run the program's baseline/post-phase scoring pass.

Harvested to: pending.
