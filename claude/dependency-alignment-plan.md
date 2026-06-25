# Cross-Repo Dependency Alignment Plan

Branch: `claude/cross-repo-consolidation-0hjwe8` (all 11 repos).

## Goal

Consolidate external (npm) dependency versions across the Saga fleet — soa, rostering,
iac, qboard, saga-dash, program-hub, student-data-system, fleek, claude-plugins, janus,
coach — and chase the latest published versions. Internal `@saga-ed/*` deps are out of
scope (version-locked by the workspace/link graph).

## Two-tier strategy

Each external dependency occurrence is classified **per-occurrence** by a
**caret-compatibility key**:

- key = `M<major>` when major ≥ 1 (e.g. `^5.8.2` → `M5`)
- key = `0.<minor>` when major == 0 (e.g. `^0.55.0` → `0.55`) — because in `0.x`
  semver the **minor** is the breaking position
- key = `0.0.<patch>` when `0.0.x`

A bump that **stays within the same key** is **safe** (de-skew). A bump that **crosses
the key** is **breaking** (major). This matches npm `^` range semantics, so it correctly
treats e.g. `@opentelemetry/sdk-node ^0.55 → ^0.219` as breaking, not safe.

> Why this matters: the first naive pass classified by integer major only, so it scored
> the OpenTelemetry `0.55 → 0.219` jumps as "safe". Applied to soa, that pulled
> `@opentelemetry/resources@2` transitively while the pinned `resources` stayed `@1`,
> breaking the `soa-observability` DTS build (`Property 'getRawAttributes' is missing`).
> The caret-compatibility key fixes the whole fleet.

## The skew (evidence)

82 external deps run >1 distinct version range across the fleet; **34 are cross-major**
(different majors live simultaneously across repos). Worst offenders:

