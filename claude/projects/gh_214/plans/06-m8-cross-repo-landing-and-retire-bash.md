# M8 — cross-repo landing + native-by-default (NON-DESTRUCTIVE) (capstone) (#214)

> The landing milestone: make saga-stack-cli a fully-functional ADDITIVE entrypoint —
> land the pieces that live in OTHER repos, and flip the CLI's OWN wrappers from
> shell-out to native. The bash scripts + mesh-fixture-cli are LEFT IN PLACE
> (non-destructive — skelly's directive); no forced developer transition. Ships as part of this effort, **after the
> soak** (`03-soak-plan.md`). Promotes the `02-handoff-and-status.md` remainder into
> a formal, phased, testable plan.

## Preconditions (hard gates)

1. **Soak passed** — `03-soak-plan.md` Phases 3–5 green **repeatedly in daily use**
   (native `stack up --only`, snapshot round-trip, `e2e run`). M8 flips defaults to
   native; do not start until the native paths are trusted.
2. **Infra volume fix landed** (from M7 §"shared infra fix"): `Makefile
   COMPOSE_PROJECT_NAME ?=` + project-keyed volumes. (Shared with M7; land once.)
3. M4/M5/M6 code merged on `gh_214`; M7 may land before or in parallel (independent).

## Scope — five workstreams

### A. Author the real per-SPA `flows.json` (cross-repo)
Promote the bundled examples into the SPA repos so discovery finds them.
- **saga-dash PR** (`apps/web/dash/e2e/flows.json`): the `journey` (8 stages) +
  `connect-session` flows, from `examples/flows/saga-dash.flows.json`. Verify the
  `stage-N-*` projects/specs match the real `playwright.stack.config.ts`.
- **qboard PR** (`apps/web/connectv3/e2e/flows.json`): the connectv3 `connect-smoke`
  flow from `examples/flows/connectv3.flows.json` (once a real connectv3 e2e spec exists).
- Update `spa-registry` to prefer the repo file over the bundled fallback (the
  fallback stays as the authoring template + test fixture).
- **DoD:** `e2e run saga-dash/journey` and `connectv3/connect-smoke` resolve from the
  repo files, not the bundled examples.

### B. Monday-flake fix end-to-end (cross-repo)
The CLI already injects a clamped `PLAYWRIGHT_OCCURRENCE_DATE` (M5) but the specs
ignore it. Make it effective.
- **Extract `@saga-ed/saga-stack-e2e-kit`** — a new `soa/packages/node/*` package
  exporting the clamp helpers (`todayOrNextWeekday`/`mondayOfWeekOf`/`occurrenceDate`/
  `fmtLocal`) that `core/flow/env.ts` already contains (move/re-export; keep the CLI
  using the same source).
- **saga-dash PR** — migrate `journey/{schedule,sessions,attendance}.e2e.test.ts` to
  env-first: `process.env.PLAYWRIGHT_OCCURRENCE_DATE ?? occurrenceDate(new Date())`,
  importing the kit; delete the per-spec unclamped `mondayOfCurrentWeek` copies.
- **DoD:** a Sat/Sun `e2e run` no longer flakes (occurrence date = next Monday); the
  flake cannot regress per-spec (env is authoritative, helper is shared).

### C. Port remaining up.sh internals → flip wrappers native (per-command, post-soak)
Each wrapper (M1/M2) flips shell-out → native ONLY after its own soak; bash stays
callable as the fallback until C is complete.
- `mesh_up` → finish the data-driven readiness port (M4 has a minimal version).
- `prep`/migrate → native migrate runner over the closure's DBs (incl. iam-pii-db
  `db push` step order; program-hub `db:deploy` url-override).
- `reset_data` → native truncate + the `ledger_local` `migrate-reset` (decision
  2026-06-30) + mongo drop.
- seed-family → native SeedStep runner executing composed `SeedPlan`s (M5 composes;
  runner executes offline-then-online).
- `overlay`/`tunnel`/`bootstrap` → native ports (git overlay, frp/moniker, provision).
- **Method (per command):** build native → run dual (native + bash) and diff outputs
  → flip the default to native → keep a `--legacy`/bash escape for one release → remove.
