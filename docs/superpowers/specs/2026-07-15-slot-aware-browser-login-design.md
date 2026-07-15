# Slot-aware `stack login --browser` — design

**Date:** 2026-07-15
**Package:** `packages/node/saga-stack-cli` (the `ss` CLI)
**Status:** approved design; Phase 1 of a two-phase effort (Phase 2 = multi-frontend-per-stack, specced separately).

## Problem

`ss stack login --browser` (and the `up --login` browser step) is hard-locked to
slot 0. On any `--slot > 0` the command refuses to open a headful Chromium:

```
src/commands/stack/login.ts:69   if (flags.browser && flags.slot > 0) this.error(...)
src/commands/stack/up.ts:582      if (flags.slot === 0) { await this.openVendoredBrowser(...) }
```

The stated rationale — *"browser-login.mjs opens against slot 0's dash (:8900),
profile under /tmp/sds-synthetic; it is not slot-parameterised"* — is now largely
stale. The goal: run two backend stacks on two slots and open two independent,
logged-in browsers, one per stack, with **no cookie collision** between the two
logins (they talk to two different iam instances).

## Why this is a small change (current state)

The headful-browser machinery is already almost entirely slot-parameterised:

- **The vendored script is fully env-driven.** `vendor/browser-login.mjs:32-35`
  reads `IAM_URL`, `DASH_URL`, `LOGIN_EMAIL`, `PROFILE_DIR` from the environment and
  launches via `chromium.launchPersistentContext(PROFILE, …)`. A distinct
  `PROFILE_DIR` is a separate on-disk user-data dir = a fully isolated browser
  (independent cookie store).
- **`openVendoredBrowser` already passes slot-correct `iamUrl` and `PROFILE_DIR`.**
  `base-command.ts:1002-1010`: `iamUrl` comes from `resolveIamUrl({ slot })`
  (`http://localhost:${3010 + slot*1000}`, `core/login.ts:50-55`); `PROFILE_DIR` is
  `<stateDir>/browser-profile` where `stateDir` is `/tmp/sds-synthetic-s<N>` per slot.
- **The seam already accepts a `dashUrl` override.** `base-command.ts:979,1006` —
  `ctx.dashUrl ?? (LOGIN_DASH_URL || 'http://localhost:8900')`. The e2e `--hold`
  path already uses it to open a slot's own dash.
- **The slot's dash is actually listening at its offset port.** At `slot > 0`,
  `stack-api.ts:891-892` appends `--port <base+offset>` for any `isFrontend`
  service, so `saga-dash` runs on `8900 + slot*1000` (soa#271 made frontends
  slottable). The `shared-flags.ts:122-126` comment claiming frontends "stay on
  slot 0 / are excluded" is **stale** and predates soa#271; `derive-instance.ts`
  is authoritative.

The **only** value not wired for `slot > 0` is `DASH_URL`, which defaults to
`:8900`. Everything else — including the collision-free per-slot profile — is
already in place.

### Why cookies (and all other state) don't collide

Each slot's browser is a **separate persistent browser instance**, not a shared
browser pointed at different URLs. `browser-login.mjs` opens via
`chromium.launchPersistentContext(PROFILE_DIR, …)` (`vendor/browser-login.mjs:53`),
which binds the browser to an on-disk user-data dir. Each slot already resolves a
distinct `PROFILE_DIR` — `/tmp/sds-synthetic-s1/browser-profile` vs `-s2`
(`base-command.ts:1008`, `<stateDir>/browser-profile` with a per-slot `stateDir`).

Two slots therefore launch **two separate browser processes with two separate
on-disk profiles**: no shared cookies, localStorage, IndexedDB, cache, or service
workers. The isolation is structural (separate user-data dirs), independent of the
URLs differing; two different dirs also avoid Chrome's singleton-lock conflict, so
they run fully in parallel. This already exists — the change only lets `slot > 0`
reach the browser-open path that uses it.

(Aside, not the mechanism: browser cookies key on **domain, not port**, so two
localhost dashes on different ports would share a cookie store *within one
profile*. That is precisely why isolation relies on separate profiles, not on the
ports being different.)

## Design (Phase 1)

Single production file changed: `src/commands/stack/login.ts`.

1. **Remove the guard.** Delete the `flags.browser && flags.slot > 0` refusal
   (`login.ts:66-74`).
2. **Compute the slot's dash URL** from the already-derived `profile`:
   `profile.portOverrides['saga-dash']` → `http://localhost:<8900 + slot*1000>`.
   (`'saga-dash'` is the manifest service id, base port 8900.)
