<!-- Survey by a subagent, 2026-09-08, for the docs-cleanup initiative (soa). Unedited. -->

# Comment Archaeology — soa

**Scope:** 888 source files scanned — `apps/{node,web,core,examples,projects}`
(4 Node APIs under `apps/node/*`, the `apps/web/web-client` SPA, `apps/examples/web-client`,
`apps/core` [doc-only, 0 source], `apps/projects/saga_agents` [doc-only, 0 source]),
`packages/{node,web,core}/*` (24 Node packages incl. the `saga-stack-cli` monolith, 2 web
packages, 9 core packages), `infra/*` (compose generator + EC2 router/handlers + Makefile-driven
compose stack), `scripts/*` (7 root scripts), `tools/{synthetic-dev,virtual-devices,
walkthrough-video}`, `build-tools/*` (doc-only, 0 source), `python/*` (doc-only, 0 `.py` file
anywhere in scope), `bin/*` (3 broken symlinks into packages that don't exist at those paths —
0 real files). Excludes `node_modules`, `dist`, `build`, `.turbo`, `.svelte-kit`, `coverage`,
`claude/` (read as citation *targets* in §4, not scanned for their own comments). `//`/`/* */`
in `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, `#` in `.yaml`/`.yml`/`.sh`, `#`/docstrings in `.py`
(defined but unused — see below), `<!-- -->`+`//`/`/* */` in `.svelte` (defined but unused).
Script: `/home/spaul/.claude/jobs/d5562f6a/tmp/scan_soa.py` (+ `analyze1.py`/`analyze2.py`),
method mirrors saga-dash's `docs/history/docs-cleanup/research/02-inline-comments.md`.

**Two scope facts that shape everything below, unlike every sibling census so far:**
zero `.py` files and zero `.svelte` files exist anywhere under the 8 scanned roots — soa is a
TS/JS (838 files) + shell (35) + YAML (15) repo, full stop. `python/` and `build-tools/` hold
only markdown; `bin/*` are dangling symlinks (`tgql-codegen`/`trpc-codegen`/`zod2ts` point at
`../packages/{tgql-codegen,trpc-codegen}/bin/…` and `../build-tools/zod2ts/bin/…`, none of
which exist under those paths in this checkout). Practical consequence for Phase D: the
program's `comment-proof.sh` gate (covers `.ts/.js/.mjs?/.svelte/.yaml`, explicitly **not**
`.py`/`.sh`) mechanically verifies comment-only edits to 853 of soa's 888 files — but several
of the highest-value Phase D targets below (§9) are `.sh` files, so those edits fall back to
manual before/after diff review, not the mechanical gate.

