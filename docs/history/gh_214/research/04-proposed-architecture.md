# Research 04 — proposed architecture & open questions (brainstorm)

> First synthesis to iterate on. Not a committed plan yet.

## What we're really migrating

Two bash bodies, ~3.4k + ~0.4k lines:
- **Stack concierge** (`soa/tools/synthetic-dev/*.sh`) — mesh up/down, in-tree `pnpm dev` of 10 services, PR overlay, seed, verify, tunnel, sandbox/workspace.
- **e2e orchestration** (`saga-dash/.../e2e/*.sh`) — flow definition (8-phase journey + connect-session), reset/seed/verify sequencing, Playwright stage projects, lane selection.

Plus prior art that changes the build-vs-buy math: **`@saga-ed/mesh-fixture-cli`** already exists (OCLIF v4, in soa, with `snapshot:`/`iam:`/`pgm:`/`ads:` topics, base-command, triple output).

## The two new requirements that forced this (from the brief)

1. **Partial stack** — run e2e with only N of M systems (e.g. scheduling-api + sessions-api: "do complex scheduling scenarios realize correct sessions?").
2. **Multiple named flows** with potentially different per-system seed data; e2e for SPAs beyond saga-dash.

Both are blocked today by the same root cause: **the service topology, dependencies, and seed mapping are implicit in bash**, not data.

## The linchpin: a declarative service manifest

Everything keys off one machine-readable manifest (lives in soa). Per service:
```
id, repo path + env-var override, port, health endpoint,
databases, depends_on[], launch cmd (pnpm dev), seed command(s),
lane URL templates (stack/sandbox/tunnel)
```
From this, derive (functions already proven separable — see `test-workspace.sh`):
- partial-stack **dependency closure** (`want scheduling+sessions` → adds iam, programs, mesh)
- `verify` health probes
- launch order
- which seeds to run for a chosen system set

This replaces the parallel bash arrays in `up.sh` and the hardcoded service list in `verify.sh`.

## Proposed CLI topology (RECOMMENDED, to confirm)

**One monorepo package in soa with a core lib + two command surfaces**, rather than two fully separate repos:

```
soa/packages/node/saga-stack-cli/        (new OCLIF package)
  src/core/        manifest, dep-closure, process mgmt, health, seed, lane  (pure, unit-testable)
  src/commands/
    stack/         up, down, restart, status, reset, seed, verify, overlay, login, tunnel
    e2e/ (or flow/) run, list, <flow> ...
```
- **Why one package, two topics** (not two binaries): the e2e CLI must call stack up/reset/seed/verify anyway; sharing a core lib in-process beats shelling out across package boundaries. `stack` and `e2e` topics keep the surfaces clean.
- **mesh-fixture-cli**: reuse its `base-command.ts` + output conventions; longer term, fold its `snapshot:`/`iam:`/`pgm:` topics in (or depend on it) so seed/snapshot is one story. Decision needed (Q below).

Alternative if you want hard separation: two packages (`saga-stack-cli`, `saga-e2e-cli`) over a shared `@saga-ed/stack-core` lib.

## Externalizing per-SPA e2e data

CLI (orchestration) stays in **soa**. Each SPA repo contributes a **flow manifest + its specs/fixtures**:
```
saga-dash/.../e2e/flows.json   → { journey: {systems:[…], seed:[…], projects:[stage-1..8], lane}, connect-session: {...} }
qboard/.../connectv3/e2e/flows.json → future SPA flows
```
The e2e CLI discovers registered SPA repos (via env-var paths, like up.sh already does), reads their flow manifests, computes the stack subset, drives synthetic-dev, runs Playwright against that repo's config. Repo-specific data (CSV fixtures, seed-user aliases, hardcoded ids) lives with the SPA; **only orchestration is centralized.**

## Migration strategy (RECOMMENDED: incremental wrap-then-port)

The bash is load-bearing and works. Lowest-risk path:
1. Build the manifest + core lib + OCLIF skeleton.
2. CLI commands **shell out to existing scripts** initially (`stack up` → `up.sh`), so the CLI is usable day one.
3. Port logic into the core lib piece by piece (start with the manifest-derived parts: status/verify/partial-stack), retiring bash functions as covered.
4. New capabilities (partial stack, named flows) built **natively** in the CLI from the start — they don't exist in bash, so nothing to wrap.

Clean rewrite is the alternative (higher risk, longer to first value).

## Suggested milestones (for discussion)
- **M0** — package scaffold (OCLIF, reusing mesh-fixture-cli base) + service manifest + dep-closure with unit tests.
- **M1** — `stack` topic wrapping up.sh/verify.sh; `stack status`/`verify` ported to manifest. Behavior parity.
- **M2** — partial stack: `stack up --only scheduling-api,sessions-api` computes + launches the closure.
- **M3** — `e2e`/`flow` topic: externalize saga-dash flows.json, run the 8-phase journey + connect-session through the CLI.
- **M4** — per-flow seed selection; fix Monday-flake clamp centrally; second SPA flow (proof of "other SPAs").
- **M5** — fold in overlay (refresh-suite), tunnel, snapshot/mesh-fixture-cli; retire bash.

## Open questions (to resolve with user)
- **Q1 CLI topology** — one package (stack+e2e topics) over a core lib [rec], vs two packages over shared lib, vs extend mesh-fixture-cli into the one CLI.
- **Q2 mesh-fixture-cli** — absorb its topics into the new CLI, depend on it as a lib, or leave it standalone?
- **Q3 migration** — incremental wrap-then-port [rec] vs clean rewrite.
- **Q4 first deliverable** — manifest+partial-stack foundation [rec] vs e2e-flow runner first vs behavior-parity stack wrapper first.
- **Q5 naming** — `saga-stack`/`saga` binary name; topic naming `e2e` vs `flow`.
