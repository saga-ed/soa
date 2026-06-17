---
purpose: First-run handoff for the synthetic-dev stack
audience: Adam (first time standing up + cross-developing sis-api ↔ saga-dash)
updated: 2026-06-02
---

# synthetic-dev — STATUS / first-run handoff

👋 Adam — this is the local **synthetic-dev** stack: a fully-dockerized,
six-service environment seeded with a **synthetic** roster (no PII, no VPN, no
prod fixture). It's set up so you can **cross-develop sis-api against saga-dash**
in the same in-flight state the rest of us run.

**Read `getting-started.md` for the full picture.** This file is just the
"you are here, do this first" version.

## First run — one command

```bash
cd ~/dev/soa/tools/synthetic-dev
./bootstrap.sh
```

`bootstrap.sh` does the whole onboarding path:
1. `refresh-suite.sh` — applies your **personal, gitignored** overlay
   (`integration-suite.local.tsv`) if you have one; otherwise a clean no-op and
   **every repo stays on `main`** (the default).
2. `up.sh up --reset --seed roster` — mesh + 6 services + a fresh synthetic roster.
3. `verify.sh` — asserts everything (see "What success looks like").

Then drop into the authenticated dashboard:

```bash
./up.sh --login            # mints a dev@saga.org session + opens a logged-in Chromium at :8900
```

## Prereqs (do these once, before `bootstrap.sh`)

- [ ] **Docker** daemon running.
- [ ] **Node 22+** and **pnpm**.
- [ ] **`gh` authenticated** — `gh auth status` (refresh-suite + verify resolve overlay PRs via `gh`; only needed if you overlay PRs).
- [ ] **CodeArtifact token** — run `pnpm co:login` in each repo (expires ~12h; a 401 on `pnpm install` means re-run it).
- [ ] **Five sibling repos cloned under `~/dev/`**: `soa`, `rostering`, `program-hub`, `saga-dash`, `student-data-system`. One successful `pnpm install` in each.

## What success looks like

`verify.sh` (run by `bootstrap.sh`, or any time) prints three groups and exits 0
only if **all green** — currently **15 checks**:

- `── service health ──` — iam(:3010) · sis(:3100) · programs(:3006) · scheduling(:3008) · ads-adm(:5005) · saga-dash(:8900), all → 200
- `── data ──` — iam roster seeded (`users=197`) · `sis_db` migrated
- `── source posture ──` — repos on the right branches (all `main` by default, or `local/integration` for any you've overlaid) **and** every overlaid PR actually merged in

If you see `✓ all 15 checks passed — stack is ready`, you're running clean main (plus any overlay you set).

## State model (updated 2026-06-10)

- **Default = `main` everywhere.** No overlay file ⇒ `refresh-suite.sh` is a
  no-op and every repo runs on `origin/main`. `./refresh-suite.sh --list` shows
  your overlay (empty by default).
- **Overlay (optional, per-dev):** copy `integration-suite.example.tsv` →
  `integration-suite.local.tsv` (gitignored) and list your in-flight PRs, or use
  `./refresh-suite.sh --prs <#s> <repo>` ad-hoc. Only the repos you overlay move
  to `local/integration`; the rest stay on `main`.
  - `up.sh`/`verify.sh` are overlay-aware and stay quiet about the correct
    posture. A `⚠` or posture failure means *real* drift (usually "re-run
    `./refresh-suite.sh`").
- **sis-api** is the sixth service (rostering `main`), on **:3100** against `sis_db`. It calls iam-api's `service.*` over S2S and works locally with no credentials (iam dev-bypass). See `decisions/d1.7`.
- **Heads-up:** Sean's stack may already be running on this machine. `bootstrap.sh` does a clean `--reset` restart, so it's safe to just run it — it'll give you a fresh roster (re-login after any `--reset`).

## If something's red

- `verify.sh` names the failing check. For a service, tail its log: `tail -f /tmp/sds-synthetic/<service>.log`.
- iam red → usually the `AUTH_*` secrets in `~/dev/rostering/.env.local`; `up.sh apply_fixes` writes a working template if absent.
- `pnpm install` 401 → `pnpm co:login` in that repo.
- Posture red (an overlaid PR "NOT in checkout") → `./refresh-suite.sh`.
- Anything not covered → the **Drift log** at the bottom of `README.md`.

## Steady-state loop (after the first run)

```bash
./up.sh --status              # quick health peek
./verify.sh                   # hard check (services + data + source posture)
./up.sh --reset --seed roster # fresh data, services stay up (re-login after)
./refresh-suite.sh            # re-apply your overlay after main moves (no-op if you have none)
./up.sh --down                # stop services (mesh stays up)
```

## For your Claude session

If you're driving this with Claude, point it at:
- **`getting-started.md`** — full onboarding + every verb.
- **`README.md`** — service map + the drift log (what `up.sh` patches around and why).
- **`decisions/d1.7`** (sis-api integration) and **`decisions/d1.8`** (pinned integration suite + the source-posture assertion — the shared-manifest half is now superseded by the per-dev local overlay + main-default; see `getting-started.md`).

— handoff from Sean's session, 2026-06-02
