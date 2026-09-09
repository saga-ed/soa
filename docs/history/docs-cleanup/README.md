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
the meta-banner (`docs/history/docs-cleanup/CLAUDE.md`) updated to record
Phase A/B as landed instead of "not yet executed", and the missing `coach:`
prefix added to the decision doc's `gh_305` citation — which also cleared
an `archived-citation` false-positive (5 warnings -> 4).

Second correction: `memory-bank/` above turns out to be another wrongful
removal, on the same "not fixed" carve-out miss as `multi/` — this
program's own rule is that a cited file is never removed, and Cursor-tool
config counts as a citer. 6 of the 8 `.cursor/rules/*.mdc` files depend on specific
`memory-bank/*.md` files, and `claude/projects/gh_t54/sources/testing/README.md:132`
separately points at `/memory-bank/testing/` — a citer the original sweep
missed entirely. Restored in a follow-up commit: `memory-bank/` back in
place (22 files, unchanged), `docs/overview.md`'s repo-structure bullet for
it restored alongside. `human-notes/` stays removed — re-swept the whole
repo plus `.cursor/` and found no citer anywhere. The true final D9.1/D9.2
removal list is 6 items: `human-notes/`, `SCOPE_FIX_SUMMARY.md`,
`SETUP_SUMMARY.md`, `WORKFLOW_SUCCESS_SUMMARY.md`, `LOCAL_DEVELOPMENT.md`,
`docs/quickstart.md`. See `followups.md` for the full record of both
corrections.

D9.1 moves (`09d4b410`): `soa-audit.md`/`soa-remediation-plan.md` →
`docs/history/soa-audit-2026-01/` (banner: CLOSED 2026-03-27); loose file
`claude/projects/ss-develop-session-adm-plan.md` →
`docs/history/ss-develop-session-adm/plan.md` (banner: PAUSED — verified M0-M2
shipped against `saga-stack-cli`'s `session-adm.ts`, but M3's
`telemetry-demo-multi.sh` deprecation-shim conversion never happened, so not
CLOSED as the decision doc assumed). saga-dash's 3 citers repointed in that
repo's own commit (`a60e3dcb`).

Phase B complete. Validator: 13 errors/7 warnings/17 info (Phase A baseline)
→ 9 errors/4 warnings/11 info, including the fact-check-fixes commit above;
no new findings introduced by any Phase B commit or the fact-check
corrections, each checked individually before committing. Full report in
the session transcript; commit SHAs on this branch (soa) and in saga-dash.

## Phase C outcome

Layout move (D9.1/D9.7, `1256eb57` + the `f110606a` fix for a
multi-pathspec `git add` that silently dropped 32 files' worth of citer
repoints on the first attempt): all 9 `claude/projects/<initiative>/`
dirs and `multi/` moved to `docs/history/`; `claude/esm.md`,
`claude/frontend/`, `claude/tooling/pnpm.md` promoted to `docs/` with
verified banners (esm.md's stale code sample replaced with a current one
from `tgql-api`); `claude/skills/documentation-system/` archived to
`docs/history/vendored-documentation-system-skill/` (superseded by the
marketplace plugin); `claude/` removed entirely. Every in-repo citer
repointed — root `CLAUDE.md`, `.claude/rules/`, `.claude/skills/`, `apps/`
and `packages/` `CLAUDE.md`/`README.md` files, one code comment
(`saga-stack-cli/src/core/seed/datasets.ts:3`, comment-proof verified),
and `tools/synthetic-dev/up.sh:1843` (manually reviewed, `.sh` isn't
comment-proof-covered).

Cross-repo citers (D9.1, one commit per repo, pushed): saga-dash
(`48447113`, 4 occurrences across `playwright.stack.config.ts` and
`topology-design.md`), coach (`0fa66aa0`, 3 occurrences across
`apps/web/CLAUDE.md`, `module-viewer-port/README.md`, `quickstart.md`),
student-data-system (`93ef8440`, 1 occurrence in `sds_92/README.md`).
rostering, program-hub, qboard: swept, nothing found citing soa's moved
paths — no commit.

Archive (D9.7, `44b7dd50`): `gh_298` (research/+source/, 3 files, 408
lines) and `gh_401_2` (research/+source/, 2 files, 184 lines) fully
archived; `soa_75/research/` narrowed from D9.7's stated 3 files to 1
(`02-fleet-mutation-audit.md`, 209 lines) — the carve-out check found
the other 2 cited live from `soa_75/decisions/` itself
(`d-broker-choice.md:36`, `d-poc-location.md:30`), which D9.7 keeps live,
so they stay. Pre-archive SHA `f110606a8326a9cc8879399e3d2ee6a806874ca7`
recorded in each banner and the index.

