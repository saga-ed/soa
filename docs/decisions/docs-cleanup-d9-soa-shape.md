---
status: Accepted
---

# d9 — soa: shape of the documentation cleanup

Status: **RESOLVED 2026-09-08** — all eight recommendations accepted
(D9.1–D9.8 = A; D9.2 per its table).

## Context

Seventh and last repo in the docs-cleanup program. The doc-state survey
(`../history/docs-cleanup/research/01-doc-state.md`) found the cleanest validator baseline of any repo so far
(60 errors, 4 warnings, 12 info — no `claude-md-cap` violations at all) but a
structural gap the others didn't have: soa is the platform every sibling repo
names as "canonical source for shared patterns," yet it has zero
`.claude/rules/` and no `docs/decisions/`. Ten `links` root causes account for
41 of 45 findings; the two real gaps are a genuinely missing decision file
(`d-consumer-resilience.md`, cited 4× from live code) and a stray-dot typo
(`.claude/projects/` vs. `claude/projects/`) repeated 3× in prose, invisible
to the link checker. Four current-tier reference trees sit under a
history-reserved `claude/` dirname (`misplaced-history-dir`, 819 lines, zero
history in them). `packages/node/saga-stack-cli` — 18 files under its own
`docs/`, powering 4 of the repo's 10 active initiatives — has no `CLAUDE.md`
and is absent from `packages/node/CLAUDE.md`'s own index, alongside 7 other
undocumented packages. Root carries 8 loose files and 2 dirs of clutter
(3 dead CI reports, a stale audit + remediation plan, a 1,138-line orphaned
guide, 2 personal-notes trees — `memory-bank/` is larger than the survey's
"broken 6-phase scaffold" framing suggests: spot-check found 15 loose notes
files directly under it, not just the one surviving `testing/` phase). Two soa-side citations into saga-dash are
already confirmed broken from that repo's own survey; a 4× cross-repo `@spec`
tag into janus points at a path janus moved. Comment census
(`../history/docs-cleanup/research/02-inline-comments.md`) found the highest load-bearing rate of the program
(90% of sampled blocks, 0% historic narrative, ~2–5% removable) — Phase D
here is small and mostly citation-qualifier fixes, not relocation.

Program decisions d1/d2/d4 (SDS), d5 (qboard), d6 (rostering: reference
misfiled as history is promoted to `docs/`, not archived), d7 (coach), d8
(saga-dash) apply unless overridden below.

## D9.1 — `claude/projects/` layout and its outliers

