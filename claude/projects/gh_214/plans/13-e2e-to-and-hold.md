# Plan 13 — `e2e run --to <stage>` + `--hold` (manual-testing handoff)

**Goal:** first-class "get me to the state right before stage K and hand me a live,
logged-in browser" for manual testing. Today's nearest approximations all fall
short: `--through K` *runs* stage K's spec; `-- --debug` holds Playwright's
inspector inside a spec; `stack login` gives a browser but you assemble the state
yourself; `foreground`/`page.pause()` is a per-flow authoring choice (connect's AV
hold), not a CLI capability.

**Decision (settled in scoping):** two orthogonal flags, not one.

## 1. `--to <stage>` — exclusive window end

Run the flow's stages **up to but not including** `<stage>`, leaving the stack in
stage `<stage>`'s entry state.

- Grammar identical to `--through`/`--from`: stage name, 1-based number, or
  Playwright project (reuse the exact matcher — one resolver, three flags).
- `core/flow/resolve.ts`: windowing already has `fromPhase`/`throughPhase`.
  `--to K` resolves to the window ending at K−1. Do NOT implement as CLI-side
  "through K−1" sugar — thread a real `toPhase` through `resolveFlow` so
  validation messages name the flag the user typed and `describeResolved` can
  project it faithfully.