D9.5 record-the-gap: `soa_75/README.md#missing-decisions` updated with a
citer Phase C's sweep found that D9.5's own analysis missed
(`packages/node/observability/README.md:54`) plus 4 bare cross-repo
citers of `d-preview-deploy-isolation.md` in `rostering` and
`program-hub` — see `followups.md`.

Validator: 9 errors/4 warnings/11 info (Phase B exit) → 8 errors/3
warnings/11 info. Not a flat carry-forward — three checks moved:
`misplaced-history-dir` 1 → 0 (the whole `claude/` dir cleared, the point
of the layout move); `archived-citation` 4 → 1 (3 of the 4 resolved
because their cited targets — `gh_t54`, `soa_75/README.md`,
`soa_75/decisions/` — now exist under `docs/history/`; the 4th,
`docs/history/e2e-testing/`, is cited from
`docs/decisions/docs-cleanup-d9-soa-shape.md:53` but was never created
under that name in this repo's history — pre-existing since Phase A/B,
outside D9.7's carve-out, left as-is); `decision-location` 0 → 2 (new,
not a regression — `soa_75/decisions/` and `synthetic-dev-align/decisions/`
were always non-centralized, this check just couldn't evaluate paths
under old `claude/`; D9.7 explicitly keeps both live under their
initiative dir rather than centralizing to `docs/decisions/`, so these
2 warnings are expected and intentional, not deferred debt). The 4
`code-doc-refs` and 4 `links` errors are unchanged findings; 3 of the 4
`links` errors moved path (`claude/skills/documentation-system/templates/*`
→ `docs/history/vendored-documentation-system-skill/templates/*`) without
resolving — pre-existing broken template placeholders, not part of D9's
fix list.

## Phase D outcome (comments)

Census's own recommendation list (`02-inline-comments.md` §9), `d08919d1` +
this commit: the 3 unqualified `sds_80` citations in `mesh-fixture-cli`
(`seed-attendance.ts`, `enroll.ts`) gained the `student-data-system:`
qualifier (both targets confirmed live at those paths in SDS's own
docs-cleanup worktree). The D9.5 dangling-citer set —
`rabbitmq/src/connection-manager.ts:70` and `event-outbox/create-pool.ts`
+ `event-envelope/preview-tag.ts` — now point at
`soa_75/README.md#missing-decisions` instead of the two decision docs that
never landed; `packages/node/observability/README.md`'s citer (found by
Phase C's sweep, not in D9.5's original count) got the same fix, matching
the wording already used in `event-consumer/README.md` and
`rabbitmq/README.md` (fixed in Phase C's `f110606a`, not re-touched here).
`event-consumer`/`rabbitmq`/`observability` are the only 3 `d-*.md` citers
this repo owns; the 4 bare cross-repo citers in `rostering` and
`program-hub` recorded in `followups.md` are untouched — out of this
program's per-repo scope.

`docs/promotion-pipeline.md`'s 3 shell-script citers
(`capture-local.sh:21`, `capture-sandbox.sh:23`, `up.sh`) had their
dangling reference dropped rather than the doc authored — no fragment of
it exists anywhere in the repo to write it from, the same call D9.6 made
for `npm-registry-publishing.md`. The 4 janus `@spec` tags in
`packages/node/api-util/src/utils/` moved to
`specs/contracts/drafts/saga-auth-signal.spec.md`, verified against
janus's `origin/main` tree before editing (the old path no longer
resolves there). D9.8's note that `saga-auth-url.ts:4` was the one
instance missing the `(janus repo)` qualifier had drifted from current
state: `saga-auth-url.ts:4` already carried it, and
`saga-auth-url.test.ts:5` was the actual gap — fixed there instead, per
current source over the decision doc's now-stale description.

`tools/synthetic-dev/up.sh`'s 65-line header (lines 3–67, service
topology near-duplicating `README.md`'s opening) trimmed to a 7-line
summary + pointer to `README.md`; two facts the header carried that
`README.md` didn't — the deterministic `db:seed` (`@saga-ed/*-seed-ids`,
stable ids across `--reset`) and the "Deferred: fleek recording stack,
dash→connect linking, `SAGA_API_TARGET` stays remote" note — added there
as prose. Verified with `bash -n`, a manual line-prefix diff review (every
changed line is a `#`-comment or blank), and a dry run of
`./up.sh --status` (exits 0, same output shape as before the trim).
`comment-proof.sh` covers the `.ts`/`.md` changes; the `.sh` changes fell
back to the manual review per the plan's `.sh` coverage note.

Validator: 8 errors/3 warnings/11 info (Phase C exit) → see this commit's
report for the post-Phase-D count.
