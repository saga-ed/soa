<!-- Survey by a subagent, 2026-09-08, for the docs-cleanup initiative (soa, seventh and last repo). Unedited. -->

# Documentation State Survey — `soa` (seventh repo, docs-cleanup program)

**Note on dates**: not a shallow clone — `git log --all` reaches 1,546 commits back to
**2025-06-13**, over a year of real history. No dating caveats needed here.

Branch: `claude/student-data-docs-cleanup-jlal1x`, 4 commits ahead of `origin/main` (all
citer-repoint commits from earlier legs of this program: saga-dash `e2e-testing`, coach
sub-domain, `gh_305` research, rostering `claude/projects`). soa is the platform every
other repo in this program names as "canonical source for shared patterns" — see §9 for
which soa docs those repos actually point at.

## 0. Validator baseline, by check — real break vs. false positive

`python3 docs-check.py --repo soa --all`: **60 errors, 4 warnings, 12 info** (76 total).
Layout inferred as legacy `claude/projects`. Far cleaner than any prior repo in this
program — no `claude-md-cap` violations at all (both of soa's largest leaves, §5, sit
comfortably under the 200-line cap).

| check | count | real breaks | false positives / non-issues |
|---|---|---|---|
| `links` | 45 | 41 (7 root-cause clusters, see below) | 4 (3 template placeholders + 1 prose blind spot) |
| `banner-cap` | 6 | 6 — all real (3 initiatives × 2 findings) | 0 |
| `banner-index` | 1 | 1 (`claude/projects/README.md` missing, 10 initiatives) | — |
| `misplaced-history-dir` | 4 | 4 — all real, but a structural finding not a defect (§7) | — |
| `code-doc-refs` | 4 | 3 (`docs/promotion-pipeline.md`, never written) | 1 (`docs/dev-toggle-ads-adm.md` — explicitly "saga-dash docs/...", validator strips the prefix) |
| `archived-citation` | 4 | 1 (`d-consumer-resilience.md`, genuinely missing) | 3 (1 template-placeholder parse artifact, 2 cross-repo hits missing a prefix but live in student-data-system) |
| `stale-doc` (info) | 12 | see §1/§6 — spot-checked against code, not trusted on git-age alone | — |

**`links` (45) — seven root-cause clusters, not 45 independent findings:**

1. **`claude/projects/gh_t54/research/testing-decisions.md` — 14 lines, one off-by-one.**
   Every relative link in the "Documentation Structure" tables (lines 13, 397-400,
   406-408, 414-419) is missing one `../` hop: the file sits at
   `claude/projects/gh_t54/research/`, three levels below repo root, but its links to
   `claude/testing/*.md` and `apps/{node,web}/claude/testing.md` only climb two levels.
   `./sources/testing/` (line 13) has the same bug in the other direction — it needs
   `../sources/testing/`, not `./sources/testing/`. Single mechanical fix.
2. **`claude/projects/synthetic-dev-align/source/pr-152-*.md` — 8 lines, unrewritten
   snapshot.** Three files are verbatim snapshots of saga-dash PR #152 (confirmed by each
   file's own `<!-- Snapshot of saga-dash PR #152 :: docs/seed-ids-*.md -->` header) whose
   intra-doc links were never rewritten for the `pr-152-` filename prefix applied on
   import — `[...](./seed-ids-onboarding.md)` should be
   `./pr-152-seed-ids-onboarding.md`. Confirmed against `pr-152-meta.md`, which lists the
   correct original filenames.
3. **`.claude/skills/claude-audit/SKILL.md:189`** → `../../docs/claude-audit.md` — same
   off-by-one shape, needs `../../../docs/claude-audit.md`; `docs/claude-audit.md` itself
   exists. Single instance.
4. **`docs/claude-hierarchy-summary.md:113`** → `../claude/gh_t54/plan.md` — the file
   moved to `claude/projects/gh_t54/research/plan.md` when `gh_t54` was reorganized under
   `claude/projects/`; the citer's link was never updated.
5. **`docs/github-packages-migration.md:189`, `docs/manual-package-management.md:267`**
   → `./npm-registry-publishing.md` (2 lines) — this file does not exist anywhere in the
   repo and has no git deletion record (`git log --all --diff-filter=D` finds nothing) —
   a promised "Publishing Guide" that was never written. Same doc also links
   `../.github/workflows/publish-packages.yml` (line 268), which was renamed to
   `publish-all-packages.yml` / `publish-codeartifact.yml` — 3 lines, one stale doc (§6).
6. **`human-notes/current-chat.md:102,185`** → `arc.png` (2 lines) — off-by-one, needs
   `../arc.png`; low value regardless, since the file is a raw pasted chat transcript
   (`// ... existing code ...` markers throughout), not real documentation (§4).
