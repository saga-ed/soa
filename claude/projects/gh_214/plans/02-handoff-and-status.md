# saga-stack-cli — build status & handoff (#214)

> Where the implementation landed after M0–M6, what is verified, and what
> deliberately remains. Pairs with `01-saga-stack-cli-plan.md` (plan of record).

## Status: M0–M6 built, all CLI-side; **362 tests (348 pass / 14 todo), 0 fail**

Package: `@saga-ed/saga-stack-cli` at `soa/packages/node/saga-stack-cli` (branch `gh_214`).
Commits: `docs` + `M0`…`M6` (one per milestone).

| Milestone | Delivered | Verified by |
|---|---|---|
| **M0** | OCLIF scaffold, frozen service manifest (13 svc + 4 mesh + 13 DB), `computeClosure`, launch-order, seed/flow core, `stack up --dry-run` | build + unit tests + manifest fidelity audit |
| **M1** | pure flag→argv/env mapper + `stack up/down/restart/status/seed/reset/login/verify` wrapping up.sh/verify.sh | golden parity tests + parity audit vs up.sh |
| **M2** | `overlay`/`tunnel`/`bootstrap` wrappers, `e2e` topic shells, native manifest-derived `status`/`verify` (closes content-api :3009 gap, `--tolerate`) | build + tests + parity/probe audit |
| **M3** | native snapshot fast-path `stack snapshot store/restore/list/validate/delete` (9 pg DBs + connectv3 mongo, restore-as-owner, guards) — supersedes mesh-fixture-cli | build + tests + **fidelity audit (clean)** |
| **M4** | native partial-stack `stack up --only` (StackApi facade, faithful env wall, topo launch, mesh/preflight/dash-hook, composeSeedPlan) | build + tests + **env-wall audit** (caught the PINO blocker, fixed) |
| **M5** | native `e2e run` flow orchestration, flow resolver + discovery, centralized Monday clamp, per-system seed, bundled saga-dash example flows.json | build + tests + flow/clamp audit (restored N-of-M payoff) |
| **M6** | connectv3 externalization proof (2nd SPA, **zero new CLI logic**) | build + tests + zero-logic audit |

Every milestone: agents constrained to the package; `up.sh`/`verify.sh` and other
repos never edited (one early stray up.sh edit was caught and reverted); all
process/HTTP/docker IO mocked in tests via injectable seams.

## ⚠️ The single most important caveat

**The native paths (M4 `stack up --only`, M5 `e2e run`, M3 snapshot restore) are
built and unit/integration-tested with mocked Runner/Launcher/Prober/SnapshotIO
only — they have NOT been validated against a live stack** (no docker / real
services in the build environment). Per the plan's own risk note they must
**soak in daily use before anyone relies on them**. The full-stack `stack up`
(no `--only`) still wraps `up.sh`, so the existing daily workflow is unchanged
and safe; the native path is opt-in.

## Remaining work — deliberate handoff (NOT done here, and why)

1. **Live soak of the native paths** — bring up `stack up --only scheduling-api,sessions-api`
   and `e2e run saga-dash/journey` against a real mesh; confirm services boot and
   health-pass. *Why not here:* requires docker + the sibling repos running. This
   is the gate for everything below.
2. **Flip wrappers shell-out → native** (mesh_up/migrate/reset_data/seed-family) —
   the plan gates each flip on a successful soak. *Why not here:* unsoakable; flipping
   blind would risk the daily driver. The native ports for these are partially in
   place (M4 mesh/launch/seed); completing + defaulting them is post-soak.
3. **Real `flows.json` in the SPA repos** — author `saga-dash/apps/web/dash/e2e/flows.json`
   and `qboard/apps/web/connectv3/e2e/flows.json` from the bundled templates.
   *Why not here:* cross-repo PRs (saga-dash, qboard), each needs its own branch/review.
4. **Monday-flake fix end-to-end** — migrate the saga-dash journey specs to read
   `PLAYWRIGHT_OCCURRENCE_DATE` (+ extract `@saga-ed/saga-stack-e2e-kit`). The CLI
   injects the clamped date correctly **now**, but it's inert until the specs consume
   it. *Why not here:* cross-repo (saga-dash specs).
5. **Retire mesh-fixture-cli + delete the `.sh` scripts** — *Why not here:* destructive;
   waits on the snapshot path + native paths proving out in the soak.

## How to drive it today (safe, no infra)

- `node bin/dev.js stack up --dry-run` / `--only scheduling-api,sessions-api --dry-run` — closure planner
- `node bin/dev.js e2e list` / `e2e run saga-dash/journey --through pods --dry-run` — flow plan + injected occurrence date
- `node bin/dev.js stack <cmd> --help`, `e2e run --help`
- Full-stack `stack up`, `stack verify`, etc. wrap the real bash (work as today).
