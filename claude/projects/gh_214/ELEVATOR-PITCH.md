# saga-stack-cli — one CLI for the whole synthetic-dev stack

**`ss` (saga-stack) replaces ~2300 lines of `up.sh` + `verify.sh` + `tunnel.sh` + `refresh-suite.sh` + `bootstrap.sh`, the saga-dash e2e shell glue, and the stale `mesh-fixture-cli` — all scattered across ~8 repos — with a single typed, tested, tab-completable CLI.** Everything is driven by one frozen SERVICE MANIFEST (ports, `dependsOn` graph, launch env, DBs, seed steps) as the single source of truth, so behavior lives in data you can read, not in env-vars and branchy bash you have to reverse-engineer. Bring up exactly the services you need, seed them, verify them, snapshot them, and run e2e journeys — all from `ss`.

## From this → to this

| Yesterday (distributed bash) | Today (`ss`, manifest-driven) |
| --- | --- |
| 2300+ lines of `up.sh`/`verify.sh`/`tunnel.sh` across ~8 repos | one OCLIF CLI over a shared, unit-tested core |
| Boot all ~13 services or hand-hack the script | `--only a,b` boots the minimal dependency closure |
| Remember undocumented bash flags and env-vars | `--help`, tab-completion, `--output-json`/`--porcelain` |
| Hardcoded `check-e2e.sh` pipeline per scenario | e2e scenarios are DATA in `flows.json` |
| Re-run the slow deterministic `db:seed` to get a clean DB | restore a snapshot fixture in seconds |
| A missing sibling repo reddens the whole stack | skip-if-absent warns and keeps going |

## Highlights

- **`ss stack …` — the whole lifecycle, one discoverable surface.** `up` / `down` / `status` / `verify` / `reset` / `seed` / `snapshot` / `overlay` / `tunnel` / `bootstrap`, each typed and tested with real `--help` and machine-readable `--output-json` / `--porcelain`. No more grepping a shell script to learn what a flag does.
- **Dependency-aware sub-stacks (N-of-M).** `ss stack up --only scheduling-api,sessions-api` walks the manifest graph, computes the minimal dependency *closure*, and boots just those services plus what they need — not all ~13. Test two services without paying for the whole stack.
- **Bundles — common shapes in one word.** `--with dash|connect|coach|playback` expand to a set of `--only` includes: sugar over the closure that stays composable, so the shapes you spin up every day are a single token.
- **`ss e2e …` + externalized `flows.json` — scenarios as data, not bash.** `ss e2e run saga-dash/journey --through attendance` resolves the flow, computes just the stack it needs, seeds it, and runs Playwright. Onboarding a new SPA or scenario is a registry row plus a `flows.json` entry — progressive multi-stage journeys, prerequisites, foreground/AV markers — with ZERO new orchestration code, versus editing the old hardcoded `check-e2e.sh` pipeline.
- **Snapshots — known-good DB state in seconds.** `ss stack snapshot store|list|restore` captures `pg_dump`/`mongodump` fixtures with a schema-ahead guard and restore-as-owner, so you reset to a clean state instantly instead of re-running the slow deterministic `db:seed`.
- **Slots — multiple stacks on one box (designed-in).** `--slot` gives project-keyed volumes and ports so several devs — or parallel agents — run concurrent stacks on one machine without clobbering each other.
- **Robustness the bash never had.** Skip-if-repo-absent (a missing sibling repo warns instead of reddening the stack), manifest-faithful launch env, native health probes that cover endpoints the hand-maintained `verify.sh` missed, and a Monday-flake date clamp — all backed by 370+ unit tests and adversarial multi-agent verification.
- **Non-destructive landing.** It's purely additive: the bash scripts stay in place, nothing is force-migrated, and you adopt `ss` one command at a time.

**Stop memorizing bash. Describe the stack once, and let `ss` bring up exactly what you need.**