7. **`memory-bank/testing/README.md:67-69,84-86`** (6 lines) → `../development/`,
   `../planning/`, `../deployment/`, `../documentation/`, `../maintenance/` — sibling
   "phase" directories that were never created; `memory-bank/` holds only `testing/`, a
   fragment of what looks like a 6-phase prompt-library template (§4).

   Remaining one-offs: `infra/docs/hands-on-tutorial.md:26` anchor
   (`#45-alternative-docker-entrypoint-initdbd` — the real heading grew a
   "(simpler, no profiles)" suffix, anchor never updated); `infra/docs/troubleshooting.md:125`
   → `../CHANGELOG.md` (no CHANGELOG.md has ever existed in this repo — no deletion
   record); `packages/node/{event-consumer,rabbitmq}/README.md` ×3 →
   `d-consumer-resilience.md` (genuinely missing, §0 `archived-citation`, same file);
   `packages/node/saga-stack-cli/docs/snapshots.md:89` anchor into `tunnel.md` — no
   heading in `tunnel.md` matches "seed launchable connect sessions" today.

**False positives (4):** `claude/skills/documentation-system/templates/claude-md-tier-{core,node,web}.md:11`
all link `../../CLAUDE.md` — these are the plugin's own tier templates (vendored into
this repo pre-marketplace, §4), illustrating a generic relative path meant to be copied
into a real tier location, not a live navigable link. `.claude/skills/claude-audit/audit-engine.md:348`
— `"See [file](path)"` is prose describing the check's own link-detection pattern, not
inside a code span (no backticks) and not inside the fence that closed two lines above —
the exact blind spot the checker's own docstring names as its one documented exception.

**`code-doc-refs` (4) — 3 real, 1 cross-repo false positive:**
`tools/synthetic-dev/{capture-local,capture-sandbox}.sh` and `up.sh:417` all comment
"see `docs/promotion-pipeline.md`'s non-goals" — no repo prefix, and no such doc exists
under any name (`grep -rl "promotion.pipeline" docs/ claude/` finds nothing) — a doc that
was referenced from soa's own tooling but never written. `up.sh:1692` comments
"`saga-dash docs/dev-toggle-ads-adm.md`" — explicitly cross-repo, confirmed live at
`saga-dash/docs/dev-toggle-ads-adm.md`; the validator's `code-doc-refs` check doesn't
parse the repo-name prefix out of free-text comments, same blind spot found in every
prior repo's survey.

**`archived-citation` (4) — 1 real, 3 false positive:**
- **Real**: `claude/projects/soa_75/decisions/d-consumer-resilience.md`, cited from
  `packages/node/event-consumer/README.md:48,116`, `packages/node/rabbitmq/README.md:35`,
  and `packages/node/rabbitmq/src/connection-manager.ts:70` — all describing specific,
  numbered patterns ("pattern 3", "pattern 5") for poison-message handling and non-fatal
  broker startup. `soa_75/decisions/` holds 12 other decision files but none by this
  name; no git deletion record; the content itself (consumer-resilience pattern
  catalog) is not findable anywhere else in the repo. Genuinely lost — top 10 (§8).
- **False positives**: `claude/projects/gh_` (from `docs/claude-for-pms/03-skills-and-plugins.md:216`,
  which reads `` `claude/projects/gh_<issue>` `` — a template placeholder describing the
  `/project` skill's naming convention, truncated by the checker's regex at the `<`);
  `claude/projects/sds_80/decisions/d3.6-phase-b-transform.md` and `sds_80/phase-3/`
  (from `packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts:4,6`) — both
  confirmed live today in student-data-system's `claude/projects/sds_80/` (not yet moved
  to `docs/history/` there), just missing a `student-data-system:` prefix.

**`stale-doc` (info, 12)** — see §1 and §6 for per-file verdicts; git-age alone
overstates staleness for some (`docs/claude-hierarchy-summary.md`, still an accurate
record of a completed migration) and understates it for others not flagged at all
(`docs/GETTING-STARTED.md` and root `README.md`, both younger than their content's drift
from the actual package layout, §6).

## 1. Inventory by surface

