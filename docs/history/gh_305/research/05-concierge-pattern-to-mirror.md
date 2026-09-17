# 05 — The `ss e2e connect` concierge contract to mirror for `develop coach`

**Research area:** Extract the reusable concierge contract from the existing
`e2e connect` command so a new `develop` topic + `develop coach` (and later
`develop saga-dash`/`ads`/`sis`) mirror it as a *small* addition, and specify the
oclif mechanics for the new topic + the deprecating `e2e connect` alias.

**Scope note:** This doc is about the *CLI plumbing / concierge contract*. It is
evidence-based against the code in
`packages/node/saga-stack-cli` (worktree `gh305-ss-develop`) and the real
`coach` repo. What exists today vs. what must be added is called out explicitly.

All paths below are absolute or repo-relative to
`/home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli`
(the `ss` CLI package). Line numbers are as of this research.

---

## Headline

`e2e connect` is already a thin, opinionated concierge over a **pure flow
resolver** (`resolveFlow`) + a **generic in-process executor**
(`executeResolvedFlow`) that does closure → up → reset+seed → verify → foreground
Playwright, recursing a headless prerequisite. Almost all of that is reusable
verbatim. `develop coach` is mostly **data** (a `coach-web` registry row +
coach's already-authored `flows.json`) plus a **thin command file** that picks the
flow and the hand-off style. The one genuinely connect-specific/saga-dash-specific
piece is the **hand-off**: connect holds the TTY via an interactive Playwright
spec (`page.pause()`), and the alternative `--hold` browser opener
(`openVendoredBrowser`) is hardwired to saga-dash's dash app — coach needs its own
hand-off decision (see §6, the main open question).

---

## 1. The concierge contract `e2e connect` implements (step by step)

`src/commands/e2e/connect.ts` (241 lines). Its `run()` is the template. In order:

1. **Parse + separate passthrough** (`connect.ts:114-115`). `static strict = false`
   allows trailing args after `--`; it filters the flow token out of `argv` to get
   `passthrough` (handed only to the terminal Playwright stage, never the
   prerequisite).
2. **Validate mutually-exclusive flags manually** (`connect.ts:121-128`) — NOT via
   oclif `exclusive:`, because oclif treats a *defaulted* value as "provided" (the
   "M14 lesson", commented at `connect.ts:119-120`). `--refresh-snapshot` rejects
   `--reuse` and requires `--prereq-from-snapshot`.
3. **Discover the flow manifest** (`connect.ts:130-135`) via
   `discoverFlowManifest(SPA_ID, flags, process.env)`
   (`e2e-orchestrate.ts:132-161`). Resolution order: `--spa-path` →
   `$SAGA_E2E_SPA_PATHS` → registry repo path (`$<repoEnvVar> ?? $DEV/<sub>` +
   `e2eDir/flows.json`) → **bundled example** fallback (only for ids in
   `BUNDLED_EXAMPLE`, `e2e-orchestrate.ts:84-93`). Warns when it fell back to the
   bundled example.
4. **Resolve the flow (PURE)** (`connect.ts:139`) via
   `resolveFlow(manifest, FLOW_NAME, { lane: 'stack' })`
   (`src/core/flow/resolve.ts:191`). This produces a `ResolvedFlow`: selected
   stages, `requiredSystems ∪ {spa.system, iam-api}`, the full dependency
   `closure` (N-of-M), effective seed selection, `reset` boolean, `foreground`,
   the Playwright invocation, and a **recursively-resolved `prerequisite`** forced
   headless (`resolve.ts:303-320`). Prerequisite ⇒ main flow runs `reset:false`
   (`resolve.ts:326`) because the prerequisite owns the reset+seed.
5. **Apply `--reuse`** (`connect.ts:140`): strip the prerequisite entirely
   (`{ ...resolved, prerequisite: undefined }`) so nothing rebuilds/resets — run
   against current stack state.
6. **Pin per-run stage env** (`connect.ts:145-153`): `--fake-media` ⇒
   `FAKE_MEDIA=1`, `--student-login N` ⇒ `CONNECT_LOCAL_STUDENTS=N`, merged into
   `base.flow.env` so it reaches only the headed stage (not the headless
   prerequisite — a separate `ResolvedFlow`). This is the generic "inject env for
   this flow's stages" hook (`flow.env` is merged last by `computeEnv`).
7. **Resolve the Playwright cwd** (`connect.ts:155`) via
   `resolveAppCwd(resolved.spa, flags, process.env)`
   (`e2e-orchestrate.ts:332-335`) → `<repoRoot>/<spa.appDir>` (matches
   `run-stack-e2e.sh`'s `cd $DASH`).
8. **Assemble the injectable seams** (`connect.ts:158-165`): `launcher`,
   `meshExec`, `portProbe`, `dashFs`, `prober`, `runner` — each a
   `BaseCommand.getX()` seam. Plus a `delegate` closure wiring reset/login back
   through `this.runScript` (`connect.ts:166-167`).
9. **Resolve `--tunnel`** (`connect.ts:174-179`): resolve
   `<moniker>.<VMS_BASE>` from the vendored `tunnel.sh` (same machinery as
   `stack up --tunnel`). Note: it ONLY repoints the Playwright browsers' URLs; it
   does not relaunch the stack.
10. **Build the runtime + StackApi** (`connect.ts:181-182`):
    `buildStackContext(flags, seams, delegate, undefined, tunnelDomain)`
    (`e2e-orchestrate.ts:227`) → `makeStackApi(serviceManifest, runtime)`
    (`src/stack-api.ts`). This is the six-method facade (`up/reset/seed/verify` +
    login/browser).
11. **Build the checkpoint store** (`connect.ts:188-191`) only if there is a
    prerequisite AND `--prereq-from-snapshot`/`--refresh-snapshot` — the M14-C
    accelerant that restores the prerequisite's terminal checkpoint instead of
    replaying it.
12. **(Optional) `--refresh-snapshot` bake** (`connect.ts:198-222`): a headless
    full replay of the prerequisite through its terminal stage with
    `--snapshot-stages` to bake fresh checkpoints, before opening the room.
13. **Execute** (`connect.ts:224-239`) via `executeResolvedFlow(toRun, deps, opts)`
    (`e2e-orchestrate.ts:858`). The executor **owns everything**:
    - recurse the prerequisite headless (skip-reset false, no passthrough), or
      restore its checkpoint (`e2e-orchestrate.ts:884-944`);
    - `api.up(closure)` (`:960`), honoring repo-absent skips
      (`:971-973`, the "#221 coach-deferral" pattern);
    - reset + seed (coupled) unless `skipReset` / prerequisite built the state
      (`:984-1017`); additive-seed branch for prereq-built + declared seed;
    - `api.verify(probes, { tolerate: [spa.system] })` (`:1028-1033`) — tolerate
      the SPA's own frontend being red (branch posture / dev server);
    - spawn Playwright **foreground, stdio inherited** (`:1060-1071`): `pnpm exec
      playwright test --config … --project <terminal> [--headed] [passthrough]`.
      Foreground flows are `--headed`; the TTY is held by the spec's own
      `page.pause()` (connect's AV hold).
    - Returns the Playwright exit code; a failed up/reset/seed/verify throws
      `FlowExecError` (`connect.ts:236-238` surfaces it via `this.error`).

**The contract, distilled:** a concierge subcommand is
`parse → discover flow → resolveFlow → (reuse strip / env pin) → resolveAppCwd →
seams → buildStackContext → makeStackApi → executeResolvedFlow`. Everything except
step "which SPA + which flow + which hand-off" is shared machinery.

---

## 2. `e2e connect`'s flags (what to preserve on `develop connect`)

From `connect.ts:74-111` (all spread `...BaseCommand.baseFlags` first):

| Flag | Default | Effect |
|---|---|---|
| `--reuse` | false | strip prerequisite rebuild + reset; run against current stack state (`connect.ts:140`, `skipReset` at `:231`) |
| `--prereq-from-snapshot` | true (`allowNo`) | M14-C: restore the `journey@schedule` checkpoint instead of replaying it; falls back to replay when absent |
| `--refresh-snapshot` | false | bake the prerequisite checkpoints fresh (headless replay, `--snapshot-stages`) before opening; needs `--prereq-from-snapshot`; XOR `--reuse` |
| `--spa-path` | — | explicit `flows.json` path (highest-priority discovery override) |
| `--fake-media` | false | `FAKE_MEDIA=1` on the headed stage (synthetic cam/mic) |
| `--tunnel` | false | point THIS run's browsers at the vms tunnel hosts (requires prior `ss stack up --tunnel`) |
| `--student-login <0-2>` | 2 | how many students log in locally (`CONNECT_LOCAL_STUDENTS`) |
| plus `...BaseCommand.baseFlags` | — | `--porcelain`, `--slot`, `--output-json`, `--set`, `--dev`, `--state-dir`, and per-repo `--<repo>` pins (`src/shared-flags.ts:111-160`) |

`--fake-media`, `--tunnel`, `--student-login`, `--refresh-snapshot`,
`--prereq-from-snapshot` are **connect/AV-specific**. `--reuse`, `--spa-path`, and
the base flags are **generic** and belong on every concierge subcommand.

Pass-through after `--` is enabled by `static strict = false` (`connect.ts:72`).

---

## 3. Reusable vs. connect-specific (the factoring)

### Fully reusable today (zero change to add coach)
- **`resolveFlow`** (`core/flow/resolve.ts`) — pure; already handles
  non-progressive single-stage flows (coach's flows are all non-progressive),
  seed merge, closure, prerequisite recursion.
- **`discoverFlowManifest` / `resolveAppCwd` / `buildStackContext`**
  (`e2e-orchestrate.ts`) — generic over SPA id; already resolve `COACH` repo
  paths (`shared-flags.ts:56-59` defines the `--coach` / `$COACH` flag).
- **`executeResolvedFlow`** (`e2e-orchestrate.ts:858`) — generic; drives any
  resolved flow. Coach's flows are self-seeding `reset:true`, so the up →
  reset+seed → verify → Playwright path applies unchanged. Repo-absent skips
  (`:971`) already handle a not-cloned coach.
- **`makeStackApi`** + the manifest — `coach-api` (`:475`) and `coach-web`
  (`:515`) already exist in `core/manifest/services.ts` with proper
  `dependsOn`/`databases`/`lane` (ports 6105 / 8800).
- **`mintNativeLoginJar`** (`base-command.ts:947`) — SPA-agnostic; mints the
  dev-persona cookie jar (slot-aware). Reusable for a coach hand-off.
- The `--hold` **epilogue pattern** (`run.ts:411-472`, `holdEpilogue`) — mint jar
  + best-effort open browser + print held-state summary, exit 0, stack stays up.

### Connect-specific (do NOT copy blindly)
- The `CONNECT_SPA = 'saga-dash'` / `CONNECT_FLOW = 'connect-session'` constants
  (`connect.ts:57-58`) and the AV flags (`--fake-media`, `--student-login`,
  `--tunnel`, the snapshot flags).
- The foreground hand-off = an **interactive Playwright spec that holds the TTY**
  (`page.pause()`). This depends on the SPA authoring an `@interactive`,
  `foreground:true` stage. **Coach's `flows.json` has none today** (see §5).

### SPA-specific but NOT yet generalized — the browser opener
- **`openVendoredBrowser`** (`base-command.ts:977-1009`) is **hardwired to
  saga-dash**: it `createRequire`s playwright from `<saga-dash>/apps/web/dash`,
  sets `SAGA_DASH_DASH`, and opens `DASH_URL` (default `:8900`). It warns-and-skips
  if the saga-dash dash app is absent (`:995-1001`). A coach hand-off that wants a
  logged-in **coach-web** browser cannot use this as-is — it opens the dash, not
  coach-web. This is the single biggest factoring gap for `develop coach`.

### Cleanest factoring recommendation
Extract a shared **`ConciergeCommand`** base (or a `runConcierge(opts)` helper in
`e2e-orchestrate.ts` / a new `develop-orchestrate.ts`) that takes
`{ spaId, flowName, extraStageEnv, handoff }` and runs steps 3–13 of §1. Then:
- `develop connect` = `runConcierge({ spaId:'saga-dash', flowName:'connect-session',
  handoff:'foreground-spec', … })` + the AV flags.
- `develop coach` = `runConcierge({ spaId:'coach-web', flowName:<chosen>,
  handoff:'hold-browser', … })`.
- Later `develop saga-dash`/`ads`/`sis` = one more call with different constants.

Make the **browser opener SPA-parameterizable** (an `appDir` + `port` + which repo
provides playwright) so `handoff:'hold-browser'` can open coach-web, not just the
dash. That is the one new piece of *code* the concierge generalization needs;
everything else is data + a thin command file.

---

## 4. What a NEW `develop` topic + `develop coach` needs

### 4a. Topic registration (oclif)
Two things, mirroring the existing `e2e` topic:
1. **`package.json` `oclif.topics`** — add a `develop` entry (and it uses
   `topicSeparator: " "`, so subcommands are space-separated). Current topics are
   at `package.json` `oclif.topics` (`stack`, `stack:snapshot`, `e2e`, `set`).
   Add:
   ```json
   "develop": {
     "description": "Concierge scripts that set up and drop you into a developable stack for a specific app or workflow (seed, reset, prerequisites, then hand off a running app)."
   }
   ```
2. **Command directory** — `src/commands/develop/`. oclif uses
   `commands.strategy: "pattern"` + `target: "./dist/commands"` (`package.json`
   `oclif`), so any file `src/commands/develop/<name>.ts` exporting a
   `default class extends BaseCommand` auto-registers as `develop <name>`. No
   manual wiring. (Same as how `e2e/connect.ts` → `e2e connect` works today.)

### 4b. The `develop coach` command file
`src/commands/develop/coach.ts`, a thin command mirroring §1. It needs:
- constants `COACH_SPA = 'coach-web'`, `COACH_FLOW = <chosen flow>`;
- generic flags: `...BaseCommand.baseFlags`, `--reuse`, `--spa-path`, `static
  strict = false` (passthrough);
- **a coach registry row** (§5) so `discoverFlowManifest('coach-web', …)` resolves;
- a hand-off decision (§6).

### 4c. `develop saga-dash` / `develop ads` / `develop sis` (later)
Each is another file in `src/commands/develop/` + (for ads/sis) manifest/registry
coverage. saga-dash is already registered; ads/sis frontends would need registry
rows + authored flows.

---

## 5. Registry + coach flows.json status (the DATA half)

- **`coach-web` is NOT in the built-in SPA registry yet.** `SPA_REGISTRY`
  (`src/core/flow/spa-registry.ts`) has only `saga-dash` and `connectv3`. Adding
  coach = **one row** (the M6 "second-SPA" pattern, proven for connectv3):
  ```ts
  'coach-web': {
    id: 'coach-web', system: 'coach-web', repoEnvVar: 'COACH',
    defaultRepoSubpath: 'coach', appDir: 'apps/web/coach-web',
    e2eDir: 'apps/web/coach-web/e2e', playwrightConfig: 'playwright.config.ts',
  },
  ```
  (These exact values are confirmed from coach's own `flows.json` `spa` block.)
- **Coach's `flows.json` ALREADY EXISTS and wraps a REAL suite:**
  `/home/skelly/dev/coach/apps/web/coach-web/e2e/flows.json`. It declares SPA id
  `coach-web`, and three flows, all `lanes:["stack"]`, `progressive:false`,
  `seed:{ profile:"full", reset:true }`, `project:"chromium"`,
  `requiredSystems:["coach-web","coach-api","iam-api"]`:
  - **`dashboard`** — authenticated tutor dashboard renders the seeded curriculum
    (27 modules). ← maps to scenario 4 (admin/tutor dashboard).
  - **`module-playback`** — in-app module playback of the ported renderers (the
    12 base question types), against the synthetic seed fixture. ← maps to
    scenario 3 (the ported content-viewer application).
  - **`module-playback-real-content`** — same, but against a REAL archive
    curriculum; requires `ARCHIVE_DIR` + `PUBLISH_REAL_CONTENT=1`.
- **No `develop`-oriented (foreground/interactive/held) coach flow exists yet.**
  All three are headless smoke/acceptance tests. So `develop coach` cannot just
  point at an interactive spec the way `connect` does — it must either (a) use the
  **`--hold` hand-off** model (bring the stack up + seed via one of these flows,
  then mint jar + open a coach-web browser and leave the dev server running), or
  (b) coach authors a new `foreground:true` flow. **(a) is the pragmatic path** and
  needs no coach-repo change beyond what exists.
- **No bundled example needed** — the real `flows.json` is present in the coach
  checkout, so discovery finds it directly (the `BUNDLED_EXAMPLE` fallback,
  `e2e-orchestrate.ts:84`, is only for repos that haven't authored one).

### Scenario → coach flow mapping (from prompt-2.md scenarios 3-5)
- **(3) coach + ported content-viewer** → `module-playback` (and/or
  `module-playback-real-content` for real curriculum).
- **(4) coach + admin dashboard** → `dashboard`.
- **(5) coach + playlisting interface** → **no flow exists yet** in coach's
  `flows.json`; needs authoring in the coach repo, OR the concierge just brings up
  the coach closure + seeds and hands off the running app for manual navigation to
  the playlisting UI. (Confirm the playlisting route exists in coach-web — outside
  this doc's scope; flagged as an open question.)

These three scenarios could be **one `develop coach` command with a
`--scenario`/`--flow` selector** (dashboard | content-viewer | playlisting), or
sub-variants. The flow-selection is just a different `COACH_FLOW` constant / flag
value fed to `resolveFlow`.

---

## 6. The hand-off — the main open design question

Connect's hand-off = a foreground `@interactive` Playwright spec that logs in the
participants and holds the TTY via `page.pause()`. Coach has **no such spec**. Two
viable hand-off models, both already in the codebase:

1. **Hold-epilogue model (recommended, no coach-repo change):** run a headless
   coach flow (up + reset+full-seed + verify), then run the `holdEpilogue` pattern
   (`run.ts:411`): `mintNativeLoginJar` (dev/seeded-tutor persona) → open a
   **coach-web** browser at `http://localhost:8800` (slot-offset) → print
   held-state summary → exit 0, stack + dev server stay up. **Blocker:**
   `openVendoredBrowser` (`base-command.ts:977`) opens saga-dash's dash, not
   coach-web — it must be generalized to accept the SPA's `appDir`/port/playwright
   provider. This is the one new bit of code.
2. **Foreground-spec model (mirrors connect exactly):** coach authors a
   `foreground:true`, `@interactive` flow in its `flows.json` whose spec logs in
   and `page.pause()`s. Then `develop coach` is byte-for-byte the connect template
   with different constants. **Cost:** a coach-repo PR to author the spec.

**Open question for the develop-coach builder:** which hand-off? (1) is faster to
ship and reuses `--hold`; (2) is the truest mirror of connect but needs a coach
spec. Recommendation: ship (1), generalize `openVendoredBrowser`, and leave (2) as
a future enhancement if a coach author wants an interactive spec.

Note the seeded persona: coach's flows mint a session for the seeded tutor
`demo-tutor-1` inside the spec. A hold-epilogue would need to mint the same persona
(not the default `dev@saga.org`) for the browser to land on a populated dashboard
— confirm the right `--email`/persona for the coach jar.

---

## 7. The deprecating `e2e connect` alias (oclif mechanics)

The issue (#305) requires: *"Migrate `connect.ts` → `develop/connect.ts`; leave a
deprecating alias at `e2e connect`."* Three oclif options, in order of preference:

1. **`static aliases` + `static deprecateAliases = true` on the real command
   (RECOMMENDED).** oclif v4 (`@oclif/core ^4.0.0`, confirmed in `package.json`)
   supports `deprecateAliases`. Put the command at
   `src/commands/develop/connect.ts` and add:
   ```ts
   static aliases = ['e2e:connect'];        // colon form in code; invoked as `e2e connect`
   static deprecateAliases = true;          // prints a deprecation warning when the alias is used
   ```
   Running `ss e2e connect` then dispatches to the real `develop connect` and emits
   *"Warning: e2e connect is deprecated. Use develop connect instead."* One command
   file, no duplicated logic. **This is the cleanest.** (No `aliases`/`hidden`/
   `deprecateAliases` are used anywhere in the CLI today — grep confirms zero
   existing usages — so this is a new pattern, but a standard oclif one.)
2. **A thin warn-and-delegate shim command at `src/commands/e2e/connect.ts`.**
   Keep a `class E2eConnect extends DevelopConnect` (or a stub) that overrides
   `run()` to `this.warn('deprecated — use `ss develop connect`')` then
   `super.run()` / delegates. More code, but gives full control over the message
   and lets you `static hidden = true` it out of `--help` listings while keeping it
   invokable. Use this if the alias warning text/behavior needs to be richer than
   oclif's default.
3. **`static hidden = true`** alone just hides from help — it does NOT warn or
   redirect, so it's insufficient by itself for a *deprecating* alias. Combine with
   (1) or (2).

**Recommendation:** Option 1 (`aliases` + `deprecateAliases`) for `develop connect`,
for "one cycle" as the issue says. Remove the alias in a later release. Keep the
oclif topic `e2e` itself (its `list`/`run`/`traces` stay); only `connect` moves.

---

## 8. Concrete commands (run/verify locally)

The CLI runs from source via `bin/dev.js` (oclif dev entry). From the package dir
`packages/node/saga-stack-cli`:

```bash
# existing connect concierge (the template):
node bin/dev.js e2e connect --dry-run 2>/dev/null || node bin/dev.js e2e connect --help
node bin/dev.js e2e connect                       # full: journey prereq → headed connect room
node bin/dev.js e2e connect --reuse -- --debug    # against current stack, playwright --debug
node bin/dev.js e2e connect --fake-media

# discovery + list (read-only; shows flows a develop cmd would resolve):
node bin/dev.js e2e list                          # NOTE: coach-web won't appear until the registry row is added
node bin/dev.js e2e list --output-json

# drive a coach flow TODAY via the generic runner (proves the closure/seed path
# before any develop command exists) — coach must be cloned at $COACH or ~/dev/coach:
node bin/dev.js e2e run coach-web/dashboard --dry-run          # after adding the registry row
node bin/dev.js e2e run coach-web/dashboard --slot 1           # this effort runs on slot 1
node bin/dev.js e2e run coach-web/dashboard --hold --slot 1    # up+seed then hold a logged-in browser

# build / typecheck / test the CLI package:
pnpm --filter @saga-ed/saga-stack-cli build
pnpm --filter @saga-ed/saga-stack-cli test
pnpm --filter @saga-ed/saga-stack-cli typecheck
```

Effort ground rules (prompt-1.md): all live bring-up/testing runs against **ss slot
1**, in this worktree. `--slot 1` offsets backend ports by 1000 (coach-api
6105→7105, but browser frontends stay on slot-0 ports per `derive-instance`).

---

## 9. Key files (for the builder)

| File | Why it matters |
|---|---|
| `src/commands/e2e/connect.ts` | The concierge template to mirror (241 lines). |
| `src/core/flow/resolve.ts:191` | `resolveFlow` — pure resolver; handles coach's non-progressive flows unchanged. |
| `src/core/flow/types.ts` | `flows.json` zod schema (SPA + flow + stage + seed). `coach-api`/`coach-web` already valid ServiceIds (`:36-37`). |
| `src/core/flow/spa-registry.ts` | Add the `coach-web` row here (the M6 one-row onboarding). |
| `src/e2e-orchestrate.ts:132` `:227` `:332` `:858` | `discoverFlowManifest` / `buildStackContext` / `resolveAppCwd` / `executeResolvedFlow` — the shared machinery. |
| `src/base-command.ts:947` `:977` | `mintNativeLoginJar` (reusable) / `openVendoredBrowser` (saga-dash-hardwired — must generalize for coach). |
| `src/commands/e2e/run.ts:411` | `holdEpilogue` — the "hand off a running logged-in app" pattern to reuse. |
| `src/commands/stack/login.ts` | The login concierge step (native jar + `--browser`). |
| `src/shared-flags.ts:56` `:111` | `--coach`/`$COACH` repo flag; the `baseFlags` every command spreads. |
| `package.json` `oclif.topics` / `oclif.commands` | Where to register the `develop` topic; pattern-strategy auto-registration of `src/commands/develop/*`. |
| `/home/skelly/dev/coach/apps/web/coach-web/e2e/flows.json` | Coach's REAL flows (`dashboard`, `module-playback`, `module-playback-real-content`) — the scenario 3/4 targets. |
| `src/core/manifest/services.ts:475` `:515` | `coach-api` (:6105) / `coach-web` (:8800) manifest entries. |

---

## 10. Open questions blocking/shaping the develop-coach plan

1. **Hand-off model** (§6): hold-epilogue browser (needs `openVendoredBrowser`
   generalized to coach-web) vs. a new coach interactive `foreground` flow. Pick
   one.
2. **Scenario 5 (playlisting)** has **no coach `flows.json` flow** — does
   `develop coach --scenario playlisting` bring up + seed + hand off for manual
   navigation, or does coach need to author a playlisting flow first? Confirm the
   playlisting route exists in coach-web.
3. **Command shape:** one `develop coach` with a `--scenario`/`--flow` selector
   (dashboard | content-viewer | playlisting) vs. multiple subcommands. The
   flow-selection is just a `COACH_FLOW` value.
4. **Persona for the coach jar:** coach flows mint `demo-tutor-1`, not
   `dev@saga.org` — a hold-epilogue must mint the seeded tutor for a populated
   dashboard. Confirm the persona/email.
5. **`module-playback-real-content` needs `ARCHIVE_DIR` + `PUBLISH_REAL_CONTENT=1`**
   — if the concierge is to support real curriculum, it must surface a flag/env for
   the content-archive checkout. Probably out of scope for v1.
6. **Alias mechanics confirmation:** verify `deprecateAliases` renders the warning
   as expected under this repo's `@oclif/core ^4` at runtime (no existing usage in
   the CLI to copy from).
