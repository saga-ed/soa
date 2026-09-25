# soa docs-cleanup — execution plan (phases A–E)

Assumes d9's recommendations (`docs-cleanup-d9-soa-shape.md`); adjust if any
decision resolves differently. Evidence: `01-doc-state.md` (§ numbers below)
and `02-inline-comments.md`. Every phase ends with `docs-check.py --all`, a
commit, a push; an eval run follows A, B, C and D on a detached worktree.
Constraints for every phase: docs/comments only, no application-behavior
change (`comment-proof.sh` where it applies — see Phase D note on `.sh`
coverage), commit author/trailers per the program, no PRs until the end.

## Phase A — structure

- Root `CLAUDE.md` (currently 50/200 lines — cleanest baseline in the
  program, §3): add an authority-by-location paragraph and a layout
  declaration (`docs/history/<initiative>/`), matching every other repo's
  d1-derived structure; no existing content needs shortening to make room.
- Stale facts, fixed in place (§6): `packages/node/CLAUDE.md:10,49` "Target:
  Node.js 20+ (ESM)" → `>=24` (matches root `CLAUDE.md:31-32` and
  `package.json`); `docs/quickstart.md:7` "Node.js: v20+ (recommended:
  v22.x)" → `>=24`; the 3× stray-dot typo
  (`packages/node/CLAUDE.md:43`, `packages/node/claude/event-driven.md:3,153`)
  `.claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md` →
  `claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md`; root
  `README.md:20,32,40` — "apps (web, docs)" → note the doc app is nested at
  `apps/web/docs/`, drop the nonexistent `apps/examples/rest-api` line, swap
  the `hipponot` project-board org for `saga-ed`.