| Surface | Count / size |
|---|---|
| Root `CLAUDE.md` | 50 lines — small, no version-pin table, one self-aware gotcha (Node `engines >=24` vs. CI's pinned `22`, confirmed accurate both ways, §3) |
| Nested `CLAUDE.md` (24 tier + leaf files) | Largest: `fixture-serve` 173L, `db` 161L, `soa_75` 134L (initiative, not tier), `synthetic-dev-align` 136L (initiative). All tier/leaf files ≤93L. Full list in §3/§5. |
| **Undocumented packages** | 8 of 26 `packages/node/*` dirs missing from the parent tier table (`contract-check`, `health`, `inspect`, `mailer`, `mesh-fixture-cli`, `postgres`, `preview-headers`, **`saga-stack-cli`** — the last has 18 files under its own `docs/`, the largest single-package doc surface in the repo, and powers 4 of the repo's 10 active initiatives, yet has no `CLAUDE.md` and isn't in the tier index at all, §8) |
| `.claude/rules/` | **None** — no `paths:`-scoped rules exist anywhere in this repo (§7) |
| `claude/` (non-`projects` reference content) | `esm.md` (173L), `tooling/pnpm.md` (26L), `frontend/` (4 files, README+shared×2+sveltekit+nextjs getting-started), `testing/` (4 files, 305L: README 40, philosophy 46, conventions 143, builders 76), `skills/documentation-system/` (vendored plugin templates, pre-marketplace, §4) — 23,116 total lines across all of `claude/` including `projects/` |
| `claude/projects/` | **10 initiative dirs + 1 loose file** (`ss-develop-session-adm-plan.md`, not inside any dir), 112 md files, 117 files total. Only 3 of 10 dirs have a `CLAUDE.md` banner (`gh_214` 61L, `soa_75` 134L, `synthetic-dev-align` 136L — all over the 15-line cap, all missing a `Status:` line, §2) |
| Nested `claude/` trees outside repo root (`misplaced-history-dir`) | `apps/node/claude/testing.md` (163L), `apps/web/claude/testing.md` (82L), `packages/node/claude/{testing,event-driven}.md` (87+153L), `python/claude/uv.md` (334L) — 4 dirs, 819L total, **all current-tier reference content**, none of it history (§7) |
| `docs/` | 28 md files, 5,825 lines. `claude-for-pms/` (9 files, most recently touched 2026-08-26 — the freshest content in the repo); package-publishing cluster (5 files: `CODEARTIFACT_SETUP.md`, `cicd-package-publishing.md`, `package-registry-quickstart.md`, `github-packages-migration.md`, `manual-package-management.md` — heavy overlap, §6/§8); onboarding cluster (5 files: root `README.md` Quickstart, `GETTING-STARTED.md`, `quickstart.md`, `overview.md`, `saga-soa-tlrd.md` — 3 of 5 describe a pre-restructuring package layout, §6); `auth/adr/0005-*.md` (cites saga-dash, broken both sides, §9); `superpowers/` (2 files, one dated design pair — history-shaped but tiny, unlike other repos' `superpowers/` trees) |
| `specs/` | Does not exist in this repo |
| `infra/` | `infra/CLAUDE.md` (93L) + `infra/docs/` (hands-on-tutorial.md, troubleshooting.md — both have real findings, §0/§6) |
| Root clutter | 8 loose files + 2 dirs — `SCOPE_FIX_SUMMARY.md`, `SETUP_SUMMARY.md`, `WORKFLOW_SUCCESS_SUMMARY.md`, `soa-audit.md`, `soa-remediation-plan.md`, `HowToAddPubsub.md`, `LOCAL_DEVELOPMENT.md`, `README.md`, `human-notes/`, `memory-bank/`, `arc.png` — see §4 |
| `.claude/skills/` (repo-local, not vendored) | `claude-audit/` (3 files — backs `soa-audit.md`/`soa-remediation-plan.md`), `qa-cross-validation/` |

## 2. `claude/` classification per initiative

10 dirs, all under `claude/projects/`, plus the loose `ss-develop-session-adm-plan.md`.
GH status via `gh issue view <n> --repo saga-ed/soa --json state,closedAt,title` (or the
relevant PR for the two initiatives not tied to a soa issue number).

| Dir | Files | GH tie & status (verified via API) | Real last-touch | Verdict |
|---|---|---|---|---|
| `gh_214` | 31 | I#214 "OCLIF CLI for synthetic-dev", **OPEN** | 2026-07-07 | **ACTIVE** — largest initiative dir; cited live from saga-dash (`02-flow-design.md`) but also has a soa-side gap saga-dash already flagged (`02b-split-flow-design.md` doesn't exist here, §9) |
| `gh_298` | 3 | I#298 "ss Tunnel Mode", **CLOSED** 2026-07-16 | 2026-07-13 | **CLOSED, harvest-then-close** — no CLAUDE.md ever existed |
| `gh_305` | 18 | I#305 "ss develop: concierge topic…", **CLOSED** 2026-07-16 | 2026-09-08 (touched today by this program's own citer-repoint commits) | **CLOSED, harvest-then-close** — cited live from coach's `docs/history/module-viewer-port/README.md` |
| `gh_355` | 1 | soa#355 / PR soa#356, **OPEN** | 2026-07-23 | **OPEN, single-doc, no home** — manual test plan only, cites a personal path (`~/dev/shared-env-reset-research.md`) as its companion doc, unresolvable for anyone else |
| `gh_375` | 5 | I#375 "ss env production support", **OPEN** | 2026-07-28 | **ACTIVE** — plan + 2 research docs, no CLAUDE.md |
| `gh_401_2` | 2 | I#401, **CLOSED** 2026-08-04 (issue covers #401 & #402, both closed) | 2026-08-04 | **CLOSED, harvest-then-close** — explicitly self-documents its own provenance ("Transferred verbatim from `saga-ed/rostering`... Only this provenance note was added") |
| `gh_t54` | 22 | **No matching GH issue** — "t54" predates the `gh_<issue>` numbering convention; references "nimbee PR 7876" and a cross-repo (soa/thrive/coach) CLAUDE.md-hierarchy design effort | 2026-02-01 | **Pre-convention legacy** — oldest untouched initiative in the tree (7 months stale); its own internal links are broken (§0, cluster 1) |
| `multi` | 2 | Not GH-tied at all | 2026-02-01 | **Not an initiative** — a generic "Claude Code multi-agent workflows" reference guide self-dated "Based on Claude Code v2.1+" as of January 2026; not soa-specific content, likely stale relative to the actual product by now, misfiled under `claude/projects/` |
| `soa_75` | 16 | I#75 "POC: Event-Driven Projections…", **CLOSED** 2026-05-26 | 2026-06-25 (touched a month after issue close — finishing the writeup) | **CLOSED, harvest-then-close** — but content is load-bearing current reference: `d-consumer-resilience.md` is missing (§0), `d-soa-pubsub-divorce.md` is cited from `packages/node/CLAUDE.md` and `packages/node/claude/event-driven.md` (both via a broken `.claude/projects/` path, §6) |
| `synthetic-dev-align` | 16 | Not GH-tied — driven by **merged** saga-dash PR #152 (merged 2026-06-05); decisions use RESOLVED/PENDING vocab correctly | 2026-06-25 | **Research/synthesis, still open** — `decisions/d1.1-base-journey-split.md` RESOLVED 2026-06-04; `d2.1-user-count-superset.md` still PENDING |
| `ss-develop-session-adm-plan.md` (loose file, not a dir) | 1 | Not GH-tied | 2026-09-08 (touched today, by this program's own saga-dash citer-repoint) | **Live, cited cross-repo** — 3+ citations from saga-dash's `e2e-testing/CLAUDE.md`, `README.md`, and `docs-cleanup/followups.md`; cannot be archived or moved without repointing saga-dash first, matching the `gh_880`/qboard-d5.1 precedent this program keeps re-finding |

**Decision-status vocabulary**: unlike several prior repos, soa's decision docs are
already consistent — `soa_75/decisions/*.md` and `synthetic-dev-align/decisions/*.md`
both use `RESOLVED <date>` / `PENDING`, either as a `**Status:**` line or as the file's
opening sentence. The validator's `decision-status` check found **zero** errors here.

**Verdicts, grouped**: **move-to-history** (cleanly closed, no external citers found):
`gh_298`, `gh_401_2`. **keep-cited** (carve out before any bulk move): `gh_214`
(saga-dash cites it, and has its own gap into saga-dash to fix), `gh_305` (coach cites
it), `soa_75` (its `d-soa-pubsub-divorce.md` is cited from current-tier
`packages/node/CLAUDE.md` itself — an in-repo dependency, not just cross-repo),
`ss-develop-session-adm-plan.md` (saga-dash cites it 3×). **reclassify, not archive**:
`multi` (generic Claude Code reference material, not an initiative — candidate to delete
or move to a personal-notes location, not `docs/history/`). **delete-candidate**: none
confidently — even `gh_t54` (7 months stale, pre-convention) documents a real
cross-repo CLAUDE.md-hierarchy design that may still be referenced by nimbee PR 7876
(not independently verified, out of budget).

## 3. Root `CLAUDE.md` — line-by-line fact-check

50/200 lines — the smallest, and cleanest, root file this program has reviewed. Every
"Detailed Documentation" pointer resolves (verified by existence check against all 8
listed paths). **No authority-by-location paragraph and no decisions-surface pointer**
— the same structural gap every repo in this program has had pre-cleanup — but nothing
else here is factually wrong.

| Line(s) | Claim | Check | Verdict |
|---|---|---|---|
| 7-10 | Registers the `saga-tools` marketplace via `.claude/settings.json`; `/documentation-system` owns doc-routing | `.claude/settings.json` present; matches the vendored-vs-marketplace split found in §4 (an OLDER, pre-marketplace local copy of the same plugin still sits at `claude/skills/documentation-system/`) | **Accurate**, but see §4 for the stale leftover this creates |
| 28 | `pnpm check-types` (not `pnpm typecheck`) | `package.json:17` — `"check-types": "turbo run check-types"` | **Accurate** |
| 31-32 | "Node version disagrees across sources: `engines` says `>=24`, CI pins `NODE_VERSION: 22`. Trust `engines` locally." | `package.json` `engines.node: ">=24"`; `.github/workflows/{infra-compose-ci,publish-codeartifact,publish-all-packages}.yml` all set `NODE_VERSION: "22"` (16 occurrences) | **Accurate, and self-aware** — the one piece of correctly-flagged staleness in this repo; contrast with `packages/node/CLAUDE.md:10`, which states "Target: Node.js 20+" with no such caveat (§6) |
| 37-44 | 8 "Detailed Documentation" pointers: `claude/`, `claude/esm.md`, `claude/frontend/`, `claude/tooling/pnpm.md`, `apps/CLAUDE.md`, `apps/node/claude/testing.md`, `packages/CLAUDE.md`, `docs/cross-repo-linking-summary.md`, `tools/walkthrough-video/CLAUDE.md` | All 9 paths checked with `test -e` | **All exist** |
| 50 | "Always ask for confirmation before file write/delete commands, except pnpm and turbo commands." | Standalone safety rule, not independently testable | **Not evaluated** (behavioral, not a factual claim) |

## 4. Root clutter — 8 files + 2 dirs

| Item | What it is | Git age | Cited? | Verdict |
|---|---|---|---|---|
| `SCOPE_FIX_SUMMARY.md` (97L) | One-off "package scope fix" report | 2026-03-27 | No | **Dead** — and internally garbled: "Updated all package references from `@saga-ed` to `@saga-ed` scope" (both sides identical, a botched find/replace left in the file itself) |
| `SETUP_SUMMARY.md` (110L) | CI/CD setup completion report | 2025-12-18 (merge from `hipponot/saga-soa`) | No | **Dead** — point-in-time "what was configured" snapshot |
| `WORKFLOW_SUCCESS_SUMMARY.md` (129L) | CI/CD "success" announcement | 2025-12-18 (same merge) | No | **Dead** — same shape as above |
| `soa-audit.md` (770L) | Repo health audit, generated 2026-01-31 by the `claude-audit` skill (health 2.8/5.0, 23 packages evaluated) | 2026-03-27 | No | **Point-in-time, likely stale** — repo now has 26 `packages/node/*` dirs alone (§1), more than the 23 total the audit evaluated across all tiers; not re-run since |
| `soa-remediation-plan.md` (272L) | Remediation plan following the audit | 2026-03-27 (updated) | No | **Stale, partially contradicted by current code** — see §6 |
| `HowToAddPubsub.md` (1,138L!) | Guide for adding pubsub sectors to tRPC APIs | 2026-03-27 | Not linked from any CLAUDE.md or docs/ index | **Large, possibly still-relevant reference, badly placed** — `packages/node/{pubsub-core,pubsub-client,pubsub-server}` all still exist and are documented in `packages/node/CLAUDE.md`, but this 1,138-line guide sits at repo root, undiscoverable and unlinked, duplicating ground the tier CLAUDE.md and `claude/testing/` already cover more concisely |
| `LOCAL_DEVELOPMENT.md` (199L) | CI/CD local-check commands | 2025-12-18 (merge) | No | **Mostly accurate** (`ci:check`, `quick:check` scripts both real in `package.json`) but duplicates `docs/GETTING-STARTED.md` and `docs/quickstart.md` — 3 "how to build/test locally" docs, none cross-linked |
| `README.md` (68L) | Repo README | 2025-12-19 | Entry point (GitHub default view) | **Stale in 3 places** — "apps (web, docs)" implies `apps/docs` as a top-level sibling of `apps/web`, but the actual doc app is nested at `apps/web/docs/` (confirmed: `apps/web/docs/CLAUDE.md` — "SOA documentation site built with Next.js 15"); "apps/examples/rest-api" doesn't exist (`apps/examples/` holds only `web-client`); "Project Board: `github.com/orgs/hipponot/projects/22`" still names the pre-rename `hipponot` org while root `CLAUDE.md` and `gh issue view --repo saga-ed/soa` both confirm the canonical org is now `saga-ed` |
| `human-notes/` (4 files) | Raw personal dev notes (`current-chat.md` is a pasted chat transcript with markdown-fence artifacts) | 2025-12-18 | `current-chat.md` self-cites `arc.png` (broken, §0) | **Dead/personal** — not documentation |
| `memory-bank/` (1 subdir: `testing/`) | Fragment of an apparent 6-phase prompt-library template (only `testing/` exists; `development/`, `planning/`, `deployment/`, `documentation/`, `maintenance/` referenced but never created) | 2025-12-23 | No | **Dead, incomplete scaffold** — never finished, never removed |
| `arc.png` (241KB) | Architecture diagram, referenced correctly from `README.md` | 2025-06-17 | Yes, `README.md` (works) + `human-notes/current-chat.md` (broken, off-by-one) | **Live but unverifiable content** (image, not re-derived against current architecture this pass) |

## 5. Largest leaves — under cap, mostly accurate

`packages/node/fixture-serve/CLAUDE.md` (173L) and `packages/node/db/CLAUDE.md` (161L)
are the two largest leaf files in the repo — both **comfortably under the 200-line cap**
(unlike every prior repo in this program, soa has zero `claude-md-cap` violations).
Spot-checked claims:

- `fixture-serve/CLAUDE.md` — endpoint table, DI wiring, provision state machine
  (`resetting → creating → switching → verifying → ready/failed`), Playwright export
  shape: matches `src/server/fixture-server.ts`, `src/controller/abstract-fixture-controller.ts`
  structure listed in the file's own "Structure" section (file existence confirmed, logic
  not independently re-derived — out of budget). "Last updated: 2026-04" — plausible
  given the file's own content describes no contradicted behavior.
- `db/CLAUDE.md` — SSM/Secrets Manager primitive tables, Saga naming conventions
  (`{project}_db` / `{project}_app` / `saga-rs` replica set) are internally consistent
  and cross-checked against no contradicting evidence. "Last updated: 2026-05-01".

`packages/node/CLAUDE.md` (93L, the parent tier file, not one of the two largest leaves
but load-bearing for both) has two real problems:

1. **Stale version claim**: "Target: Node.js 20+ (ESM)" (line 10) contradicts both root
   `CLAUDE.md:31` and `package.json` `engines.node: ">=24"` (§3) — no caveat here, unlike
   root's self-aware framing.
2. **8 of 26 `packages/node/*` packages are missing from its own index table** (§1,
   §8) — most notably `saga-stack-cli`, which has 18 files under its own `docs/` and
   powers 4 of the repo's 10 active initiatives.
3. Line 43 cites `~/dev/soa/.claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md`
   — a personal absolute path AND a typo (`.claude/projects/` with a stray leading dot;
   the real path is `claude/projects/`, no dot). The same exact typo repeats twice more
   in `packages/node/claude/event-driven.md` (lines 3 and 153) — 3 occurrences, one root
   cause, invisible to the validator's `links` check because these are backtick code
   spans in prose, not markdown `[text](path)` links (§6/§8).

## 6. Staleness table (doc vs. code, file:line both sides)

| Claim | Doc | Code / reality | Verdict |
|---|---|---|---|
| "Target: Node.js 20+ (ESM)" | `packages/node/CLAUDE.md:10,49` | `package.json` `engines.node: ">=24"`; root `CLAUDE.md:31-32` explicitly documents the >=24 vs. CI-22 split | **Stale**, no caveat (contrast root, §3) |
| `.claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md` (stray dot + personal path) | `packages/node/CLAUDE.md:43`, `packages/node/claude/event-driven.md:3,153` | Real path: `claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md` (file exists, confirmed) | **Broken prose citation**, 3 occurrences / 1 root cause, not caught by the validator |
| "trpc-api / trpc-codegen [removed]"; "web-client - Migrating to SvelteKit immediately" | `soa-remediation-plan.md:4,14-16,258-263` (dated 2026-03-27) | `apps/node/trpc-api/` still fully present (own 90L CLAUDE.md, `package.json`, `docs/`, `examples/`); `apps/web/web-client/CLAUDE.md` states "**Framework**: Next.js 15 (App Router)" — not SvelteKit; only `bin/trpc-codegen` is actually gone (a **broken symlink** to `../packages/trpc-codegen/bin/trpc-codegen`, confirming that one specific removal happened) | **Partially executed, doc never reconciled** — 5+ months later the plan still describes an end-state that didn't happen for 2 of its 3 claims |
| "apps (web, docs)"; "apps/examples/rest-api" | `README.md:20,32`; `docs/GETTING-STARTED.md` (`turbo run build --filter=apps/examples/rest_api`, `--filter=packages/logger`) | `apps/docs` doesn't exist (real path: `apps/web/docs/`); `apps/examples/` holds only `web-client`; `packages/logger` doesn't exist (real path: `packages/node/logger`) | **Stale** — both docs predate the `packages/{core,node,web}` and `apps/examples` restructuring; older `docs/GETTING-STARTED.md` (2025-07-29) not touched since, newer `README.md` (2025-12-19) inherited the same wrong paths without a refresh |
| "Node.js: v20+ (recommended: v22.x)" | `docs/quickstart.md:7` (2026-03-27, the newest of the three onboarding docs) | `package.json` `engines.node: ">=24"` | **Stale** — even the newest onboarding doc undershoots the actual requirement |
| `docs/npm-registry-publishing.md` (promised) | `docs/github-packages-migration.md:189`, `docs/manual-package-management.md:267` | File never existed (no git deletion record) | **Never written** — 2 docs promise a 3rd that doesn't exist |
| `../.github/workflows/publish-packages.yml` | `docs/manual-package-management.md:268` | Workflow renamed to `publish-all-packages.yml` / `publish-codeartifact.yml` | **Stale**, rename not propagated |
| `../CHANGELOG.md` | `infra/docs/troubleshooting.md:125` | No `CHANGELOG.md` anywhere in the repo, ever (no deletion record) | **Never written** |
| `saga-dash/docs/auth/concepts.md` §6/§7 (GitHub blob URL) | `docs/auth/adr/0005-openfga-model-as-source-of-truth.md:5` | Confirmed from saga-dash's own docs-cleanup survey: no `docs/auth/` directory exists there at all | **Broken outbound cross-repo citation**, confirmed both sides (§9) |
| `janus:specs/contracts/saga-auth-signal.spec.md` (`@spec` tags) | `packages/node/api-util/src/utils/{saga-auth-url.ts:4, saga-auth-url.test.ts:5, dev-perimeter-config.test.ts:9, dev-perimeter-production.test.ts:9}` | Live file in janus is `specs/contracts/drafts/saga-auth-signal.spec.md` — moved into a `drafts/` subfolder | **Stale cross-repo `@spec` tag**, 4 occurrences (§9) |
| `~/dev/sds-fixture/claude/projects/sds_80/phase-2/soa-infra-alignment.md` | `infra/compose/projects/saga-mesh/README.md:42` | No `sds-fixture` repo exists locally under `~/dev/`; student-data-system's own `sds_80/phase-2/` holds no file by that name | **Unresolvable** — wrong repo name (or an old name for a repo later merged/renamed) plus a personal-path prefix |

## 7. Rules candidates — soa has zero `.claude/rules/`

Every other repo this program has touched already has (or is adopting, per its own
decision doc) a `.claude/rules/` directory. soa has none — every piece of path-scoped
guidance currently lives either in a tier CLAUDE.md (always-loaded for that subtree) or
in a nested `claude/*.md` reference file that requires a manual "See Also" click.
Strongest candidates, by evidence of actual multi-file recurrence:

1. **Testing, by tier** — `claude/testing/{README,philosophy,conventions,builders}.md`
   (305L, shared/cross-cutting) + `apps/node/claude/testing.md` (163L) +
   `apps/web/claude/testing.md` (82L) + `packages/node/claude/testing.md` (87L). Six of
   25 CLAUDE.md files already point at these by path (root, `db`, `apps/node`, and 3 of
   the `apps/node/*` API examples). Natural split: `.claude/rules/testing-node.md`
   (`paths: apps/node/**, packages/node/**`) and `.claude/rules/testing-web.md`
   (`paths: apps/web/**`), with the shared conventions either unscoped or folded in.
2. **Event-driven adopter conventions** — `packages/node/claude/event-driven.md` (153L)
   is the canonical doc for 6 packages (`event-envelope`, `event-outbox`, `event-consumer`,
   `observability`, `event-test-harness`, `event-integration-tests`), all pointing at it
   from the same `packages/node/CLAUDE.md` table row shape. Candidate:
   `.claude/rules/event-driven.md` (`paths: packages/node/event-*/**, packages/node/observability/**`).
3. **Python/uv package management** — `python/claude/uv.md` (334L, the single largest
   `claude/*` reference file outside `claude/projects/`) is entirely scoped to `python/**`
   and currently loaded only by manual navigation from `python/CLAUDE.md`. Candidate:
   `.claude/rules/python-uv.md` (`paths: python/**`).
4. **Frontend framework patterns** — `claude/frontend/{shared,sveltekit,nextjs}/` (4
   files) scoped to `apps/web/**`; currently reached only via root `CLAUDE.md:38`.
5. **The 4 `misplaced-history-dir` trees are exactly this candidate list already
   half-formed** — `apps/node/claude/`, `apps/web/claude/`, `packages/node/claude/`,
   `python/claude/` (§0/§1) are all current-tier reference content sitting under a `claude/`
   dirname that the validator's layout convention reserves for historical
   initiative-tracking. Converting them to `.claude/rules/*.md` with `paths:` frontmatter
   would resolve the `misplaced-history-dir` findings and the "6 files must remember to
   link this by hand" problem in one move.
6. **Decision-docs** — not path-scoped, but worth noting: soa has no
   `.claude/rules/decision-docs.md` and no `docs/decisions/`; unlike several sibling
   repos mid-program, this isn't hurting soa today (§2 — vocabulary is already
   consistent), but the convention doesn't exist to keep it that way going forward.

## 8. Top 10 findings (ranked by fact-discovery impact)

1. **`packages/node/saga-stack-cli`** — 18 files under its own `docs/`, the single
   largest package-level documentation surface in the repo, powering 4 of the repo's 10
   active initiatives (`gh_214`, `gh_298`, `gh_355`, `gh_375` are all about the `ss` CLI
   this package ships) — has no `CLAUDE.md` and is entirely absent from
   `packages/node/CLAUDE.md`'s own package index (§1/§5). The most load-bearing
   undocumented-at-the-tier-level package found in this survey.
2. **`claude/projects/soa_75/decisions/d-consumer-resilience.md`** is cited 4 times from
   live production code (`event-consumer/README.md` ×2, `rabbitmq/README.md`,
   `connection-manager.ts`) describing specific numbered resilience patterns — the file
   does not exist anywhere in the repo, has no git deletion record, and its content isn't
   findable under any other name (§0/§6).
3. **A single stray-dot typo — `.claude/projects/` instead of `claude/projects/`** —
   appears 3 times across `packages/node/CLAUDE.md:43` and
   `packages/node/claude/event-driven.md:3,153`, always pointing at the same real file
   (`d-soa-pubsub-divorce.md`). Invisible to the validator's `links` check (backtick
   prose, not markdown links) — a mechanical, one-edit fix once found (§5/§6).