3. **Pass it as `ctx.dashUrl`** into the existing call
   `this.openVendoredBrowser(flags, { email, iamUrl, stateDir, dashUrl })`
   (`login.ts:119`).

`iamUrl` (from `res.iamUrl`, already offset) and `PROFILE_DIR` (slot `stateDir`)
need no change.

### Precedence

The computed slot URL is what we pass as `ctx.dashUrl`. `LOGIN_DASH_URL` remains
the explicit override for the tunnel/manual case. To keep the tunnel path
byte-identical, ordering is: **`LOGIN_DASH_URL` (when set) wins**, else the
computed slot dash URL, else `:8900`. Concretely, `login.ts` passes
`dashUrl = process.env.LOGIN_DASH_URL || slotDashUrl`, and `openVendoredBrowser`'s
existing `ctx.dashUrl ?? …` fallback is preserved.

### Decision: profile isolation relies on the per-slot state dir

The browser profile stays `<stateDir>/browser-profile` (no per-slot suffix).
Isolation between slots comes from `stateDir` itself being per-slot
(`/tmp/sds-synthetic-s<N>`) — the *same* mechanism that already isolates each
stack's pid ledger (`<id>.pid`) and cookie jar (`cookies.txt`). `--state-dir` is
the whole-stack bookkeeping/identity root, not a browser-only knob, so two slots
sharing one `stateDir` is already an unsupported "don't do that" that breaks
loudly elsewhere (a shared pid ledger means `down` on one slot reaps the other;
a shared jar means the two `cookies.txt` writes clobber). Suffixing only the
browser profile would band-aid one symptom of that deeper rule while implying the
profile needs protection the jar/pids don't get. So we do **not** special-case the
profile; distinct default `stateDir`s already guarantee two fully separate
persistent browser instances (considered and rejected: a `browser-profile-s<N>`
suffix; a stateDir-collision guard — the latter is a possible future hardening,
out of scope here).

### Explicitly out of scope (Phase 1)

- **No `up.ts` change.** Browser-opening stays exclusive to the explicit
  `stack login --browser`. `up --login` keeps today's behavior (opens at slot 0,
  skips at slot > 0).
- **No transcripts warning.** Opening a `slot > 0` browser is silent. (Known
  property: `transcripts-api` is excluded at `slot > 0`, so the slot's
  `config.local.json` points transcripts at an offset port with nothing
  listening — an attendance/transcripts **write** fails loud by design,
  `dash-defaults.ts:61-72`. Understood and accepted; not surfaced.)

### Housekeeping

- Correct the stale `shared-flags.ts:122-126` comment so it no longer claims
  browser frontends stay on / are excluded from slot 0.

## Testing

Exercised through the existing injectable browser/vendor seams — **no real
Chromium**:

- `src/commands/stack/__tests__/login-native.int.test.ts`: add a case asserting
  `stack login --slot 1 --browser` invokes the vendored browser with
  `DASH_URL=http://localhost:9900`, `IAM_URL=http://localhost:4010`, and a
  `PROFILE_DIR` under `/tmp/sds-synthetic-s1`.
- `src/commands/stack/__tests__/slot-guard.unit.test.ts`: invert/remove the case
  that asserted `--browser --slot > 0` errors.
- Preserve a case proving `LOGIN_DASH_URL` still overrides the computed slot URL.

## Outcome

```
ss stack up    --slot 1        ss stack up    --slot 2
ss stack login --slot 1 --browser   ss stack login --slot 2 --browser
```

Two Chromiums with profiles `/tmp/sds-synthetic-s1/browser-profile` vs `-s2`,
logged into iam `:4010` vs `:5010`, pointed at dash `:9900` vs `:10900`. No
cookie collision (separate persistent profiles).

## Development / testing note

The global `ss` binary runs the **main** `soa` checkout's saga-stack-cli, so
worktree edits are invisible to `ss` until merged. Develop in the worktree and
test via the worktree's own `bin/run.js` (and the vitest suite) until merged.

## Phase 2 (separate design pass) — multi-frontend per stack

Not specced here. Summary of the problem for continuity: the current model
couples `frontend instance ↔ slot ↔ backend` — frontend port is `f(slot)`, and
frontend→backend wiring is `apps/web/dash/static/config.local.json` written into
the saga-dash checkout (`dash-defaults.ts`), one file per checkout. Running N
saga-dash versions against one backend needs a "frontend variant" abstraction
(repo checkout + port + target backend) decoupled from the slot, plus lifecycle
handling (`down`/`status`/`restart` assume one frontend per slot; the wrapper
lifecycle uses broad `pkill -f tsup`/`nuke_vite` that would clobber siblings).
This gets its own spec → plan → implementation cycle.