| dep | majors in fleet | latest | note |
|-----|-----------------|--------|------|
| typescript | 4, 5 | 6.0.3 | 4.x only in iac; fleet mostly 5.8/5.9 |
| zod | 3, 4 | 4.4.3 | most repos 3.25; soa already had a 4.x occurrence |
| express | 4 | 5.2.1 | breaking 4→5 |
| inversify | 6 | 8.1.1 | breaking 6→8 (decorator/container API) |
| vitest | 1, 2, 4 | 4.1.9 | saga-dash/janus already on 4 |
| mongodb | 3, 5, 6 | 7.3.0 | breaking driver changes per major |
| eslint | 7, 8, 9, 10 | 10.5.0 | flat-config migration past 9 |
| @types/node | 14, 20, 22, 24, 25 | 26.0.1 | should track the deployed runtime, not blindly latest |
| @opentelemetry/* (sdk-node, exporter, instrumentation) | 0.10–0.55 | 0.219 / 0.77 / 0.32 | 0.x — minor is breaking; couple with resources 1→2 |
| graphql / @apollo/server | 16 / 4 | 17 / 5.5.1 | coupled with graphql-codegen 4/5 → 6/7 |
| vite / @sveltejs/vite-plugin-svelte | 6,7 / 5,6 | 8.1.0 / 7.1.2 | frontend chain (saga-dash, janus, qboard, rostering web) |
| uuid | 8, 11, 13 | 14.0.1 | ESM-only past 9 |

## Status — Tier 1 (safe de-skew): APPLIED + PUSHED

One commit per repo (`deps: de-skew external dependencies to latest within-major`).

| repo | safe edits | files | build verification |
|------|-----------:|------:|--------------------|
| soa | 163 | 45 | **GREEN** — `pnpm build` 40/40 locally (node 22) |
| student-data-system | 155 | 32 | CI (not locally buildable — see constraints) |
| program-hub | 95 | 23 | CI |
| saga-dash | 92 | 20 | CI |
| rostering | 74 | 15 | CI |
| qboard | 61 | 13 | CI |
| coach | 42 | 8 | CI |
| iac | 40 | 4 | CI |
| fleek | 27 | 8 | CI |
| janus | 18 | 4 | CI |
| claude-plugins | 0 | 0 | n/a (no external npm deps) |

soa is the only repo fully buildable in this environment (it is self-contained — no
external `@saga-ed/*` deps), so it is the verified reference. The rest rely on CI; the
classifier and writer are identical to the soa pass, and edits are surgical (version
value only, formatting/indentation preserved).

## Status — Tier 2 (breaking majors): NOT APPLIED (evidence captured, migration required)

Applying the major tier to soa and building produced (TypeScript 6 + the major jumps):

- **TS5101** — `Option 'baseUrl' is deprecated and will stop functioning in TypeScript
  7.0` (fleet-wide; every tsconfig using `baseUrl` needs `"ignoreDeprecations": "6.0"`
  or a `paths`/`baseUrl` rework)
- **TS2591** — `Cannot find name 'node:crypto'` (@types/node 26 + TS6 module resolution)
- **TS2554** — changed call signature (`Expected 2-3 arguments, but got 1`)
- **Segfault (exit 139)** in the tsup/rollup DTS worker under TS6 + rollup 4.53 + swc —
  toolchain instability, not just type errors

Conclusion: the major tier is a **staged migration**, not a mechanical bump. It was
reverted; soa HEAD carries only the verified-green safe tier.

### Breaking-major migration checklist (recommended sequence, low→high blast radius)

1. **Toolchain deprecations first** — add `"ignoreDeprecations": "6.0"` (or rework
   `baseUrl`) ahead of the TS 5→6 bump; pin a tsup/rollup combo that doesn't segfault.
2. **@types/node** — align to the deployed runtime (node 24), not blindly 26.
3. **vitest 1/2 → 4** (+ `@vitest/coverage-v8`, peer: needs vite ≥6) — saga-dash/janus
   already on 4 (reference).
4. **eslint → 10** — flat config; iac (7/8) is the big lift.
5. **zod 3 → 4** — `.merge`/error-map/`z.record` API changes; high fan-out.
6. **express 4 → 5** — router, `req.query` immutability, error handling.
7. **inversify 6 → 8** — decorator + container API; every DI binding.
8. **mongodb → 7**, **uuid → 14** (ESM), **graphql 17 + @apollo/server 5 + codegen 6/7**
   (coupled).
9. **vite 8 + @sveltejs/vite-plugin-svelte 7** — frontend repos.

Do each as its own PR per repo (or per-major across repos), with CI green before merge.

## Environment & verification constraints (discovered)

- **Private registry**: `@saga-ed:*` resolves to AWS CodeArtifact; no auth token is
  provisioned here (401). In-env AWS creds are rejected (`UnrecognizedClientException`),
  AWS CLI absent — a token can't be minted locally.
- **Local-link coverage**: 140 `@saga-ed/*` packages are provided across the 11 repos;
  only **5** registry deps have no local source and still need CodeArtifact:
  `@saga-ed/rtsm-client`, `@saga-ed/recording-plan-schema` (rtsm), `@saga-ed/design-tokens`,
  `@saga-ed/llm-insights-api-types`, `@saga-ed/soa-mailer`. They block full local installs
  of qboard, fleek, student-data-system, saga-dash, and rostering respectively.
- **Toolchain**: node v22 is the newest available locally; most repos request node ≥24
  (not strictly enforced — soa installs+builds clean on 22). pnpm 10 in PATH; repos pin 9.

### To verify the whole fleet locally
Provide a `CODEARTIFACT_AUTH_TOKEN` (`aws codeartifact get-authorization-token --domain
saga --domain-owner 531314149529`, 12h TTL) **and** node 24. Then each repo can
`pnpm install` (linking local soa via `pnpm soa:link:on`) and build before push.

## Durable enforcement (recommendation, deferred)

After de-skew, prevent re-divergence with **pnpm catalogs** (`pnpm-workspace.yaml`
`catalog:`) per repo + a fleet-level `syncpack` check in CI. Deferred from this pass to
keep the bump reviewable; worth a dedicated follow-up.

---
*Generated during cross-repo dependency consolidation.*