- **A (recommended)**: d4 — `claude/projects/<initiative>/` →
  `docs/history/<initiative>/` (≤15-line banner + README + one index) for the
  9 real initiatives (`gh_214`, `gh_298`, `gh_305`, `gh_355`, `gh_375`,
  `gh_401_2`, `gh_t54`, `soa_75`, `synthetic-dev-align` — see D9.7 for which
  archive). `multi/` is not an initiative (§2: no GH tie, generic "Claude Code
  multi-agent workflows" reference dated January 2026, not soa-specific) —
  remove it (SHA recorded, D9.2) rather than move it under `docs/history/`;
  nothing cites it. `ss-develop-session-adm-plan.md` (the loose file, not a
  dir) moves to
  `docs/history/ss-develop-session-adm/` with its own banner, and its 3+
  saga-dash citers (`docs/history/e2e-testing/{CLAUDE,README}.md`,
  `docs/history/README.md:32`) get repointed in the same PR — same
  precedent as `gh_880`/qboard-d5.1. `human-notes/` and `memory-bank/` are
  personal dev-notes trees, not initiative history — see D9.2 (they read
  together with the root-clutter items, not with `claude/projects/`).
  `gh_t54` gets no special handling beyond the standard move: 7 months stale
  and pre-dates the `gh_<issue>` convention, but its own content (a
  cross-repo CLAUDE.md-hierarchy design, possibly still referenced by nimbee
  PR 7876, unverified) doesn't justify inventing a new bucket for one file.
- **B**: d4 for the 9 real initiatives only; leave `multi/` and
  `ss-develop-session-adm-plan.md` where they are. Less churn, but leaves a
  non-initiative masquerading as one and a loose file with no home either way.

Recommendation: **A** (high — `multi/` misfiled is unambiguous once GH-tie
checked; the loose file follows an already-established precedent).

## D9.2 — Root clutter (8 files + 2 dirs)

Per-file verdict, evidence from §4/§6 of the survey. Nothing in this program
is deleted outright: every "Remove" below is `git rm` with the pre-removal
SHA recorded in the Phase B commit message and in the relevant
banner/README/index/`followups.md` entry, so `git show <sha>:<path>`
retrieves the content — a reversible removal, not a loss.

| File | Verdict | Why |
|---|---|---|
| `SCOPE_FIX_SUMMARY.md` | **Remove (SHA recorded)** | Dead one-off report, uncited, internally garbled (states an identical before/after scope) |
| `SETUP_SUMMARY.md` | **Remove (SHA recorded)** | Dead CI/CD point-in-time snapshot, uncited |
| `WORKFLOW_SUCCESS_SUMMARY.md` | **Remove (SHA recorded)** | Same shape, uncited |
| `soa-audit.md` (770L) | **Move to history** | Point-in-time output of the `claude-audit` skill (23 packages; repo now has 26 under `packages/node/*` alone) — real artifact of a real audit run, belongs under a `docs/history/soa-audit-2026-01/` banner, not removed |
| `soa-remediation-plan.md` (272L) | **Move to history** | Companion to the audit above; 2 of its 3 predicted end-states never happened (D9.8) — historical value as "what was planned," not current guidance |
| `HowToAddPubsub.md` (1,138L) | **Promote to `docs/`** | Largest orphaned file in the repo; `pubsub-core/-client/-server` packages still exist and are documented in the tier CLAUDE.md, but this guide duplicates that ground at far more depth and is linked from nowhere — move to `docs/how-to-add-pubsub.md`, cross-link from `packages/node/CLAUDE.md`'s pubsub row, verify against current `pubsub-core` API as it moves (d6-style banner) |
| `LOCAL_DEVELOPMENT.md` (199L) | **Merge into onboarding cluster** | Duplicates `docs/GETTING-STARTED.md` / `docs/quickstart.md` (D9.6) rather than standing alone; fold its verified-accurate commands (`ci:check`, `quick:check`) into the merged doc, then remove this file (SHA recorded) |
| `README.md` (68L) | **Fix in place** | Entry point, must stay at root; 3 stale claims fixed as part of Phase A (D9.8) |
| `human-notes/` (4 files) | **Remove (SHA recorded) — user's call** | Personal notes, one file a raw pasted chat transcript; not documentation, nothing else cites it live (its own `arc.png` link is broken). These may be Seth's own working notes rather than dead scaffolding — flagging the recommendation, not executing it unreviewed; removal is fully reversible via the recorded SHA if any of it turns out to matter |
| `memory-bank/` (15 loose files + `testing/` subdir, 7 files) | **Remove (SHA recorded) — user's call** | Broader than the survey's "broken 6-phase scaffold" framing — spot-check found 15 personal-notes files directly under `memory-bank/` (`naming-conventions.md`, `unit-testing.md`, `turborepo.md`, etc.) plus the `testing/` subdir, none of it cited, none of it distinguishable from `human-notes/` in kind. Same caveat as above: personal notes, not scaffolding — the user's call, reversible via SHA |
| `arc.png` | **Keep at root** | Live, correctly cited from `README.md`; only `human-notes/current-chat.md`'s citation is broken and that file is being removed anyway |

Recommendation: **as tabled above** (high for the 5 removal items — uncited,
dead, or personal, all SHA-recorded and reversible; medium for
`HowToAddPubsub.md` promotion — value is clear but the fact-check against
current `pubsub-*` code is mandatory before it lands in `docs/`; the
`human-notes/`/`memory-bank/` removals specifically need Seth's sign-off
before executing, since they read as personal working notes rather than
project scaffolding).

## D9.3 — `saga-stack-cli` documentation surface

18 files under `packages/node/saga-stack-cli/docs/` (the largest
single-package doc surface in the repo), powering 4 of 10 active initiatives
(`gh_214`, `gh_298`, `gh_355`, `gh_375`), with no `CLAUDE.md` and no entry in
`packages/node/CLAUDE.md`'s package index.

- **A (recommended)**: add a ≤40-line `packages/node/saga-stack-cli/CLAUDE.md`
  (purpose — the `ss` CLI driving the synthetic dev stack per the
  `saga-iac:ss` skill — the vendored-pair convention with
  `tools/synthetic-dev/*`, pointer into its own `docs/` as the reference
  surface, "Rules that apply here" once D9.4's `.claude/rules/` lands) and add
  the missing row to `packages/node/CLAUDE.md`'s index alongside the other 7
  undocumented packages (`contract-check`, `health`, `inspect`, `mailer`,
  `mesh-fixture-cli`, `postgres`, `preview-headers`). The package's own
  `docs/*.md` files stay where they are — package-relative citations from
  `saga-stack-cli/src/**` into them already resolve correctly (§4) — this
  decision is only about the missing tier-index entry, not about relocating
  the 18 files into repo-root `docs/`.
- **B**: relocate the 18 files into `docs/saga-stack-cli/` to match the
  repo's top-level `docs/` surface. Rejected: `docs/tunnel.md`,
  `docs/e2e-review.md`, `docs/instrumentation.md` are cited 18× from
  `saga-stack-cli/src/**` using the current package-relative path; moving
  them breaks 18 live citations to fix a discoverability problem a tier
  CLAUDE.md solves for free.

Recommendation: **A** (high — the fix is additive, doesn't touch the 18
existing citations, and closes the single largest tier-index gap in the
repo).

## D9.4 — The four misplaced-history-dir trees → `.claude/rules/`

`apps/node/claude/testing.md`, `apps/web/claude/testing.md`,
`packages/node/claude/{testing,event-driven}.md`, `python/claude/uv.md` — 819
lines, all current-tier reference, none of it history, sitting under a
dirname the validator's layout convention reserves for initiative tracking.
soa has zero `.claude/rules/` today (§7), so this is also the repo's first
adoption of the mechanism.

- **A (recommended)**: convert to `.claude/rules/*.md` with `paths:`
  frontmatter, per d6's "reference misfiled as history is promoted, not
  archived":
  - `.claude/rules/testing-node.md` (`paths: apps/node/**, packages/node/**`)
    — merges `apps/node/claude/testing.md` (163L) +
    `packages/node/claude/testing.md` (87L); both currently point back to the
    same shared `claude/testing/{README,philosophy,conventions,builders}.md`
    (305L), which stays as unscoped shared reference, not folded in.
  - `.claude/rules/testing-web.md` (`paths: apps/web/**`) —
    `apps/web/claude/testing.md` (82L).
  - `.claude/rules/event-driven.md` (`paths: packages/node/event-*/**,
    packages/node/observability/**`) — `packages/node/claude/event-driven.md`
    (153L), canonical for 6 packages already pointing at it by path from
    `packages/node/CLAUDE.md`; fix the 3× stray-dot typo
    (`.claude/projects/` → `claude/projects/`) in this file as part of the
    move (D9.8).
  - `.claude/rules/python-uv.md` (`paths: python/**`) — `python/claude/uv.md`
    (334L), the largest `claude/*` reference file outside `claude/projects/`.
  - Frontend patterns (`claude/frontend/{shared,sveltekit,nextjs}/`, 4 files)
    are **not** one of the 4 `misplaced-history-dir` findings (they already
    live under root `claude/`, not a nested tree) — leave for a future pass;
    out of scope for this decision.
- **B**: leave all four where they are, accept the recurring
  `misplaced-history-dir` validator finding. Rejected — these are exactly the
  shape `.claude/rules/` exists for (six of soa's CLAUDE.md files already
  point at the testing docs by manual path; the rules mechanism makes that
  automatic).

Recommendation: **A** (high — this is d6's precedent applied literally; the
`paths:` scopes are unambiguous from existing citer patterns).

## D9.5 — Missing/dangling decision docs cited from live code

Two targets, both cited from production source with no deletion record:
`claude/projects/soa_75/decisions/d-consumer-resilience.md` (4 citers:
`event-consumer/README.md` ×2, `rabbitmq/README.md`,
`connection-manager.ts:70`, describing numbered poison-message/broker-startup
resilience patterns) and bare-filename `d-preview-deploy-isolation.md` (2
citers: `event-outbox/src/create-pool.ts:41`,
`event-envelope/src/preview-tag.ts:8`, no path component at all).

- **A (recommended)**: record-the-gap for both, no GitHub issue filed by this
  program. `soa_75/decisions/` holds 12 other `d-*.md` files but never this
  one — no git deletion record, no findable content under another name
  (§0/§6) — the survey ruled out reconstruction as unverifiable, not merely
  unfound. Mechanism: add a "Missing decisions" section to
  `docs/history/soa_75/README.md` (the initiative's own README, created in
  Phase A/C per D9.1) naming both files
  (`decisions/d-consumer-resilience.md`, `d-preview-deploy-isolation.md` —
  the latter's bare filename never even resolved to a location), their
  citers (`event-consumer/README.md` ×2, `rabbitmq/README.md`,
  `connection-manager.ts:70`, `event-outbox/src/create-pool.ts:41`,
  `event-envelope/src/preview-tag.ts:8`), and stating plainly that no
  deletion record or draft exists for either. Each code citer gets a
  one-line comment pointing at that README section instead of at a doc that
  doesn't exist, e.g. `// resilience patterns: decision doc never landed,
  see docs/history/soa_75/README.md#missing-decisions`. The gap itself also
  goes into `followups.md` so the user can file a tracking issue if they
  want one — this program records gaps, it doesn't open GitHub issues on
  the user's behalf.
- **B**: reconstruct both from the citing code + PR history. Rejected per the
  program's own bias (recommended in the prompt) — reconstruction is
  docs-only in mechanism but risks inventing history that reads as
  authoritative when it isn't; the survey found no fragment of either
  document anywhere in the repo to reconstruct *from*, only descriptions of
  the patterns each decision was supposed to justify.

Recommendation: **A** (high — reconstruction has no source material to work
from; a documented gap in the initiative's own README is honest about what's
missing where a fabricated doc wouldn't be).

## D9.6 — Two overlapping doc clusters

**Onboarding** (5 docs: root `README.md` Quickstart, `docs/GETTING-STARTED.md`,
`docs/quickstart.md`, `docs/overview.md`, `docs/saga-soa-tlrd.md`) — 3 of 5
describe a pre-restructuring package layout (`packages/logger`,
`apps/examples/rest-api`, `apps/docs`) that no longer exists, and even the
newest (`quickstart.md`, 2026-03-27) undershoots the current Node version
requirement. **Package-publishing** (5 docs: `CODEARTIFACT_SETUP.md`,
`cicd-package-publishing.md`, `package-registry-quickstart.md`,
`github-packages-migration.md`, `manual-package-management.md`) — 2 of 5
dangle a link to a `npm-registry-publishing.md` never written, one links a
renamed CI workflow, none cross-links the other 4 as "start here."

- **A (recommended)**: merge + verify + cross-link, one cluster at a time.
  Onboarding: consolidate root `README.md` Quickstart + `LOCAL_DEVELOPMENT.md`
  (D9.2) + `docs/GETTING-STARTED.md` + `docs/quickstart.md` into a single
  verified `docs/GETTING-STARTED.md` (fix all 3 stale-layout claims and the
  Node version against `package.json`'s `>=24`), keep `docs/overview.md` and
  `docs/saga-soa-tlrd.md` as separate architecture-shaped docs but link them
  from the merged onboarding doc's top. Publishing: keep the 4 real docs
  separate (they cover distinct audiences — CodeArtifact setup vs. CI
  automation vs. manual fallback vs. quickstart) but add a "See also" block
  cross-linking all 4, fix the renamed-workflow link, and either write the
  missing `npm-registry-publishing.md` (if the content is small enough to
  extract from the other 4) or drop the 2 dangling references to it.
- **B**: leave both clusters as-is, let the validator keep flagging the
  dangling links individually. Rejected — the clusters are the kind of
  undiscoverable duplication d8 flagged in saga-dash's onboarding docs; the
  fix is cheap relative to the confusion 5 unlinked "start here" docs cause a
  new contributor.

Recommendation: **A** (medium — the onboarding merge is high-confidence
(each doc's stale claim is independently verified in §6), the publishing
cross-link is low-risk, but whether to write vs. drop
`npm-registry-publishing.md` needs a quick read of whether the content
exists in fragments across the other 4 first).

## D9.7 — Archive scope

- **A (recommended)**: archive research/evidence of the 2 confirmed
  CLOSED-with-no-external-citers initiatives, both verified via
  `gh issue view --json state,closedAt` — `gh_298` (CLOSED 2026-07-16,
  no CLAUDE.md ever existed) and `gh_401_2` (CLOSED 2026-08-04,
  self-documents its own saga-ed/rostering provenance, no CLAUDE.md). Full
  content, pre-archive SHA recorded in each dir's banner/README/index row.
  For `soa_75` (CLOSED 2026-05-26): archive only its 3-file `research/`
  (`01-current-architecture.md`, `02-fleet-mutation-audit.md`,
  `03-event-driven-microservices-reference.md`) — its 12-file `decisions/`
  stays live in `docs/history/soa_75/decisions/` in full, kept as one atomic
  folder rather than pulling just the 1 cited file, since `d-soa-pubsub-divorce.md`
  is cited from current-tier `packages/node/CLAUDE.md` itself (an in-repo
  dependency, not just cross-repo) and the other 11 decisions document the
  same POC's reasoning as a set. **Carve out and never archive** (fully
  live, no partial split): `gh_214` (saga-dash cites it live via
  `playwright.stack.config.ts:327`, plus it's OPEN), `gh_305` (CLOSED but
  coach cites it live from `coach:docs/history/module-viewer-port/README.md:23`),
  `ss-develop-session-adm-plan.md` (saga-dash cites it 3×), `gh_355` and
  `gh_375` (both OPEN). **`gh_t54` is excluded from the archive set
  entirely** — it has no matching GH issue at all (§2: "t54" predates the
  `gh_<issue>` convention), so "CLOSED" cannot be established and the
  program's archive-only-CLOSED-initiatives gate doesn't admit it; move it
  to `docs/history/gh_t54/` whole (research + sources, 15 files under
  `sources/` including a testing-decisions research doc and a zip) and
  leave it live, on the same footing as the OPEN initiatives, until either a
  GH issue is retroactively tied to it or nimbee PR 7876's dependency on it
  is confirmed or ruled out. `soa-audit.md` / `soa-remediation-plan.md`
  (D9.2) join the archive as their own `docs/history/soa-audit-2026-01/`
  dir, not folded into any GH-tied initiative — this pair has no GH tie
  either, but the "archive-only-CLOSED" gate is about initiatives, and this
  is a root-level audit artifact, not an initiative directory.
- **B**: archive nothing this pass, leave all 9 initiative dirs live under
  `docs/history/`. Simpler, but leaves 2 initiatives closed since July with no
  external citers sitting in the active search surface indefinitely.

Recommendation: **A** (high — both archived initiatives are GH-API-verified
CLOSED with no external citers; `soa_75`'s split is a clean file-level
divide, not a guess; `gh_t54` is pulled out of the archive question rather
than resolved by an unverified guess about nimbee PR 7876).

## D9.8 — Stale predicted end-state and janus `@spec` drift

Two distinct staleness findings needing different treatment:

- **`soa-remediation-plan.md`'s predicted end-state** (dated 2026-03-27):
  claims `trpc-api`/`trpc-codegen` were "removed" and `web-client` was
  "Migrating to SvelteKit immediately." 5+ months later, `trpc-api` is still
  fully present with its own 90-line CLAUDE.md, `web-client` is still Next.js
  15 — only `bin/trpc-codegen` (a now-dead symlink) actually went. This is a
  **history** fact, not a current-pattern one: the plan moves to
  `docs/history/soa-audit-2026-01/` (D9.7) as-is, un-rewritten — it documents
  what was planned, and fixing its language to match reality would erase the
  historical record of the divergence. No verified rewrite; the current-tier
  facts already live correctly in `apps/node/trpc-api/CLAUDE.md` and
  `apps/web/web-client/CLAUDE.md`.
- **janus `@spec` tag drift** (4 occurrences,
  `packages/node/api-util/src/utils/{saga-auth-url,dev-perimeter-config,dev-perimeter-production}.ts`
  + `.test.ts`, citing `janus:specs/contracts/saga-auth-signal.spec.md`,
  moved to `specs/contracts/drafts/saga-auth-signal.spec.md`): this is a
  **live code annotation**, not a doc — falls under Phase D (comments), not
  Phase A/B/C. Fix: update all 4 tags to the `drafts/` path, verified against
  janus's current tree before the edit lands (never rewrite a cross-repo
  `@spec` tag without checking the target first, per the census's §8
  never-touch note). Also add the missing "(janus repo)" qualifier to
  `saga-auth-url.ts:4`, the one instance missing it.

Recommendation: **record-as-history for the remediation plan, verified
in-place fix for the `@spec` tags** (high for both — the plan's
un-reconciled state is itself the finding worth preserving; the `@spec` fix
is a mechanical 4-line change once janus's current path is confirmed, which
this survey already did).

## Phases

**A** — Structure: authority-by-location paragraph + layout declaration in
root `CLAUDE.md` (still 50/200 lines, room to add both); rules index once
D9.4's 4 rules exist; banners (≤15, `Status:`) + READMEs + one index for the
9 real initiatives (D9.1); the 7 root-cause link clusters + one-off breaks
(§0); stale facts (§6: `packages/node/CLAUDE.md`'s Node 20+ claim, the
3× stray-dot typo, root `README.md`'s 3 stale claims, `docs/quickstart.md`'s
Node version).

**B** — Promote/relocate: D9.1 (`multi/` removal, loose-file move), D9.2
(root-clutter removals/moves/promotions), D9.3 (`saga-stack-cli` leaf +
index row), D9.4 (4 rules), D9.6 (cluster merges).

**C** — Layout move + archive: `claude/projects/*` → `docs/history/*`;
cross-repo citers repointed (saga-dash's `ss-develop-session-adm-plan.md`
citations, coach's `gh_305` citation); D9.7 archive with pre-archive SHAs;
`claude/` removed once empty.

**D** — Comments: per the census's own recommendation list (§9: the 3
`sds_80` cross-repo qualifier fixes, the 2 within-repo dangling
citation fixes from D9.5, the `docs/promotion-pipeline.md` 3-citer cluster,
the janus `@spec` fix from D9.8, the `tools/synthetic-dev/up.sh` header
Relocate) — `comment-proof.sh` covers `.ts/.js/.mjs?/.svelte/.yaml`, not
`.sh`, so the `up.sh` header trim and the 2 `tools/synthetic-dev/*.sh`
citation fixes get manual before/after diff review instead of the mechanical
gate.

**E** — Measure: validator re-run after each phase; eval set scored against
baseline (60/4/12) same as the other 6 repos in the program.

## Related artifacts

- `../history/docs-cleanup/research/01-doc-state.md` (§0 validator split, §2
  per-initiative table, §4 root clutter, §5 largest-leaves fact-check, §7
  rules candidates, §8 top 10, §9 cross-repo)
- `../history/docs-cleanup/research/02-inline-comments.md` (§1 density, §2
  large blocks, §8 never-touch, §9 removable estimate + starting files)
- `../history/docs-cleanup/plans/cleanup-plan.md` — phased execution plan
- Program decisions: SDS `claude/projects/docs-cleanup/decisions/{d1-cleanup-design,d2-history-search-surface,d4-history-dir-name}.md`;
  qboard `docs/decisions/docs-cleanup-d5-qboard-shape.md`; rostering
  `docs/decisions/docs-cleanup-d6-rostering-shape.md`; coach
  `docs/decisions/docs-cleanup-d7-coach-shape.md`; saga-dash
  `docs/decisions/docs-cleanup-d8-saga-dash-shape.md`