**Generated-file check:** grepped `@generated`/`DO NOT EDIT`/`Generated file`/`auto-generated`
across all scope — 5 hits, all hand-written source that *talks about* generation (a
`tgql-types/index.ts` comment about what codegen doesn't yet cover, a cookie-jar's literal
Netscape-cookie-file text, a build-clean.ts JSDoc, an `infra/src/ec2/compose-generator.js`
template string). **No generated files in scope, no Dockerfile, no `docker-compose.yml`
(compose lives as `infra/compose/**/*.yml`, in scope and counted), no `.prisma`, no `.sql`**
(5 `.sql` seed files exist under `infra/compose/**/seed/` but aren't a scanned extension).

## 1. Comment vs. code density by area

| Area | Files | Code | Comment | % |
|---|---:|---:|---:|---:|
| `packages/node/saga-stack-cli` | 320 | 51,834 | 17,804 | 25.6% |
| `tools/synthetic-dev` | 16 | 3,520 | 1,847 | 34.4% |
| `infra` | 50 | 6,190 | 1,127 | 15.4% |
| `packages/node/mesh-fixture-cli` | 30 | 2,533 | 674 | 21.0% |
| `packages/node/observability` | 13 | 1,879 | 660 | 26.0% |
| `packages/node/event-outbox` | 11 | 1,000 | 295 | 22.8% |
| `packages/node/postgres` | 9 | 1,010 | 281 | 21.8% |
| `packages/node/api-core` | 23 | 2,126 | 264 | 11.0% |
| `packages/core/saga-fga` | 4 | 832 | 259 | 23.7% |
| `packages/node/api-util` | 13 | 528 | 233 | 30.6% |
| `apps/node/tgql-api` | 31 | 1,829 | 232 | 11.3% |
| `tools/walkthrough-video` | 7 | 799 | 216 | 21.3% |
| `packages/node/event-consumer` | 10 | 1,133 | 212 | 15.8% |
| `apps/node/trpc-api` | 45 | 2,886 | 200 | 6.5% |
| `packages/node/db` | 17 | 1,100 | 189 | 14.7% |
| `packages/node/fixture-serve` | 16 | 2,006 | 188 | 8.6% |
| `packages/node/contract-check` | 12 | 1,250 | 183 | 12.8% |
| `packages/node/pubsub-client` | 8 | 1,084 | 181 | 14.3% |
| `packages/node/rabbitmq` | 10 | 691 | 160 | 18.8% |
| `packages/node/health` | 7 | 516 | 144 | 21.8% |
| `packages/core/fixture-deidentify` | 8 | 421 | 134 | 24.1% |
| `packages/core/saga-authz-model` | 7 | 479 | 132 | 21.6% |
| `apps/node/gql-api` | 19 | 947 | 131 | 12.2% |
| `scripts` | 7 | 1,090 | 128 | 10.5% |
| `packages/node/logger` | 9 | 633 | 127 | 16.7% |
| `packages/web/rum-util` | 5 | 392 | 118 | 23.1% |
| `packages/node/preview-headers` | 7 | 182 | 117 | **39.1%** |
| `packages/core/seed-ids-kit` | 7 | 285 | 116 | 28.9% |
| `packages/node/inspect` | 11 | 660 | 104 | 13.6% |
| `packages/node/pubsub-server` | 18 | 1,782 | 99 | 5.3% |
| `tools/virtual-devices` | 4 | 392 | 94 | 19.3% |
| `packages/core/tgql-codegen` | 12 | 1,148 | 83 | 6.7% |
| `packages/node/mailer` | 10 | 289 | 82 | 22.1% |
| `packages/node/event-integration-tests` | 9 | 790 | 69 | 8.0% |
| `apps/node/rest-api` | 12 | 610 | 65 | 9.6% |
| `packages/node/redis-core` | 6 | 450 | 63 | 12.3% |
| `packages/node/pubsub-core` | 12 | 874 | 58 | 6.2% |
| `packages/core/eslint-config` | 6 | 201 | 45 | 18.3% |
| `packages/node/event-test-harness` | 4 | 123 | 39 | 24.1% |
| `packages/core/config` | 10 | 394 | 38 | 8.8% |
| `packages/node/event-envelope` | 6 | 286 | 37 | 11.5% |
| `apps/web/web-client` | 15 | 2,040 | 22 | 1.1% |
| other 6 areas (`test-util`, `web/ui`, `aws-util`, `core/trpc-base`, `apps/examples`, `apps/web` root) | 32 | 605 | 47 | 7.2% |
| **Total** | **888** | **99,819** | **27,297** | **21.5%** |

`packages/node/saga-stack-cli` alone holds **65.2%** of every comment line in the repo — a
single 320-file package (the `ss` CLI that drives the synthetic dev stack, per the
`saga-iac:ss` skill) outweighs everything else combined. Add `tools/synthetic-dev` (the shell
half of the same dev-stack tooling, 6.8%) and **72%** of all comment volume sits in one
subsystem: local-environment orchestration, not application logic. `packages/node/
preview-headers` is the density outlier (39.1% — a 7-file, 182-code-line package almost
entirely JSDoc contract). Overall density (21.5%) sits below saga-dash's 23.7%, consistent
with soa being infrastructure/tooling-heavy rather than UI-heavy (no Svelte, no e2e-header
convention).

## 2. Large blocks (≥8 lines)

**806 blocks ≥8 lines** (2,704 total ≥3 lines; 8,027 comment blocks of any length). Unlike
every sibling census so far, the top 20 is dominated by **file headers** (17 of 20), and
those headers are overwhelmingly individual command/script contracts, not a repeated family:

| Len | path:line | Gist | Class |
|---:|---|---|---|
| 164 | `tools/synthetic-dev/up.sh:1` | full stack topology (10 services) + usage/flags reference | **Relocate** (topology half duplicates README.md) |
| 70 | `tools/synthetic-dev/apply-local.sh:1` | local→cloud config capture/replay, paired with capture-local.sh | Load-bearing |
| 64 | `packages/node/saga-stack-cli/src/commands/develop/session-adm.ts:1` | `develop session-adm` — 5-step demo choreography, LOAD-BEARING relaunch ordering called out explicitly | Load-bearing |
| 61 | `packages/node/saga-stack-cli/src/runtime/prep.ts:1` | R1 native prep pass, BLOCKER-B (db:generate scoping) | Load-bearing |
| 58 | `packages/node/saga-stack-cli/src/commands/stack/hydrate.ts:1` | prod-mirror hydrate: stage→verify→rename, preview-by-default rationale | Load-bearing |
| 57 | `packages/node/saga-stack-cli/src/commands/stack/wipe.ts:1` | soa#340/#351 — 4-step slot wipe, explicit contrast with `down`/`cold-start` | Load-bearing |
| 56 | `packages/node/saga-stack-cli/src/runtime/migrate.ts:1` | R3 native migrate runner, why `profile-empty.sql` needs it first | Load-bearing |
| 50 | `packages/node/saga-stack-cli/src/commands/develop/connect.ts:1` | `develop connect`, gh_305 migration + deprecating alias note | Load-bearing |
| 50 | `packages/node/saga-stack-cli/src/core/env/services.ts:1` | soa#355 deployed-env health model, 2026-07-21 empirically-learned deltas | Load-bearing |
| 49 | `packages/node/saga-stack-cli/vendor/refresh-suite.sh:1` | vendored copy of tools/synthetic-dev's script — documented divergence | Load-bearing (intentional duplicate, do not merge) |
| 49 | `tools/synthetic-dev/refresh-suite.sh:1` | canonical original of the pair above | Load-bearing |
| 46 | `packages/node/saga-stack-cli/src/core/env/reset-plan.ts:1` | soa#355 Phase 1 delete-cascade, verified table-by-table against Prisma schemas | Load-bearing |
| 46 | `packages/node/saga-stack-cli/src/runtime/reset.ts:1` | R4 native reset runner, why iam groups need a clean baseline | Load-bearing |
| 45 | `infra/compose/projects/saga-mesh.yml:1` | SDS #80 cross-repo fixture mesh topology, correctly qualifies "that repo's" sds_80 cite | Load-bearing |
| 45 | `packages/node/saga-stack-cli/src/commands/env/org/reset.ts:1` | soa#355 Phase 1, first destructive `env` command, dry-run canon | Load-bearing |
| 44 | `packages/node/mesh-fixture-cli/fixtures/adm-combined/create.sh:1` | authors the adm-combined fixture across 3 named programs | Load-bearing |
| 44 | `packages/node/saga-stack-cli/src/core/derive-instance.ts:70` | slot>0 collision matrix — which services are excluded and why | Load-bearing |
| 43 | `packages/node/saga-stack-cli/src/core/derive-instance.ts:1` | soa#271 — the ONE slot→InstanceProfile factory, purity + disjointness assert | Load-bearing |
| 43 | `packages/node/saga-stack-cli/src/core/provenance.ts:1` | 2026-08-05 measured incident: stale vite process serving dead code | Load-bearing |
| 42 | `packages/node/event-outbox/src/create-pool.ts:32` | Prisma `?schema=` → libpq `search_path` translation, preview-isolation contract | Load-bearing (cites dangling doc, §4) |

19/20 load-bearing (95%), 1 Relocate. Contrast with saga-dash: there, the top 20 was one
repeated e2e-header family re-explaining the same taxonomy per file. Here, spot-checking 5
siblings (`hydrate.ts`, `wipe.ts`, `migrate.ts`, `session-adm.ts`, `prep.ts`) confirms each
documents a **different** command's own irreducible contract — same formatting convention
(named WHY, explicit divergence-from-sibling-command callouts), zero shared narrative text.
`saga-stack-cli` holds 545/806 (67.6%) of all ≥8-line blocks and 312/455 (68.6%) of all file
headers — it is the repo's comment mass, and almost none of that mass is a Relocate-family
candidate the way saga-dash's `e2e/scheduling/topology-*` was. The one true header-duplication
family in the repo is the **vendored-pair** pattern (§9): `refresh-suite.sh`, `browser-login.mjs`,
and `tunnel.sh` each exist twice (`tools/synthetic-dev/*` + `packages/node/saga-stack-cli/
vendor/*`) with byte-identical header comments, by design — the vendor copy's own script text
explains why (soa#214: runs standalone with an env-var override, "the original tools/
synthetic-dev copy is untouched"). Not a merge target.

## 3. Historic-marker census

| Marker | Count | Example |
|---|---:|---|
| issue ref `#\d+` | 650 | `derive-instance.ts:1` — "soa#271... its listen port is env-driven" |
| `2026-` date | 149 | `provenance.ts:11` — "measured on 2026-08-05: slot 0's coach-web was served by a stale vite" |
| `was ` | 308 | mostly non-narrative ("was pinned to", "was generated by") |
| `legacy` | 67 | `up.sh` — "byte-identical legacy behaviour" (concierge-script parity notes) |
| `migrated`/`migration` | 254 | dominated by literal Prisma "migration"/"migrations" vocabulary, not narrative |
| `phase` | 435 | dominated by literal "Phase 1"/"Phase 2" plan-stage labels + Prisma "phase" hits |
| `no longer` | 41 | `derive-instance.ts:79` — "`ads-adm-api` is NO LONGER excluded" |
| `previously` | 15 | scattered, mostly qualifying a still-live behavior change |
| `used to` | 32 | scattered |
| `before this` | 14 | scattered |
| `see claude/` (repo-relative `claude/…`) | 14 | `rabbitmq/connection-manager.ts:70` — "See `claude/projects/soa_75/decisions/d-consumer-resilience.md`" |
| `@see specs/` | **0** | soa has no `specs/` directory and no `@see`-tag convention at all |
| `@spec` | 4 | all 4 in `packages/node/api-util/**` citing the **janus repo's** `specs/contracts/saga-auth-signal.spec.md` |

As in every sibling repo, most markers back a live invariant, not standalone changelog prose
— confirmed by §7's 0% pure-historic-narrative count. The one structural surprise: soa has
**zero** `@see`/spec-linkage convention and no linkage tool (`scripts/` holds
`cross-repo-link.sh`, a package-linking toggle, not a doc-test validator — confirmed by
reading it in full). §8 explains what that means for Phase D's never-touch list.

## 4. Dangling doc paths & cross-repo pointers

**No linkage script exists to run** (unlike saga-dash's `ensure-spec-test-linkage.js`) — every
row below was resolved by hand against the checkout.

**Genuinely dangling, found by this census:**

| Citer | Cites (missing) | Note |
|---|---|---|
| `packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts:4` | `claude/projects/sds_80/phase-3/architecture-pattern-audit.md` | **Unqualified cross-repo pointer** — no `sds_80` dir exists in soa's own `claude/projects/`; this initiative belongs to student-data-system (confirmed: SDS's own `CLAUDE.md` names `claude/projects/sds_80/decisions/` as its own). Same defect class rostering's census flagged and saga-dash's confirmed it did **not** have. |
| `packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts:6` | `claude/projects/sds_80/decisions/d3.6-phase-b-transform.md` | Same file, same unqualified-cross-repo defect, 2nd citation |
| `packages/node/mesh-fixture-cli/src/commands/pgm/enroll.ts:4` | `claude/projects/sds_80/phase-3/architecture-pattern-audit.md` | Same target as above, 3rd citer |
| `packages/node/rabbitmq/src/connection-manager.ts:70` | `claude/projects/soa_75/decisions/d-consumer-resilience.md` | `soa_75/decisions/` exists (12 other `d-*.md` files do) but not this one — dangling within soa's own tree |
| `packages/node/event-outbox/src/create-pool.ts:41` | `d-preview-deploy-isolation.md` | Bare filename, no path at all — not found anywhere in repo |
| `packages/node/event-envelope/src/preview-tag.ts:8` | `d-preview-deploy-isolation.md` | Same bare-filename target, 2nd citer |
| `tools/synthetic-dev/capture-sandbox.sh:23` | `docs/promotion-pipeline.md` | `tools/synthetic-dev/` has no `docs/` subdir (its docs are flat: `README.md`/`STATUS.md`/`INTEGRATION.md`/`getting-started.md`); file not found repo-wide |
| `tools/synthetic-dev/capture-local.sh:21` | same target | 2nd citer |
| `tools/synthetic-dev/up.sh:417` | same target | 3rd citer |

**Ruled out as false alarms / correctly qualified** (worth recording so no one "fixes" them):
`infra/compose/projects/saga-mesh.yml:45` cites `claude/projects/sds_80/phase-2/` but
explicitly prefixes "See **that repo's** claude/projects/…" — correctly qualified, matches
the pattern saga-dash's census called out as the right way to do it. `services/switchboard/
docs/snapshot-schema-versioning.md` (3 citers, `infra/src/ec2/{ec2-router,profiles}.js`) is a
cross-repo (microservices) pointer soa cannot verify locally; 2 of 3 citations explicitly say
"in the microservices repo" (`profiles.js:62`, `:291`), the 3rd (`ec2-router.js:26`) doesn't
repeat the qualifier but sits in the same file/area as the qualified pair — low-ambiguity, not
a real defect, leave as-is. `claude/projects/gh_214/multiseed-research.md`
(`saga-stack-cli/src/core/seed/datasets.ts:3`) and `claude/projects/ss-develop-session-adm-plan.md`
(`session-adm.ts:3`) both resolve fine inside soa's own `claude/`. All `docs/tunnel.md`,
`docs/e2e-review.md`, `docs/instrumentation.md` citations (18 occurrences across
`saga-stack-cli/src/**`) resolve — all three files exist under `packages/node/saga-stack-cli/
docs/`, the package-relative form is consistent and correct. `saga-dash docs/dev-toggle-ads-adm.md`
(`tools/synthetic-dev/up.sh:1692`) is correctly qualified and — per saga-dash's own census —
resolves there.

**Never-touch note:** `packages/node/saga-stack-cli/src/core/provenance.ts:30`'s
`~/dev/soa/.claude/worktrees/x/apps/…` and the 4 `.claude/worktrees/pr332` test-fixture
strings are literal example paths in prose/test fixtures, not citations — not part of this
count.

## 5. TODO/FIXME/HACK

**0 FIXME, 0 HACK.** **9 TODO occurrences**, and unlike every sibling repo this is not a
TODO-family repo:

- **3 genuinely open, standalone:** all in `apps/node/trpc-api/src/sectors/pubsub/trpc/
  pubsub-router.ts` (lines 28, 126, 202) — `// TODO: Inject actual services` /
  `// TODO: Get from pubsub service` (×2). No issue number, no owner tag, no family — looks
  like scaffolding left over from the pubsub sector's initial build-out.
- **6 are meta-references**, not open items: `saga-stack-cli/eslint.config.js:15,53` (one
  points at "the TODO" in a files-block comment, one is `TODO(M1)` — a real open item, but
  framed as a milestone note rather than a bare TODO tag) and 4 more
  (`e2e-orchestrate.ts:18`, `core/launch-plan.ts:29`, `core/flag-map.ts:32`, `runtime/mesh.ts:27`)
  that all use the word "TODO" while *discussing* deferred work conceptually ("flagged as a
  TODO", "see `laneOverlay`'s TODO", "noted as TODOs for the full M6 port") rather than
  carrying the tag themselves.

No family, no cluster, no subtree-wide port-in-progress the way saga-dash's `qtf/` was. Not a
Phase D concern either way — too few, too scattered to be worth touching as a group.

## 6. Commented-out code

**0 statement-shaped commented-out code found.** Grepped for `// import|const|export|function|
if(|return|class` at line-start across all TS/JS scope: 4 hits, all false positives — English
sentences that happen to start with a keyword ("// return immediately: a 401 IS the torn-
checkpoint verdict...", "// export the WAN timeout for nothing"). Grepped separately for
`REMOVED|DISABLED|OLD` tags: 1 genuine but trivial hit —
`packages/node/api-core/src/abstract-rest-controller.ts:47`, a bare
`// Removed the /sectors route from here` with **no route left to remove and nothing else in
the comment** — pure historic fossil, zero information for a current reader, 1 line (below
the ≥8 threshold but worth flagging since it's the only comment in the entire census that
reads as a diff-against-the-past with zero remaining value). No `packages/web/pages/reports/
src/lib/qtf/`-shaped known-incomplete-port subtree exists in soa. **This repo has essentially
no commented-out-code problem.**

## 7. Classification of 40 random ≥3-line blocks

Sampled uniformly (seed 42) from the 2,704-block ≥3-line pool.

| Category | Count |
|---|---:|
| (a) Load-bearing invariant/gotcha | 36 |
| (b) Restatement | 1 |
| (c) Historic narrative | 0 |
| (d) Reference-only | 3 |
| (e) Dead code | 0 |

**90% load-bearing** — the highest of any repo surveyed in the program so far (saga-dash:
87.5%). The 1 restatement: `infra/src/handlers.js:14`, a bare `@param` JSDoc with no rationale
beyond the signature. The 3 reference-only: `infra/src/router.js:4` (mount-usage example, no
gotcha), `infra/compose/projects/events-example.yml:1` (usage header, `--help`-shaped),
`event-test-harness/src/index.ts:85` (call-sequence usage example). 0 historic narrative, 0
dead code — matches §2's top-20 read (95% load-bearing) and §6's near-zero commented-out-code
finding. soa's comment mass reads as **operational contract**, not design retrospective: even
blocks that cite an issue number or a measured date (§3) are stating a still-live constraint
("this is why X must happen before Y"), not narrating what used to be true.

## 8. Never-touch inventory

**soa has no `@see`/spec-linkage convention to protect** — §3/§4 found 0 `@see` tags anywhere
in scope and no linkage script (`cross-repo-link.sh` is a package-linking toggle, read in
full, unrelated to doc/test linkage). The 4 `@spec` occurrences (`packages/node/api-util/
src/utils/{saga-auth-url,dev-perimeter-config,dev-perimeter-production}.ts` +
`.test.ts`) all point at the **janus repo's** `specs/contracts/saga-auth-signal.spec.md` — a
cross-repo pointer soa cannot verify locally, correctly qualified ("(janus repo)") in 3 of 4
instances (`saga-auth-url.ts:4` omits the qualifier but is the same target 2 lines from a
qualified sibling test file) — never rewrite these without checking janus's spec first.

Other never-touch categories: **25 `eslint-disable*`**, **3 `@ts-expect-error`** (2 identical
"Apollo Server v4+ middleware type mismatch with Express" in `api-core/src/{tgql,gql}-server.ts`
— a real, load-bearing type-suppression pair, not a duplicate to merge; 1 in a unit test), **0
`@ts-ignore`, 0 `@ts-nocheck`**, **0 `svelte-ignore`** (0 `.svelte` files in scope — nothing to
find), **1 `shellcheck disable`** (`scripts/morning-auth.sh:61`, `SC2086`, of 35 `.sh` files —
none other use it), **49 shebangs**, **4 `c8 ignore`** (all in `saga-stack-cli`, each with an
inline reason — "every seed `command` is authored non-empty", "exhaustive guard for the
4-member verb union" — none bare), **0 genuine license/copyright headers** (0 grep hits at
all, not even a false positive). **0 `@generated`/DO-NOT-EDIT build output** (§0). Also
never-touch: the **vendored-pair headers** (§2/§9) — `refresh-suite.sh`, `browser-login.mjs`,
`tunnel.sh` — their duplication is deliberate and self-documented; collapsing them into "one
canonical + pointer" would break the vendor copy's designed-to-run-standalone property.

## 9. Removable/relocatable estimate and starting files

**Estimated removable/relocatable share: ~2–5%** of 27,297 comment lines (~550–1,350 lines) —
lower than every sibling census so far, tracking §7's 90% load-bearing figure, 0%
pure-historic-narrative, and §2's finding that soa's large-block mass is individually
irreducible per-command contracts rather than a repeated narrative family. Checked the
strongest issue-density candidate directly: only 35/806 blocks ≥8 lines cite 2+ distinct issue
numbers (6 cite 3+, vs. saga-dash's 428/3307 and 138/3307) — topped by
`packages/node/saga-stack-cli/src/core/manifest/services.ts:819` (5 issues in 29 lines). Read
in full: each of its 5 issue citations (soa#336, soa#328, soa#298, soa#300, coach#329) backs a
*different* fact in one incident's causal chain (a stale-vite-adoption bug and its fix) — same
"not Cite-once fodder" conclusion every sibling repo reached about its own densest blocks.

The one real **Relocate** opportunity in the repo: `tools/synthetic-dev/up.sh`'s 164-line
header (§2, the longest block found). Lines 3–67 (topology: what the 10 services are, their
ports, their DB ownership, the Connect/rtsm-api additions) are a near-verbatim duplicate of
content already in `tools/synthetic-dev/README.md` (confirmed by reading both — the README's
own opening paragraph names the same sixth/seventh/eighth-ninth/tenth services in the same
order with the same soa#/decision citations). Lines 68–163 are CLI `--help`-shaped usage/flag
documentation, which is defensible to keep inline since a user reads it at the point of
running the script. Recommended split: trim lines 3–67 to a 3–5 line summary + pointer to
`README.md` (which already carries the authoritative version), leave lines 68–163 untouched.
This is the one Phase D target that is a `.sh` file, so its edit needs manual before/after
diff review (comment-proof.sh doesn't cover `.sh`) — verify the script still executes
identically after trimming the header (the header is 100% comment lines, so behaviorally
inert, but confirm with `shellcheck` + a dry run of `./up.sh --status`).

**Three files/clusters to start with:**
1. **The 3 unqualified/dangling cross-repo `sds_80` citations** (`packages/node/
   mesh-fixture-cli/src/commands/ads/seed-attendance.ts:4,6` +
   `packages/node/mesh-fixture-cli/src/commands/pgm/enroll.ts:4`) — add the "student-data-system"
   repo qualifier (matching `saga-mesh.yml:45`'s "that repo's claude/projects/…" style) or
   verify with the SDS team whether `sds_80/phase-3/architecture-pattern-audit.md` and
   `sds_80/decisions/d3.6-phase-b-transform.md` still exist there before deciding to keep,
   requalify, or drop. Cheapest, highest-confidence fix in the repo (2 files, 3 lines).
2. **The 2 fully-dangling within-repo/bare citations** — `packages/node/rabbitmq/src/
   connection-manager.ts:70` (`claude/projects/soa_75/decisions/d-consumer-resilience.md`,
   missing from an otherwise-complete 12-file decisions dir) and the bare-filename
   `d-preview-deploy-isolation.md` cited from `packages/node/event-outbox/src/create-pool.ts:41`
   + `packages/node/event-envelope/src/preview-tag.ts:8` — either locate/restore the intended
   doc or drop the dangling reference; 3 citer:line instances, 2 distinct targets.
3. **The `docs/promotion-pipeline.md` cluster** (`tools/synthetic-dev/capture-sandbox.sh:23`,
   `capture-local.sh:21`, `up.sh:417`) — same target, 3 citers, `tools/synthetic-dev/` has no
   `docs/` subdirectory for it to live in; either author the doc (INTEGRATION.md/getting-started.md
   already exist as the natural home) or repoint/drop the citation.

**Files of interest:**
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/tools/synthetic-dev/up.sh`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/tools/synthetic-dev/README.md`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/tools/synthetic-dev/capture-sandbox.sh`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/tools/synthetic-dev/capture-local.sh`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/mesh-fixture-cli/src/commands/ads/seed-attendance.ts`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/mesh-fixture-cli/src/commands/pgm/enroll.ts`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/rabbitmq/src/connection-manager.ts`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/event-outbox/src/create-pool.ts`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/event-envelope/src/preview-tag.ts`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/infra/compose/projects/saga-mesh.yml`,
`/home/spaul/dev/soa/.claude/worktrees/docs-cleanup/packages/node/saga-stack-cli/vendor/refresh-suite.sh`.
