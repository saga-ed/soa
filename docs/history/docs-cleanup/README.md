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

## Phase B outcome (in progress)

D9.4 (`a9b621e8`): the four misplaced `apps/{node,web}/claude/`,
`packages/node/claude/`, `python/claude/` reference trees became
`.claude/rules/{testing-node,testing-web,event-driven,python-uv}.md` with
`paths:` frontmatter; shared testing reference moved to `docs/testing/`;
root `CLAUDE.md` and every leaf whose directory matches a rule's globs got
pointers (5 leaves needed it beyond the initial pass — `orphan-rule` is
mechanical, not a matter of judgment). D9.3 (`ce24b82b`): `saga-stack-cli`
got a 40-line `CLAUDE.md` (documents that the vendored-pair "byte-identical"
census claim is only true for one of its two scripts) plus its row and 7
other undocumented packages' rows in `packages/node/CLAUDE.md`. D9.6
(`be69e9be`, `0ff06ec8`): onboarding cluster (root README Quickstart +
`LOCAL_DEVELOPMENT.md` + `docs/GETTING-STARTED.md` + `docs/quickstart.md`)
merged into one verified `docs/GETTING-STARTED.md`; publishing cluster
cross-linked, excluding `manual-package-management.md`/
`github-packages-migration.md` from the "4 real docs" cross-link — both are
self-marked DEPRECATED, contradicting the decision doc's framing. D9.2
(`8e519e29`): `HowToAddPubsub.md` → `docs/how-to-add-pubsub.md`, rewritten
against the real `apps/node/trpc-api/src/sectors/pubsub/` implementation
after every code sample proved to drift from current
`@saga-ed/soa-pubsub-{core,server}` (missing `soa-` prefixes, a
nonexistent `AbstractTRPCController`/`ActionCtx`/`RedisAdapter`, a
`ControllerLoader` test pattern the new `testing-node.md` rule forbids).

D9.1/D9.2 removals (`ff92faa5`): `git rm` of `claude/projects/multi`,
`human-notes/`, `memory-bank/`, `SCOPE_FIX_SUMMARY.md`, `SETUP_SUMMARY.md`,
`WORKFLOW_SUCCESS_SUMMARY.md`, plus `LOCAL_DEVELOPMENT.md` and
`docs/quickstart.md` (superseded by the D9.6 merge). Pre-removal HEAD:
`8e519e29`. Citation sweep (whole repo + the 6 sibling docs-cleanup
worktrees) found two real citers the decision doc's "nothing else cites it
live" verdict missed: `docs/overview.md`'s repo-structure listing (fixed in
this commit) and 5 `.cursor/rules/*.mdc` files that depend on
`memory-bank/*.md` content (Cursor-tool config, out of this initiative's
scope — recorded in `followups.md` instead of fixed). Also resolved a
pre-existing `followups.md` item: `gh_214/README.md`'s `../multi/`
cross-reference, dropped in the same commit. No real citers found in
rostering, saga-dash, student-data-system, program-hub, qboard, or coach.

Correction (Phase A fact-check): removing `claude/projects/multi/` above
proved a mistake — a fact-check pass found it cited as live prior art from
`gh_214/research/06-multi-instance-analysis.md` and
`01-synthetic-dev-inventory.md:105` under the stale name
`multi-synthetic-dev`, and `gh_214` is OPEN, so D9.7's carve-out applies.
Restored in a follow-up commit: `multi/` back in place, both research files'
stale name fixed to `multi`, and `gh_214/README.md`'s `../multi/`
cross-reference bullet restored. See `followups.md` for the full record.
The same commit applied the fact-check's other 3 findings: `Last activity:`
lines added to `gh_305`/`gh_t54`/`synthetic-dev-align`'s banners
(2026-07-14 / 2026-02-01 / 2026-06-25, each verified against `git log`),
this file's own status line updated to reflect Phase A/B as landed, and the
missing `coach:` prefix added to the decision doc's `gh_305` citation.

D9.1 moves (`09d4b410`): `soa-audit.md`/`soa-remediation-plan.md` →
`docs/history/soa-audit-2026-01/` (banner: CLOSED 2026-03-27); loose file
`claude/projects/ss-develop-session-adm-plan.md` →
`docs/history/ss-develop-session-adm/plan.md` (banner: PAUSED — verified M0-M2
shipped against `saga-stack-cli`'s `session-adm.ts`, but M3's
`telemetry-demo-multi.sh` deprecation-shim conversion never happened, so not
CLOSED as the decision doc assumed). saga-dash's 3 citers repointed in that
repo's own commit (`a60e3dcb`).

Phase B complete. Validator: 13 errors/7 warnings/17 info (Phase A baseline)
→ 9 errors/5 warnings/11 info; no new findings introduced by any Phase B
commit, each checked individually before committing. Full report in the
session transcript; commit SHAs on this branch (soa) and in saga-dash.