- Links — the 7 root-cause clusters from §0, one fix each:
  1. `claude/projects/gh_t54/research/testing-decisions.md` — add the
     missing `../` hop to every link in the "Documentation Structure"
     tables (lines 13, 397-400, 406-408, 414-419).
  2. `claude/projects/synthetic-dev-align/source/pr-152-*.md` (3 files) —
     rewrite intra-doc links to carry the `pr-152-` prefix applied on import
     (confirmed against `pr-152-meta.md`'s original-filename list).
  3. `.claude/skills/claude-audit/SKILL.md:189` — `../../docs/claude-audit.md`
     → `../../../docs/claude-audit.md`.
  4. `docs/claude-hierarchy-summary.md:113` — `../claude/gh_t54/plan.md` →
     `../claude/projects/gh_t54/research/plan.md`.
  5. `docs/github-packages-migration.md:189`,
     `docs/manual-package-management.md:267` — drop the
     `./npm-registry-publishing.md` link (never written, no deletion record)
     pending D9.6's cluster-merge decision on whether to author it instead;
     `manual-package-management.md:268` — `../.github/workflows/publish-packages.yml`
     → `publish-all-packages.yml` / `publish-codeartifact.yml` (renamed).
  6. `human-notes/current-chat.md:102,185` — `arc.png` → `../arc.png`. Moot
     if D9.2's removal lands first; fix only if the removal is deferred past
     Phase A.
  7. `memory-bank/testing/README.md:67-69,84-86` — drop the 6 links to
     `../{development,planning,deployment,documentation,maintenance}/`
     (directories that were never created). Moot if D9.2's removal lands
     first; fix only if the removal is deferred past Phase A.
  One-offs: `infra/docs/hands-on-tutorial.md:26` anchor (heading gained a
  "(simpler, no profiles)" suffix, update the anchor); `infra/docs/troubleshooting.md:125`
  drop the `../CHANGELOG.md` link (never existed); `packages/node/saga-stack-cli/docs/snapshots.md:89`
  anchor into `tunnel.md` — retarget to whichever current heading covers
  "seed launchable connect sessions."
- `code-doc-refs`: `tools/synthetic-dev/{capture-local,capture-sandbox}.sh`
  and `up.sh:417`'s `docs/promotion-pipeline.md` comments — resolved by
  D9.6's decision to author the doc or drop the reference; land whichever
  Phase D's census entry (§3 below) settles on.
- `archived-citation`: the 1 real hit
  (`claude/projects/soa_75/decisions/d-consumer-resilience.md`, 4 citers) —
  record-the-gap per D9.5 (a "Missing decisions" section in
  `docs/history/soa_75/README.md`, not a GitHub issue), land the citer
  comment updates in Phase D, not Phase A (they're `.ts`/`.md` source
  edits, not doc-to-doc links) — the README section itself can land in
  Phase A/C alongside `soa_75`'s banner.
- Initiative banners (≤15 lines, `Status:` from §2's table) + READMEs where
  missing + `claude/projects/README.md` index for the 9 real initiatives
  (`gh_214` ACTIVE, `gh_298` CLOSED 2026-07-16, `gh_305` CLOSED 2026-07-16,
  `gh_355` OPEN, `gh_375` OPEN, `gh_401_2` CLOSED 2026-08-04, `gh_t54`
  pre-convention/ACTIVE-by-default since undated, `soa_75` CLOSED
  2026-05-26, `synthetic-dev-align` open/research). `multi/` and
  `ss-develop-session-adm-plan.md` are excluded from the index — they move
  or are removed in Phase B/C per D9.1, not banner-ized in place.

## Phase B — promote / relocate

- D9.1: `git rm` `claude/projects/multi/` (not GH-tied, not soa-specific,
  uncited) with the pre-removal SHA recorded in the Phase B commit message
  and `followups.md`; move `claude/projects/ss-develop-session-adm-plan.md`
  to `docs/history/ss-develop-session-adm/` with its own banner — do this
  *before* Phase C's bulk layout move so the saga-dash citer-repoint lands
  as one clean commit, not two.
- D9.2: nothing here is deleted outright — every removal below is `git rm`
  with the pre-removal SHA recorded in the Phase B commit message and in
  the relevant index/`followups.md` entry, retrievable via
  `git show <sha>:<path>`. Remove `SCOPE_FIX_SUMMARY.md` (garbled,
  uncited), `SETUP_SUMMARY.md`, `WORKFLOW_SUCCESS_SUMMARY.md`; remove
  `human-notes/` and `memory-bank/` (both personal-notes trees, uncited
  apart from `human-notes/current-chat.md`'s own broken self-link — flag
  both to the user as possible working notes rather than dead scaffolding
  before executing, since the removal is their call even though it's
  reversible);
  move `soa-audit.md` + `soa-remediation-plan.md` to
  `docs/history/soa-audit-2026-01/` with a banner (pre-move SHA recorded,
  content unedited per D9.8's record-as-history call); promote
  `HowToAddPubsub.md` to `docs/how-to-add-pubsub.md`, verifying its content
  against the current `pubsub-core`/`pubsub-client`/`pubsub-server` API as
  it moves, and add a pointer from `packages/node/CLAUDE.md`'s pubsub row;
  fold `LOCAL_DEVELOPMENT.md`'s verified-accurate commands into the merged
  onboarding doc (below), then remove the standalone file (SHA recorded).
- D9.3: new `packages/node/saga-stack-cli/CLAUDE.md` (≤40 lines: purpose,
  vendored-pair convention with `tools/synthetic-dev/*`, pointer into its
  own 18-file `docs/`); add its row plus the other 7 undocumented packages
  (`contract-check`, `health`, `inspect`, `mailer`, `mesh-fixture-cli`,
  `postgres`, `preview-headers`) to `packages/node/CLAUDE.md`'s index table.
- D9.4: 4 new `.claude/rules/` files — `testing-node.md`
  (`paths: apps/node/**, packages/node/**`, merging `apps/node/claude/testing.md`
  + `packages/node/claude/testing.md`), `testing-web.md`
  (`paths: apps/web/**`, from `apps/web/claude/testing.md`),
  `event-driven.md` (`paths: packages/node/event-*/**, packages/node/observability/**`,
  from `packages/node/claude/event-driven.md`), `python-uv.md`
  (`paths: python/**`, from `python/claude/uv.md`) — each with a
  `Referenced from:` footer; the 4 old nested `claude/*.md` files are
  removed once their content is folded in (`git mv`-then-edit where the
  content transfers verbatim, to preserve history).
- D9.6: merge root `README.md` Quickstart + `docs/GETTING-STARTED.md` +
  `docs/quickstart.md` into a single verified `docs/GETTING-STARTED.md`
  (fix the `packages/logger` → `packages/node/logger`, `apps/examples/rest-api`
  → `apps/examples/web-client`, `apps/docs` → `apps/web/docs/` claims, and
  the Node version, all confirmed stale in §6); keep `docs/overview.md` and
  `docs/saga-soa-tlrd.md` separate but link them from the merged doc's top;
  add a "See also" cross-link block across the 4 surviving publishing docs
  (`CODEARTIFACT_SETUP.md`, `cicd-package-publishing.md`,
  `package-registry-quickstart.md`, `github-packages-migration.md`,
  `manual-package-management.md`) and resolve the `npm-registry-publishing.md`
  dangling link per whichever side of D9.6 the decision lands on (author or
  drop).

## Phase C — layout move + cross-repo citers + archive

- `claude/projects/{gh_214,gh_298,gh_305,gh_355,gh_375,gh_401_2,gh_t54,soa_75,synthetic-dev-align}/`
  → `docs/history/<initiative>/` (banner + README + shared index, per D9.1);
  `claude/` removed once empty (the non-`projects` reference content —
  `esm.md`, `tooling/pnpm.md`, `frontend/`, `testing/`,
  `skills/documentation-system/` — was already relocated or left as unscoped
  shared reference in Phase A/B, not carried into `docs/history/`).
- Cross-repo citers found by the survey's §9 sweep, repointed in the same
  commit as the corresponding move:
  - saga-dash: `docs/history/e2e-testing/{CLAUDE,README}.md`,
    `docs/history/README.md:32` (3+ citations of
    `claude/projects/ss-develop-session-adm-plan.md`) → repoint to
    `soa:docs/history/ss-develop-session-adm/README.md` (this one already
    moved in Phase B — this is the saga-dash-side follow-up, filed as a
    cross-repo edit in *that* repo's own docs-cleanup pass, not this repo's
    diff).
  - coach: `docs/history/module-viewer-port/README.md:23` (cites
    `claude/projects/gh_305/research/02-content-viewer-retirement.md`) →
    repoint to `soa:docs/history/gh_305/research/02-content-viewer-retirement.md`
    (same cross-repo caveat — filed in coach's own pass).
  - saga-dash's own confirmed gap: `gh_214/scheduling-topology-flow/02b-split-flow-design.md`
    is cited 3× from saga-dash's `playwright.stack.config.ts` and flagged in
    saga-dash's own `docs/history/docs-cleanup/followups.md:19` — soa-side
    fix is to note the gap in the moved `docs/history/gh_214/README.md`
    (the file was never written here either); this is a record-the-gap, not
    a reconstruction, matching D9.5's approach.
  - soa's own outbound broken citation: `docs/auth/adr/0005-openfga-model-as-source-of-truth.md:5`
    cites `saga-dash/docs/auth/concepts.md` §6/§7, which saga-dash's own
    survey confirmed doesn't exist there — fix by dropping the specific
    §6/§7 anchor and noting the target is gone, or repointing to whatever
    saga-dash's docs-cleanup pass lands the equivalent content at (check
    saga-dash's final state before this lands, since its own cleanup may
    still be in flight).
- Archive (D9.7): `gh_298`, `gh_401_2` (full research, both GH-API-verified
  CLOSED with no external citers) and `soa_75`'s 3-file `research/` only
  (`01-current-architecture.md`, `02-fleet-mutation-audit.md`,
  `03-event-driven-microservices-reference.md`) — pre-archive SHA recorded
  in each moved dir's banner/README/index row. **`gh_t54` is not archived**:
  no GH issue ties to it, so it doesn't meet the archive-only-CLOSED-initiatives
  gate — it moves to `docs/history/gh_t54/` whole (research + all 15
  `sources/` files) and stays live pending a resolved GH tie or nimbee PR
  7876 verification. Carve-out (never archive, fully live): `gh_214`,
  `gh_305`, `soa_75/decisions/` (all 12 files, kept atomic — only its
  `research/` is archived), `gh_355`, `gh_375`,
  `ss-develop-session-adm-plan.md`'s new home — all cited live cross-repo or
  in-repo, or still OPEN.

## Phase D — comments

Exactly the census's own recommendation list (`02-inline-comments.md` §9),
nothing added:

1. **3 unqualified `sds_80` cross-repo citations** —
   `packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts:4,6`
   and `packages/node/mesh-fixture-cli/src/commands/pgm/enroll.ts:4` — add
   the `student-data-system:` prefix (both targets confirmed live there by
   this survey's §0 archived-citation cross-check): `claude/projects/sds_80/phase-3/architecture-pattern-audit.md`
   and `claude/projects/sds_80/decisions/d3.6-phase-b-transform.md` both
   become `student-data-system:claude/projects/sds_80/...` — note SDS's own
   docs-cleanup may relocate these under `docs/history/sds_80/` before this
   lands; check SDS's final state first.
2. **2 within-repo/bare dangling citations** —
   `packages/node/rabbitmq/src/connection-manager.ts:70` and
   `packages/node/event-outbox/src/create-pool.ts:41` +
   `packages/node/event-envelope/src/preview-tag.ts:8` — replace with a
   one-line pointer to the "Missing decisions" section of
   `docs/history/soa_75/README.md` per D9.5 (not a real doc path, since
   neither `d-consumer-resilience.md` nor `d-preview-deploy-isolation.md`
   exists anywhere to point at, and this program doesn't file GitHub
   issues on the user's behalf — the gap also lands in `followups.md` for
   the user to act on if they want a tracking issue).
3. **`docs/promotion-pipeline.md` 3-citer cluster** —
   `tools/synthetic-dev/{capture-sandbox.sh:23,capture-local.sh:21,up.sh:417}` —
   repoint or drop per D9.6's resolution of the same dangling target (shared
   with Phase A's `code-doc-refs` finding — one fix, cited from both
   places).
4. **janus `@spec` tag drift** (D9.8) — 4 occurrences in
   `packages/node/api-util/src/utils/{saga-auth-url.ts:4,
   saga-auth-url.test.ts:5, dev-perimeter-config.test.ts:9,
   dev-perimeter-production.test.ts:9}` — update
   `janus:specs/contracts/saga-auth-signal.spec.md` →
   `janus:specs/contracts/drafts/saga-auth-signal.spec.md`, verified against
   janus's current tree before editing (never-touch caveat: confirm the file
   is really at `drafts/` in janus's live checkout, not just per this
   survey's note, since janus wasn't cross-repo-verified independently);
   add the missing "(janus repo)" qualifier to `saga-auth-url.ts:4`.
5. **`tools/synthetic-dev/up.sh`'s 164-line header** (the one Relocate
   candidate in the repo, §2/§9) — trim lines 3–67 (service topology,
   near-verbatim duplicate of `tools/synthetic-dev/README.md`'s opening) to
   a 3–5 line summary + pointer to `README.md`; leave lines 68–163
   (`--help`-shaped flag documentation) untouched, since it's read at the
   point of running the script.

**`.sh` coverage note**: the program's `comment-proof.sh` gate covers
`.ts/.js/.mjs?/.svelte/.yaml`, not `.sh` — items 3 and 5 above (3 of the 5
Phase D targets touch `.sh` files) fall back to manual before/after diff
review, plus `shellcheck` and a dry run of `./up.sh --status` for item 5
specifically (its edit is comment-only but behaviorally load-bearing to
verify, since the header is what a developer reads before running the
script).

**Nothing else in application source** — the census found 90% load-bearing
across a random 40-block sample, 0% historic narrative, 0% dead code; the
top-20 large-block list is 19/20 load-bearing (the 20th is item 5 above).
The vendored-pair headers (`refresh-suite.sh`, `browser-login.mjs`,
`tunnel.sh`, each duplicated verbatim between `tools/synthetic-dev/` and
`saga-stack-cli/vendor/`) are never-touch — the duplication is deliberate
and self-documented in the vendor copy's own text.

## Phase E — measure

Baseline (60 errors / 4 warnings / 12 info, recorded in
`validator-output.txt`), post-A, post-B, post-C, post-D, final. Rescore all
states with the program's final judge; persist runs + the held-out eval set;
outcome recorded in `README.md`.