- **OUT OF SCOPE — gated opt-in non-defaults (skelly, 2026-07-01):** do NOT re-implement
  up.sh's opt-in gates as bespoke native flags — `--with-playback` (transcripts/insights/
  chat), `--record` (fleek recording), the connect/AV-behind-a-gate. The **sub-stack
  closure** (`--only`, N-of-M) already stands up any subset, so the gates are redundant:
  you just `--only <those services>`. See memory `cli-gated-nondefaults-foreground-constraint`.
- **The one constraint kept:** never run a service/flow that REQUIRES foreground
  (interactive / AV / held-open, e.g. connect-session `foreground: true`) in the
  background/detached — guard `foreground` flows in the `e2e run` model (refuse or force
  foreground). This is the real invariant the gates were protecting. (Unconditional
  DEFAULT services like coach-api/coach-web are still modeled for parity — different thing.)
- **DoD:** full-stack `stack up`, `reset`, `seed`, `verify`, `overlay`, `tunnel`,
  `bootstrap` all run native by default; bash no longer invoked on the happy path; the
  foreground-not-in-background guard is enforced; opt-in gates left to `--only`.

### D. Deprecate mesh-fixture-cli (coexist — do NOT delete out from under anyone)
- Deprecate: README notice + a runtime hint pointing at `stack snapshot`/`stack seed`;
  stop referencing it in our tooling.
- **LEAVE the package in place** so any existing user/script keeps working. Remove it
  only later, if/when provably unused AND the owner signs off — never as a forced step.
- **DoD:** snapshot/seed fully available on saga-stack-cli; mesh-fixture-cli marked
  deprecated but still functional.

### E. Coexist with the `.sh` scripts (NON-DESTRUCTIVE — do NOT retire/delete)
> **Directive (skelly, 2026-07-01):** the CLI lands purely ADDITIVE. The bash scripts
> stay in place and working; developers are NOT forced to transition — they move on
> their own. See memory `saga-stack-cli-non-destructive-landing`.
- **Do NOT** convert the `.sh` scripts to shims or delete them. `up.sh`/`verify.sh`/
  `refresh-suite.sh`/`tunnel.sh`/`bootstrap.sh` + the saga-dash e2e `.sh` remain the
  supported bash path indefinitely.
- The CLI flips its OWN defaults to native (§C) after soak, but keeps a bash escape and
  never touches the scripts themselves.
- Update `synthetic-dev/README.md` to document BOTH entrypoints (bash + `ss`), noting the
  CLI as the recommended-but-optional path.
- **DoD:** the CLI is a fully-functional alternative entrypoint; the `.sh` scripts are
  untouched and still work; **no developer is forced to switch.**

## Phasing (each independently shippable, low→high risk)

1. **M8.0** — infra volume fix (if not already via M7) + `spa-registry` repo-file preference.
2. **M8.A** — saga-dash `flows.json` PR (safe; CLI already resolves it).
3. **M8.B** — e2e-kit extraction + saga-dash spec migration (fixes the flake for real).
4. **M8.C** — native internals + wrapper flips, ONE command at a time, each post-soak,
   bash fallback retained.
5. **M8.D** — deprecate mesh-fixture-cli (leave it in place; don't delete).
6. **M8.E** — coexist: CLI defaults flip native (post-soak) but the `.sh` scripts stay in place and working (NON-DESTRUCTIVE, skelly's directive). Capstone.

## Risks
- **Double-maintenance window (C):** up.sh + native co-exist while porting — pin
  behavior with the M1 golden parity tests + per-command dual-run diffs; land each
  flip fast; freeze bash feature work.
- **Cross-repo coordination (A/B):** saga-dash + qboard PRs on their own branches/reviews.
- **Non-destructive landing (D/E):** the `.sh` scripts are NOT deleted or shimmed — the CLI coexists as an additive entrypoint (skelly's directive), so there's no forced transition and nothing to break for existing bash users.
- **Premature flip:** never flip a wrapper's default to native before its soak — the
  whole M8 gate.

## Definition of done (M8 / the effort)
CLI is a fully-functional additive entrypoint; `.sh` scripts LEFT IN PLACE (non-destructive) + mesh-fixture-cli deprecated-not-deleted; saga-dash + connectv3
have real `flows.json`; the Monday clamp is effective; multi-instance (M7) available; the bash scripts + mesh-fixture-cli LEFT IN PLACE and working (non-destructive). Issue #214 closable.

## Cross-references
`01` plan of record · `02` handoff (this promotes its remainder) · `03` soak (the
gate) · `04` M7 (shares the infra fix) · `05` M5 follow-up (AV/guard).