- Validation (manual oclif checks, NOT `exclusive:` relationships — oclif treats
  DEFAULTED values as provided; see M14's dependsOn lesson):
  - mutually exclusive with `--through`;
  - composes with `--from`: `--from X --to K` = restore X's predecessor
    checkpoint, replay [X, K) only;
  - `--from K --to K` (empty window) is VALID — it means "restore checkpoint,
    run nothing"; warn when used without `--hold` (pointless otherwise);
  - `--to <first stage>` = reset+seed baseline only, zero Playwright;
  - non-progressive (single-stage) flows reject `--to` (no interior state);
  - unknown stage → same did-you-mean error surface as `--through`.
- `describeResolved` gains `to` in its projection (dry-run JSON + text).

## 2. `--hold` — post-run manual-testing handoff

After the run's window goes green (any of `--to`/`--through`/full run):

1. Mint the dev-persona cookie jar via the existing M11 seam
   (`BaseCommand.mintNativeLoginJar` — already slot-aware: LOGIN_IAM_URL / slot
   offset iam; jar at the slot's `<stateDir>/cookies.txt`).
2. Best-effort open the vendored browser (`openVendoredBrowser`, existing seam)
   at the SPA's **slot-offset** URL (derive from the lane + slot ports the run
   already resolved — do not recompute).
3. Print a held-state summary: flow, boundary stage ("held at entry of
   `pods`"), slot/set, services up, jar path, and the teardown reminder
   (`ss stack down [--set <name>]`).
4. Exit 0. NO process holds the TTY — the stack already stays up after every
   run; the browser is detached. (Deliberately simpler than connect's
   `page.pause()` AV hold.)

- Works with `--set`/`--slot` for free (both seams are M11/M13-aware).
- Does not imply `--headed` (irrelevant — the held browser is not Playwright's).
- On a browserless/headless host: jar mint must still succeed; the browser open
  is best-effort and its failure is a WARN line, not an error (matches `stack
  login --browser` semantics).

**The killer idiom** (document it): once checkpoints are baked,
`ss e2e run saga-dash/journey --from schedule --to schedule --hold --set topo`
= restore the pods-state checkpoint, run nothing, logged-in browser at the
schedule stage's doorstep in seconds.

## 3. Touch points

| Area | Change |
|---|---|
| `core/flow/resolve.ts` | `toPhase` in `ResolveOptions` + windowing + validation |
| `commands/e2e/run.ts` | `--to`, `--hold` flags; manual exclusivity checks; hold epilogue |
| `e2e-orchestrate.ts` | `DescribeOptions`/`describeResolved` projection (`to`, `hold`); expose the resolved SPA URL for the hold |
| `commands/e2e/connect.ts` | NOT touched (its hold is the AV `page.pause()`; different beast) |
| `docs/e2e.md` | "Manual testing at a stage boundary" section + the idiom above |

No new seams. No manifest changes. No core→runtime boundary crossings.

## 4. Tests (TDD; 908 suite baseline must stay green)

- `core/flow/__tests__/resolve-from.unit.test.ts` (extend): to-window combos —
  `to` alone, `from+to`, empty window, `to` first stage, `to` ∧ `through`
  rejection, non-progressive rejection, off-by-one boundaries.
- `commands/e2e/__tests__/run.int.test.ts` (extend, shared harness): flag
  validation errors; dry-run projection shows `to`/`hold`; hold epilogue mints
  jar + opens browser via the prototype-spied seams (`getCookiePoster`,
  `getJarWriter`, browser-opener seam) with slot-offset URL asserted at
  `--slot 1`; browser-open failure = warn, exit 0.
- Golden-anchor rule (M15-C): variant argv assertions may use the `pwArgv`
  builder; do not touch the literal anchors.

## 5. Live validation (required before PR)

On **slot 1** (free; do NOT touch slot 0's stack or slot 2):
1. `e2e run saga-dash/journey --to program --slot 1 --headless` → runs roster
   only, exits, stack up; verify services healthy and roster state present.
2. Re-run with `--snapshot-stages` through a couple stages, then
   `--from <stage> --to <stage> --hold --slot 1` → checkpoint restore, zero
   Playwright, jar minted (verify file), browser open attempted (WARN
   acceptable headless), summary printed.
3. `stack down --slot 1` when done.

### 5.1 Live-validation divergences (recorded)

Two realities surfaced during live validation on slot 1; both are pre-existing
behavior my change composes with, not regressions:

1. **The stage-0-coherence gate assumes the full mesh on the stack lane.** The
   SPA's Playwright `stage-0-coherence` project (a dependency of every stage)
   probes `scheduling-api` (:4008) and `sessions-api` (:4007) unconditionally on
   the stack lane (`pinnedOrStack = LANE === 'stack' || …`). A partial-closure run
   — `--to program` (window `[roster]`), or the identical `--through roster` —
   does NOT bring those up, so stage-0-coherence fails unless the full stack is
   already running. This is the existing N-of-M-vs-coherence interaction, NOT
   caused by `--to` (`--to program` resolves to the same window as `--through
   roster`). Plan §5 step 1's "runs roster green on a bare slot" only holds when
   the full mesh is up. **The empty-window hold path (`--to <first stage>`,
   `--from K --to K`) sidesteps this by running zero Playwright** — validated live.

2. **`--hold`'s headful browser holds the window (and the TTY) until closed.**
   The existing `openVendoredBrowser` seam runs the vendored `browser-login.mjs`,
   which on a headful host keeps the Chromium window + its process alive until the
   user closes it (`await new Promise(() => {})`); `--hold` awaits that seam, so the
   command blocks until the window closes, THEN exits 0. On a headless host the
   script exits 0 immediately (jar minted; browser best-effort). This is the SAME
   behavior as `stack login --browser` and honors the plan's "existing seam / no
   new seams" constraint — so plan §2 step 4's "exit 0, browser detached" is
   literally true headless, while headful it holds the window open (the more useful
   manual-testing posture). Left as-is; documented in the summary output.

## 6. Out of scope (recorded, not built)

- `--to` sugar that auto-selects the freshest valid checkpoint without `--from`
  (v2 candidate once the idiom sees use).
- Any Playwright-side hold (`page.pause()` injection) — flows that want an AV/TTY
  hold keep authoring it in-spec like connect does.
- `e2e connect` changes.

**Size:** S/M. One agent, one branch (`gh_e2e-to-hold` off main), plan committed
as the branch's first commit, draft PR to main.