4. **`soa-remediation-plan.md`'s predicted end-state never fully happened**: dated
   2026-03-27, it says web-client was "Migrating to SvelteKit immediately" — 5+ months
   later `apps/web/web-client/CLAUDE.md` still states Next.js 15. Only `trpc-codegen`'s
   removal actually happened (confirmed via a dead `bin/trpc-codegen` symlink); `trpc-api`
   itself, also marked for removal, is still fully present with its own 90-line CLAUDE.md
   (§6).
5. **Two confirmed-both-sides broken cross-repo citations into saga-dash**:
   `gh_214/scheduling-topology-flow/02b-split-flow-design.md` (cited 3× from saga-dash's
   own `playwright.stack.config.ts`, and flagged in saga-dash's own docs-cleanup
   followups) and `docs/auth/adr/0005-*.md`'s citation of `saga-dash/docs/auth/concepts.md`
   §6/§7 (saga-dash's own survey already confirmed no `docs/auth/` exists there). Both
   need fixing on soa's side; neither can be fixed by editing saga-dash (§9).
6. **A stale cross-repo `@spec` tag into janus**, cited 4× from
   `packages/node/api-util/src/utils/{saga-auth-url,dev-perimeter-config,dev-perimeter-production}.ts`
   — janus moved the target file into `specs/contracts/drafts/` and soa's `@spec`
   annotations were never updated. Functionally significant if any spec-linkage tooling
   enforces these tags (§6/§9).
7. **8 of 26 `packages/node/*` packages are undocumented at the tier-index level**
   (`contract-check`, `health`, `inspect`, `mailer`, `mesh-fixture-cli`, `postgres`,
   `preview-headers`, plus `saga-stack-cli` at #1) — `packages/node/CLAUDE.md`'s table
   lists 18 of 26 (§1/§5).
8. **4 `misplaced-history-dir` trees are current reference content misfiled under a
   history-reserved dirname** — `apps/node/claude/`, `apps/web/claude/`,
   `packages/node/claude/`, `python/claude/` (819 lines total) — none of it is history;
   all four are ready-made `.claude/rules/*.md` candidates (§7).
9. **A 3-doc package-publishing cluster with 2 internally dangling links**:
   `docs/github-packages-migration.md` and `docs/manual-package-management.md` both
   promise a `docs/npm-registry-publishing.md` that was never written, and the latter
   also links a renamed CI workflow file; a 3rd doc, `infra/docs/troubleshooting.md`,
   separately links a `CHANGELOG.md` that has never existed (§0/§6).
10. **Two overlapping doc clusters with no cross-linking**: 5 onboarding-shaped docs
    (root `README.md` Quickstart, `docs/GETTING-STARTED.md`, `docs/quickstart.md`,
    `docs/overview.md`, `docs/saga-soa-tlrd.md`) and 5 package-publishing docs (§9 above,
    minus troubleshooting.md) — 3 of the 5 onboarding docs describe a pre-restructuring
    package layout (`packages/logger`, `apps/examples/rest-api`, `apps/docs`) that no
    longer exists (§6), and none of the 5 publishing docs points at the others as
    "start here" (§4).

## 9. Cross-repo angle

soa is the platform every sibling repo's CLAUDE.md names as "canonical source for shared
patterns" (student-data-system's root `CLAUDE.md` says this verbatim; rostering,
saga-dash, program-hub, coach, qboard all link `pnpm soa:link:on/off/status` and depend
on `@saga-ed/soa-*` packages). Grepped all six sibling docs-cleanup worktrees for `soa:`
and for bare `claude/projects/<soa-initiative>` mentions.

**What sibling repos cite in soa, and whether it's live:**

| soa path cited | Cited from | Live? |
|---|---|---|
| `packages/node/mesh-fixture-cli/fixtures/iam-small` (current-tier, not history) | rostering `docs/history/iam-small-fixture-r123/{README,CLAUDE,03-implementation-plan}.md` — explicitly "Harvested to: `soa:...`" | **Yes** — current-tier code/fixture, correctly qualified |
| `claude/projects/gh_214/scheduling-topology-flow/02-flow-design.md` | saga-dash `apps/web/dash/playwright.stack.config.ts:327` | **Yes** |
| `claude/projects/gh_214/scheduling-topology-flow/02b-split-flow-design.md` | saga-dash `playwright.stack.config.ts:360,376` + saga-dash's own `docs/history/docs-cleanup/followups.md:19` | **No — broken**, soa-side gap (§8) |
| `packages/node/saga-stack-cli/docs/tunnel.md` (current-tier) | saga-dash `apps/web/dash/e2e/support/config-mode.ts:81` | **Yes** |
| `claude/projects/ss-develop-session-adm-plan.md` (loose file) | saga-dash `docs/history/e2e-testing/{CLAUDE,README}.md`, `docs/history/README.md:32` | **Yes** — cannot archive/rename without repointing saga-dash first (§2) |
| `claude/projects/gh_305/research/02-content-viewer-retirement.md` | coach `docs/history/module-viewer-port/README.md:23` | **Yes** |
| `infra/src/ec2/engines.js` (current code) | program-hub `docs/pr-previews.md:45` | Not verified this pass (out of budget) |

**What soa cites into sibling repos:**

| Citer (soa) | Target | Repo-prefixed correctly? |
|---|---|---|
| `docs/auth/adr/0005-openfga-model-as-source-of-truth.md:5` (GitHub blob URL) | `saga-dash/docs/auth/concepts.md` §6/§7 | Yes, explicit URL — but **target doesn't exist** (§6/§8), confirmed from saga-dash's own survey |
| `packages/node/api-util/src/utils/{saga-auth-url.ts, saga-auth-url.test.ts, dev-perimeter-config.test.ts, dev-perimeter-production.test.ts}` (`@spec` tags) | `janus:specs/contracts/saga-auth-signal.spec.md` | Partially (3 of 4 say "(janus repo)") — but **path is stale**, real file moved to `specs/contracts/drafts/` (§6/§8) |
| `infra/compose/projects/saga-mesh.yml:45`, `saga-mesh/README.md:42` | `student-data-system`'s `claude/projects/sds_80/phase-2/` | Mixed — `.yml` correctly names "student-data-system" one line above; `README.md:42` instead says `~/dev/sds-fixture/claude/projects/sds_80/phase-2/soa-infra-alignment.md`, a **personal path naming a repo that doesn't exist locally**, and the specific filename isn't in SDS's actual `sds_80/phase-2/` either (§6) |
| `packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts:4,6` | `student-data-system`'s `claude/projects/sds_80/{phase-3/architecture-pattern-audit.md, decisions/d3.6-phase-b-transform.md}` | **No** — no repo prefix at all; both targets confirmed live in student-data-system today (§0, `archived-citation` false positive) |

**Noise, not real citations**: the validator's `claude/projects/gh_` row (§0) is a
template placeholder in prose, not a citation to any real path.
