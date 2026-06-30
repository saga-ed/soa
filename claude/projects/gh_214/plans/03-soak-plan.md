# saga-stack-cli — soak / verification plan (#214)

> Execute at your desk, where docker + the sibling repos are available. Validates
> what M0–M6 built against a LIVE stack — especially the native paths that could
> only be mock-tested in CI. Work top-to-bottom; each phase builds on the last.
> Stop and capture logs at the first failure (see "If it breaks").

## Conventions

```bash
cd ~/dev/soa
alias ss='node packages/node/saga-stack-cli/bin/dev.js'   # dev runner (tsx, no build)
# (or after `pnpm --filter @saga-ed/saga-stack-cli build`: alias ss='node packages/node/saga-stack-cli/bin/run.js')
```

- State/logs for BOTH up.sh and the native path: `/tmp/sds-synthetic/` (`*.log`, `*.pid`).
- up.sh and `ss stack up --only` share that STATE dir + host ports — only ONE stack
  at a time. **Always `ss stack down` (or `./up.sh --down`) before switching paths.**
- ⚠️ Destructive steps are marked **[DESTRUCTIVE]** (they truncate/restore local DBs).
  Do them on your synthetic-dev data, not anything you care about.

---

## Phase 0 — Offline sanity (no infra) ~5 min

```bash
pnpm --filter @saga-ed/saga-stack-cli build      # PASS: tsc + oclif manifest, 0 errors
pnpm --filter @saga-ed/saga-stack-cli test       # PASS: 348 passed / 14 todo / 0 failed
ss --help                                         # lists topics: stack, e2e
ss stack --help ; ss e2e --help                   # all commands present
ss stack up --help                                # --only / --dry-run / --seed / etc.
ss stack up --only scheduling-api,sessions-api --dry-run
#   PASS: closure = iam-api, programs-api, scheduling-api, sessions-api;
#         dbs iam_local,iam_pii_local,programs,scheduling,sessions; mesh postgres,rabbitmq
ss stack up --only saga-dash --dry-run            # PASS: 8 services, NO connect/rtsm
ss e2e list                                       # PASS: saga-dash (journey, connect-session) + connectv3 (connect-smoke)
ss e2e run saga-dash/journey --through pods --dry-run
#   PASS: closure (4) iam-api,sis-api,programs-api,saga-dash; project stage-4-pods;
#         prints PLAYWRIGHT_OCCURRENCE_DATE + playwright argv; launches nothing
```
**Gate:** everything above is pure/offline. If any fail, fix before touching infra.

---

## Phase 1 — Trusted bash baseline (ground truth) ~10–15 min

Establish a known-good full stack with the EXISTING scripts, so native results have
something to compare to and your repos are confirmed in shape.

```bash
cd ~/dev/soa/tools/synthetic-dev
./up.sh up --reset --seed roster        # the trusted path
./verify.sh                              # PASS: all services healthy + data seeded
```
**Gate:** `verify.sh` green. Note the service list/ports it checks — that's the baseline.

---

## Phase 2 — Wrapped commands parity (M1/M2) — low risk ~10 min

These shell out to the SAME bash, plus the new native status/verify probes. Stack from
Phase 1 still up.

```bash
ss stack status                          # native probes; PASS: every service shows UP
                                         #   incl. content-api :3009 (verify.sh misses this)
ss stack verify                          # native health gate; PASS: exit 0
echo $?                                   # 0
ss stack verify --full                   # delegates to verify.sh (health+data+posture)
ss stack verify --tolerate saga-dash     # PASS: tolerated svc down ≠ failure
ss stack overlay list                    # PASS: prints your integration-suite.local.tsv (or empty)
ss stack tunnel status                   # read-only; PASS: no error
```
Wrapper-vs-bash equivalence (optional but reassuring):
```bash
ss stack down                            # == ./up.sh --down  (services stop, mesh stays)
ss stack status                          # PASS: services now DOWN, mesh still up
ss stack up                              # == ./up.sh up  (full wrap)  → then ss stack verify
```
**Gate:** `ss stack status`/`verify` agree with `verify.sh`; `verify --full` runs the real checks.

---

## Phase 3 — Native partial-stack (M4) — ⭐ the main unknown ~20 min

This is the headline path that was never run live. The risk is env-wall fidelity
(the PINO fix, every service's launch env). **Run from a CLEAN shell** (new terminal,
no exported PINO_*) to prove the CLI supplies them.

```bash
ss stack down --mesh                     # full clean slate (stop services + mesh)
# fresh terminal:
cd ~/dev/soa && alias ss='node packages/node/saga-stack-cli/bin/dev.js'
ss stack up --only scheduling-api,sessions-api
```
PASS criteria:
- `check_ports` preflight runs, mesh comes up (make up + readiness OK).
- Exactly 4 services launch in order: iam-api → programs-api → scheduling-api → sessions-api.
- Each health-polls green (no crash). **Specifically confirm no PINO startup crash:**
  ```bash
  grep -il pino /tmp/sds-synthetic/*.log        # PASS: no "PINO_LOGGER... required/validation" errors
  tail -5 /tmp/sds-synthetic/sessions-api.log   # PASS: listening, not a validation throw
  ```
- Spot-check env fidelity vs up.sh for one service:
  ```bash
  cat /tmp/sds-synthetic/scheduling-api.log | head      # boots clean
  # confirm RABBITMQ_URL/DATABASE_URL/IAM_API_URL/PINO_* are present in its env
  ```
