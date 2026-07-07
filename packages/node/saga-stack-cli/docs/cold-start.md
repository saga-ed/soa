# `ss stack cold-start` — the clean-slate baseline

`cold-start` returns the box to a **pristine, tutorial-ready** synthetic-dev state in one command.
Where **[`bootstrap`](./integration.md)** stands the stack up on main *non-destructively*
(clone-if-missing → overlay → up → verify), `cold-start` is the **sledgehammer**: it drops all
local mesh data, forces every repo back onto `main`, rebuilds from clean, scaffolds any missing
`.env`, and then brings the stack up and verifies it.

Reach for it before a **demo, a tutorial, or a "why is my stack weird" reset** — anytime you want
to be *certain* you're starting from the team's known-good baseline and not yesterday's leftovers.

> **Slot-0 only** (like `restart`): a cold start re-bases the *shared* baseline, so a `--slot > 0`
> is rejected. It always operates on the default `soa` mesh / `/tmp/sds-synthetic` state dir.

---

## The six phases

```bash
ss stack cold-start --dry-run     # preview every phase, change NOTHING
```

<details><summary>The plan: docker wipe → ensure repos → repos to main → clean build → ensure .env → up + verify</summary>

| # | Phase | What it does |
|---|---|---|
| 1 | **docker wipe** | Stops the slot's dev-server pids, then `docker compose … down -v --remove-orphans` on the `saga-mesh` project — removes the mesh **containers AND their volumes** (the postgres/mongo/rabbitmq/redis **data**). The everyday `down --mesh` preserves volumes; a cold start drops them so `up` re-provisions from nothing. `--all-docker` additionally runs `docker system prune -af --volumes` (host-global). |
| 2 | **ensure repos** | Clones any missing of the 7 required siblings (`soa, rostering, program-hub, saga-dash, student-data-system, qboard, rtsm`) — the same step as `bootstrap` (`--yes` to auto-clone non-interactively). |
| 3 | **repos → main** | For every **clean** repo: `git fetch`, `checkout` its default branch, `merge --ff-only` to origin. A repo with **uncommitted tracked changes is LEFT AS-IS** — never switched, never reset — and reported so you can commit/stash and re-run. |
| 4 | **clean build** | `rm -rf` each repo's `dist/` so prep's fresh-skip can't reuse stale output; the next phase's `up` then rebuilds. `--reinstall` also removes `node_modules` (forces a full `pnpm install` — slow). Skip entirely with `--skip-clean`. |
| 5 | **ensure .env** | Discovers every `.env.example` in the required repos and copies it to a sibling `.env` **where the `.env` is missing** (never overwrites an existing one). Prints what it scaffolded so you can review the values. |
| 6 | **up + verify** | `ss stack up --reset --seed <roster\|full>` (fresh mesh → provision → migrate → launch → seed) then `ss stack verify` — the same native path `bootstrap` ends on. |

</details>

---

## Everyday use

```bash
ss stack cold-start
```

<details><summary>Prompts once (it's destructive), then runs the scoped wipe + full bring-up</summary>

A plain run **prompts before it destroys anything** (the mesh DB volumes). Skip the prompt with
`--yes`; preview the whole thing with `--dry-run`. The scoped wipe only ever touches the saga
mesh's own compose project — your other docker projects are untouched unless you pass
`--all-docker`.

```
▶ cold-start plan:
    docker: down -v the 'soa' mesh (containers + volumes)
    repos:  7 siblings → clone-if-missing, switch to main, ff to origin
    build:  rm -rf dist → rebuilt by up
    env:    scaffold missing .env from .env.example
    up:     up --reset --seed roster → verify

  This DESTROYS local mesh data (DB volumes). Continue? [y/N]
```
</details>

```bash
ss stack cold-start --yes --all-docker --reinstall --seed full
```

<details><summary>The full nuke — non-interactive, prune all docker, reinstall deps, seed the full dataset</summary>

For a truly-from-zero rebuild (or a CI/agent context). `--all-docker` prunes every unused
container/network/image/volume on the host; `--reinstall` removes `node_modules` so the build
phase does a clean `pnpm install`; `--seed full` loads the full dataset instead of just the roster.
Expect this to take several minutes (reinstall + rebuild of every repo).
</details>

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Preview every phase; change nothing (no docker/git/fs/up). |
| `--yes` | Non-interactive: skip the destructive prompt **and** auto-clone missing repos. |
| `--all-docker` | Also `docker system prune -af --volumes` — removes **all** unused docker on the host. |
| `--reinstall` | Also `rm -rf node_modules` per repo (full `pnpm install`; slow). |
| `--skip-clean` | Skip the clean-build phase (leave existing `dist/`). |
| `--seed roster\|full` | Seed profile for the `up` phase (default `roster`). |

---

## Safety & limits (read before you rely on it)

- **Destructive by design.** Phase 1 deletes the mesh DB volumes. A plain run prompts; `--yes`
  and `--all-docker` are how you opt into the destruction. `--dry-run` is always safe.
- **Your uncommitted work is protected.** Phase 3 never switches or resets a repo with tracked
  local changes — it reports `skipped-dirty` and moves on. Commit/stash first if you want it on main.
- **`.env` scaffolding covers templates only.** Phase 5 can only copy a `.env.example` that a repo
  actually ships. A service whose `.env` is gitignored **with no committed example** (e.g. some
  `apps/node/*-api/.env`) is **not** created — those you still provision by hand the first time.
  The scaffolded values are the template's defaults; **review them** before a live demo.
- **Slot-0 only.** For an isolated per-slot reset, use `ss stack down --mesh --slot N` +
  `ss stack up --reset --slot N` instead.

See also **[getting-started.md](./getting-started.md)**, **[integration.md](./integration.md)**
(`bootstrap`), **[sub-stacks-and-bundles.md](./sub-stacks-and-bundles.md)**, and
**[verify.md](./verify.md)**.
