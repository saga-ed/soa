# Multiple frontend versions against one stack — design

**Date:** 2026-07-15
**Package:** `packages/node/saga-stack-cli` (the `ss` CLI)
**Status:** approved design. Phase 2 of the two-phase effort (Phase 1 = slot-aware
`stack login --browser`, shipped in PR #311). Its own spec → plan → implementation cycle.

## Problem / goal

Run several **saga-dash frontend versions simultaneously against one backend
stack**, opened as tabs in one browser, to compare them under identical
data/login. Typical use: one backend (main services or a shared backend change)
with the existing frontend and a new-feature frontend side by side — including
when that backend runs on a non-0 slot.

Today the model couples `frontend ↔ slot ↔ backend`: the frontend port is
`f(slot)` (the `--port` seam at `stack-api.ts`), one frontend per slot, and its
backend wiring is `apps/web/dash/static/config.local.json` written into the single
saga-dash checkout by the `sync-dash-local-defaults` prelaunch hook. There is no
way to attach an *extra* frontend (from another checkout) to a running stack.

## Approach

**Reuse the existing launcher + prelaunch hook** (rejected alternative: a
standalone frontend launcher — duplicates launch/teardown logic). A variant is
another launch of the `saga-dash` service spec with three overrides:

- a distinct pidfile id `saga-dash@<label>` (so it is tracked/reaped independently),
- the variant's checkout as `cwd` (`<path>/apps/web/dash`),
- its own port (appended as `pnpm dev --port <port>`).

It reuses `LaunchSpec` (`{ id, cwd, command, args, env, healthUrl }`, fully
general), the `sync-dash-local-defaults` hook for backend wiring, pidfile
tracking, and `stack down`'s `<stateDir>/*.pid` reaping.

## Relationship to Phase 1 / per-slot model

Both new commands are **slot-aware** (default slot 0), reusing Phase 1's
machinery: `deriveInstance({slot})` for the target stack's `stateDir` and ports,
`profile.portOverrides['saga-dash']` for the slot's dash base port, and
`resolveIamUrl({slot})` for login. All per-variant state lives under the target
slot's `stateDir` (`/tmp/sds-synthetic-s<S>`), so variants, their registry, and
their compare-browser profile are isolated per slot exactly as Phase 1 isolates
each stack. `stack down --slot S` already reaps that slot's pidfiles.

## Commands (two — the "minimal lifecycle" choice)

### `ss frontend up <label>=<path> [--port N] [--slot S]`

Launch an extra saga-dash from `<path>` against the stack at slot `S` (default 0):

1. Resolve the target: `profile = deriveInstance({slot: S})`, `stateDir =
   profile.stateDir`, `dashBase = profile.portOverrides['saga-dash']`.
2. Choose the port: `--port` if given, else auto-assign (below).
3. Run `sync-dash-local-defaults` in `<path>` for slot `S`. At slot 0 this
   *removes* the variant checkout's `config.local.json` (→ base-port backend); at
   slot > 0 it *writes* the offset-port config (`stackSlotConfigContents` over the
   slot's `portOverrides`). Every variant at slot `S` thus points at that one
   backend.
4. Launch via the real launcher: id `saga-dash@<label>`, `cwd
   <path>/apps/web/dash`, `pnpm dev --port <port>`, the manifest's saga-dash
   launch env, `healthUrl http://localhost:<port>/`. Pidfile → `<stateDir>/saga-dash@<label>.pid`.
5. Record the variant in the per-slot registry (below).

### `ss frontend browser [<label>[,<label2>…]] [--slot S]`

Open the slot-`S` frontends in one browser (default slot 0):

- With no labels: all currently-running variants at slot `S`. With labels: those
  variants (each must be registered at slot `S`). The literal label `primary` is
  always resolvable — it maps to the stack's own dash at `dashBase`.
- **Single-slot invariant:** every requested tab must be at slot `S` (one backend
  ⇒ one iam ⇒ one login ⇒ one profile). Requesting a label registered at another
  slot is an error directing the user to a separate `--slot` invocation.
- Opens ONE `launchPersistentContext` on a dedicated per-slot profile
  `<stateDir>/frontend-browser-profile` (distinct from `stack login --browser`'s
  `<stateDir>/browser-profile` to avoid Chrome's singleton lock), does a single
  `devLogin` against `resolveIamUrl({slot: S})`, then opens one tab per resolved
  URL. Cookies key on the `localhost` domain (not port), so one login covers every
  tab.

## Internal registry (not a user command)

`ss frontend up` writes/updates `<stateDir>/frontends.json`: a map
`label → { path, port, pid, slot }`. `ss frontend browser` reads it to resolve
labels → `http://localhost:<port>` URLs. `stack down` clears it after reaping the
pids. This is the minimum state needed for `browser <label>` to work; there is no
user-facing `list`/`down` (the "minimal lifecycle" choice) — teardown is
`stack down` or Ctrl-C on a foreground `frontend up`.

## Port auto-assignment

When `--port` is omitted: scan upward from `dashBase + 1` for the first port that
is (a) not bound and (b) not already claimed by any resolved slot service port
(cross-checked against `deriveInstance` for all slots), and (c) within slot `S`'s
1000-stride band. Cap at 9 variants per slot (well beyond real use). `--port`
overrides and is validated as free before binding.

## Teardown

`ss stack down [--slot S]` reaps `saga-dash@<label>` pidfiles like any service
(it enumerates `<stateDir>/*.pid`) and clears `frontends.json`. A foreground
`frontend up` also stops on Ctrl-C. No per-variant `down`/`list`.

## Browser mechanism (extend the vendored helper)

Extend `vendor/browser-login.mjs` to accept **multiple** dash URLs (e.g. a
`DASH_URLS` comma-separated env): `devLogin` once, then open one tab per URL. The
existing single-`DASH_URL` path stays byte-identical (Phase 1 unaffected). The
`openVendoredBrowser` seam gains a multi-URL entry used by `frontend browser`;
`stack login --browser` keeps calling the single-URL path.

## Constraints / edge cases

- **Distinct checkouts.** Refuse/warn if a label's `<path>` equals the primary
  saga-dash checkout or another running variant's path — same checkout twice is
  the same version and shares one `config.local.json`.
- **Duplicate label / occupied port.** Refuse a label already registered at that
  slot; refuse an explicit `--port` that is bound.
- **Cross-slot browser request.** Error (with guidance) if a `frontend browser`
  invocation mixes labels from different slots.
- **Transcripts at slot > 0.** Same known property as Phase 1: at slot > 0 the
  variant's `config.local.json` points transcripts at an offset port with nothing
  listening, so an attendance/transcripts *write* fails loud. Not surfaced (parity
  with Phase 1's silent choice).
- **Health window.** Reuse the launcher's existing cold-`pnpm dev` health poll.

## Testing

Through the existing injectable launcher / prober / spawn / fs seams — no real
vite or browser:

- Port allocator: free-port scan, band cap, skip of resolved slot ports.
- Registry: read/write/clear round-trip; per-slot path.
- Variant `LaunchSpec`: id `saga-dash@<label>`, `cwd`, `pnpm dev --port <port>`
  args, env, `healthUrl`; prelaunch hook invoked in the variant checkout for the
  target slot.
- `frontend browser`: resolves labels (+ `primary`) → URLs, enforces the
  single-slot invariant, passes the multi-URL env + one devLogin, uses the
  per-slot `frontend-browser-profile`.
- `stack down` reaps `saga-dash@<label>` pids and clears `frontends.json`.
- Multi-URL `browser-login.mjs`: single-URL path unchanged; multi-URL opens a tab
  per URL after one devLogin.

## Out of scope

- Managing git worktrees/branches for the user (they supply checkout paths).
- Named/persisted variant configs (ad-hoc per invocation).
- Per-variant `list`/`down` commands.
- Non-saga-dash frontends (coach-web/connect-web) — the design generalises later
  but this cycle targets saga-dash.

## Development / testing note

The global `ss` runs the **main** `soa` checkout's saga-stack-cli, so worktree
edits are invisible to `ss` until merged. Develop in the worktree and test via the
worktree's own `bin/dev.js` (zero-build, runs from `src/`) or `bin/run.js` (after
`pnpm build`), plus the vitest suite.