```bash
ss stack status --only scheduling-api,sessions-api   # PASS: those 4 UP; others not probed
ss stack down
```
Then the dash closure:
```bash
ss stack up --only saga-dash             # native 8-service closure
ss stack verify --tolerate saga-dash     # PASS once backends healthy
ss stack down
```
**Gate:** native services boot healthy from a clean shell. If a service crashes,
that's an env-wall gap — capture its `/tmp/sds-synthetic/<svc>.log` and the env it got,
diff against the matching `up.sh` `services_up` line (this is the #1 thing to find in soak).

---

## Phase 4 — Snapshot fast-path (M3) — ⭐ second unknown ~15 min  **[DESTRUCTIVE]**

Round-trips real DBs (9 pg + connectv3 mongo). Restore overwrites local data.

```bash
# Start from a known-good seeded stack (Phase 1 baseline or `ss stack up` + seed).
ss stack snapshot store --fixture-id soak1            # PASS: dumps 9 pg + connectv3, writes manifest
ls ~/.saga-mesh/snapshots/soak1/                      # PASS: per-db dump files + manifest.json
ss stack snapshot list                                # PASS: soak1 with profile + dbs + schemaRevs
ss stack snapshot validate soak1                      # PASS: exit 0 (files exist, size>0, manifest parses)
ss stack snapshot validate soak1 --deep               # PASS: pg_restore --list succeeds

# [DESTRUCTIVE] mutate then restore:
ss stack reset                                        # truncate (proves data changed)
ss stack snapshot restore soak1                       # PASS: data back; restores AS each DB owner
#   verify a row count / a known seed id is present again

# Guards:
ss stack snapshot restore soak1 --force               # (cross-profile path) — refused w/o --force, allowed with
ss stack snapshot delete soak1                         # cleanup
```
PASS criteria: store→restore returns the DB to the snapshotted state; **no permission
errors on `_prisma_migrations`** (the restore-as-owner fix, esp. `ledger_local`→`ledger`);
guards behave (profile + schema-ahead). **Capture any `pg_restore`/`mongorestore` stderr.**

---

## Phase 5 — e2e flow run (M5) ~15 min

`e2e list`/`--dry-run` are safe. A real run uses the BUNDLED example flows.json (no
saga-dash `flows.json` exists yet) pointed at saga-dash's REAL `playwright.stack.config.ts`
+ stage projects (which DO exist). Stack must be up (Phase 1 or `ss stack up`).

```bash
ss e2e run saga-dash/journey --through pods --dry-run   # confirm closure + playwright argv first
ss e2e run saga-dash/journey --through roster --headless
#   PASS: brings up the closure → reset/seed → verify → runs playwright stage-1-roster headless, green
ss e2e run saga-dash/journey --through pods --headless   # progressive chain 1..4 via playwright deps
```
Monday-clamp note: the CLI injects `PLAYWRIGHT_OCCURRENCE_DATE` (visible in `--dry-run`),
but the saga-dash journey specs DON'T read it yet — so a weekend run can still flake until
the spec-migration follow-up lands. Soak goal here is just: **does `e2e run` orchestrate
the stack + playwright end-to-end?** (the flake fix is verified separately once specs migrate).

connectv3 (M6) is dry-run only (no real suite yet):
```bash
ss e2e run connectv3/connect-smoke --dry-run
#   PASS: closure includes connect-web/connect-api/rtsm/sessions/content/iam (+programs/scheduling
#         via sessions events); EXCLUDES sis-api, ads-adm-api, saga-dash
```

---

## Phase 6 — Teardown ~2 min

```bash
ss stack down --mesh           # stop services + mesh
ss stack status                # PASS: all down
docker ps                      # PASS: no soa-* mesh containers
```

---

## Results scorecard (fill in)

| Phase | Check | PASS/FAIL | Notes / log captured |
|---|---|---|---|
| 0 | offline build/tests/dry-runs | | |
| 1 | up.sh + verify.sh baseline | | |
| 2 | native status/verify == verify.sh; wrappers | | |
| 3 | native --only boots (PINO/env wall) | | ← the big one |
| 4 | snapshot store→restore round-trip + guards | | ← the big one |
| 5 | e2e run orchestrates stack+playwright | | |
| 6 | clean teardown | | |

## If it breaks
- Service won't boot in Phase 3 → `/tmp/sds-synthetic/<svc>.log`; diff the env it got
  vs the `up.sh` `services_up` `launch_if <svc>` line (~up.sh 1373-1553). Likely a missing/
  wrong env var in `src/core/manifest/services.ts` `launch.env` or `core/launch-plan.ts`.
- Snapshot restore perm error → check the DB's `ownerRole` in `src/core/manifest/databases.ts`.
- Always fall back to the trusted `./up.sh` — the full-stack wrapper path is unchanged,
  so nothing here can corrupt your normal workflow beyond the marked [DESTRUCTIVE] steps.

## What a clean soak unlocks (the handoff, see 02-handoff-and-status.md)
Once Phases 3–5 pass repeatedly in daily use: flip the full-stack wrappers shell-out→native,
author the real per-SPA `flows.json` (saga-dash/qboard), migrate the journey specs to the
clamp, and retire mesh-fixture-cli + the `.sh` scripts.
