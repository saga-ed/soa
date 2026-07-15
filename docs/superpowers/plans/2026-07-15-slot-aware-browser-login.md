# Slot-aware `stack login --browser` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ss stack login --browser` open an auto-logged-in Chromium at any slot (not just slot 0) by pointing the browser at the slot's own dash, so two backend stacks on two slots give two fully isolated logged-in browsers.

**Architecture:** The headful-browser seam is already env-parameterised (`browser-login.mjs` reads `IAM_URL`/`DASH_URL`/`PROFILE_DIR`; `openVendoredBrowser` already accepts a `dashUrl` override and already passes a slot-aware `iamUrl` + per-slot `PROFILE_DIR`). The only unwired value is `DASH_URL`. This change removes the `slot > 0` refusal in `stack login` and threads the slot's offset dash URL into the existing `dashUrl` override. Slot 0 stays byte-identical. Isolation between slots comes from the already-per-slot `stateDir` (⇒ distinct persistent browser profiles) — no per-slot profile suffix.

**Tech Stack:** TypeScript (ESM, strict), oclif CLI, Vitest, pnpm. Package: `packages/node/saga-stack-cli` (the `ss` CLI).

## Global Constraints

- **Indentation: 2 spaces.** `saga-stack-cli` is 2-space (enforced by its own `eslint.config.js`). Do NOT apply the soa repo-wide 4-space default inside this package — match the file being edited.
- **pnpm only** (never npm). ESM only. No Prettier; ESLint.
- **Slot 0 must stay byte-identical.** At slot 0 the computed dash port is `8900`, so `DASH_URL` resolves exactly as before; the existing slot-0 `--browser` test must pass unchanged.
- **`LOGIN_DASH_URL` wins** over the computed slot dash URL (tunnel/manual escape hatch).
- **No `up.ts` change** and **no transcripts warning** (both explicitly out of scope per the spec).
- Run every command from the package root: `packages/node/saga-stack-cli`.
- `oclif.manifest.json` is git-tracked; `dist/` is not. Any change to a flag `description:` string requires `pnpm build` (which runs `oclif manifest`) and committing the regenerated manifest.

**Spec:** `docs/superpowers/specs/2026-07-15-slot-aware-browser-login-design.md`

---

### Task 1: Slot-parameterise `stack login --browser`

**Files:**
- Modify: `packages/node/saga-stack-cli/src/commands/stack/login.ts` (remove the `slot > 0` refusal ~lines 66-75; thread `dashUrl` into the `openVendoredBrowser` call ~lines 118-120)
- Test: `packages/node/saga-stack-cli/src/commands/stack/__tests__/login-native.int.test.ts` (replace the "refused at slot > 0" test; add a `LOGIN_DASH_URL`-precedence test; clear `LOGIN_DASH_URL` between tests)

**Interfaces:**
- Consumes (existing, unchanged signatures):
  - `deriveInstance({ slot }): InstanceProfile` — use `profile.portOverrides['saga-dash']` (`number | undefined`; `'saga-dash'` is the manifest service id, base port `8900`).
  - `this.openVendoredBrowser(flags, ctx: { email: string; iamUrl: string; stateDir: string; dashUrl?: string }): Promise<void>` — already defined on `BaseCommand`; we now pass `dashUrl`.
  - `res.iamUrl` from `this.mintNativeLoginJar(...)` — already slot-aware (`http://localhost:${3010 + slot*1000}`).
- Produces: no new exported symbols (terminal behavior change).

- [ ] **Step 1: Update the test file (write the failing tests)**

In `src/commands/stack/__tests__/login-native.int.test.ts`:

(1a) Clear `LOGIN_DASH_URL` alongside `LOGIN_IAM_URL`. In `beforeEach` (currently line 75) add the second delete, and in `afterEach` (currently line 86) add it too:

```ts
// in beforeEach, replace the single delete with both:
  delete process.env.LOGIN_IAM_URL;
  delete process.env.LOGIN_DASH_URL;
```

```ts
// in afterEach, replace the single delete with both:
  vi.restoreAllMocks();
  delete process.env.LOGIN_IAM_URL;
  delete process.env.LOGIN_DASH_URL;
```

(1b) Replace the entire existing `it('--browser at slot > 0 is refused ...')` block (currently lines 193-202) with these two tests:

```ts
  it('--browser at slot > 0 opens the browser against the SLOT\'s dash + iam (not slot 0)', async () => {
    installPoster(OK_COOKIES);
    installJar();
    // the spawn guard checks the saga-dash dash dir exists; report it present.
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue(() => true);

    await StackLogin.run(['--browser', '--slot', '1', ...WS], config);

    // native jar minted against the slot-1 iam (:4010) at the slot-1 state dir.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('http://localhost:4010/trpc/auth.devLogin');
    expect(jarWrites).toHaveLength(1);
    expect(jarWrites[0]?.path).toBe('/tmp/sds-synthetic-s1/cookies.txt');

    // browser opened against the SLOT-1 dash (:9900) with the SLOT-1 persistent profile.
    expect(runnerCalls).toHaveLength(1);
    const spawn = runnerCalls[0];
    expect(spawn?.command).toBe('node');
    expect((spawn?.args[0] ?? '').endsWith('browser-login.mjs')).toBe(true);
    expect(spawn?.env).toMatchObject({
      IAM_URL: 'http://localhost:4010',
      DASH_URL: 'http://localhost:9900',
      PROFILE_DIR: '/tmp/sds-synthetic-s1/browser-profile',
    });
  });

  it('LOGIN_DASH_URL overrides the computed slot dash URL (tunnel escape hatch)', async () => {
    process.env.LOGIN_DASH_URL = 'https://dash.moniker.wootdev.com';
    installPoster(OK_COOKIES);
    installJar();
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue(() => true);

    await StackLogin.run(['--browser', '--slot', '1', ...WS], config);

    const spawn = runnerCalls[0];
    // dash URL is the explicit override; iam stays the slot's (LOGIN_DASH_URL is dash-only).
    expect(spawn?.env?.DASH_URL).toBe('https://dash.moniker.wootdev.com');
    expect(spawn?.env?.IAM_URL).toBe('http://localhost:4010');
  });
```

- [ ] **Step 2: Run the new tests to verify they FAIL**

Run: `pnpm test -- login-native --run`
Expected: FAIL — the two new tests error because `stack login --browser --slot 1` still throws the refusal (`this.error(... 'slot 1: --browser opens a Chromium against slot 0's dash' ...)`) before minting the jar or spawning the browser. The unchanged slot-0 tests pass.

- [ ] **Step 3: Remove the `slot > 0` refusal in `login.ts`**

In `src/commands/stack/login.ts`, delete this block (currently lines 66-75, including the trailing blank line) so parsing flows straight into the native-jar section:

```ts
    // --browser opens a Chromium against slot 0's dash (DASH :8900, PROFILE under
    // /tmp/sds-synthetic). browser-login.mjs is not slot-parameterised, so refuse
    // --browser at slot > 0 rather than open a window pointed at slot 0's dash.
    if (flags.browser && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --browser opens a Chromium against slot 0's dash (DASH :8900, ` +
          "PROFILE under /tmp/sds-synthetic). Drop --browser to mint the slot's headless jar natively.",
      );
    }

```

Result: line `const { args, flags } = await this.parse(StackLogin);` is now immediately followed by the `// ── NATIVE headless cookie jar ...` comment.

- [ ] **Step 4: Thread the slot's dash URL into `openVendoredBrowser`**

In the same file, replace the final `--browser` block (currently lines 118-120):

```ts
    if (flags.browser) {
      await this.openVendoredBrowser(flags, { email, iamUrl, stateDir });
    }
```

with:

```ts
    if (flags.browser) {
      // Point the browser at the SLOT's own dash (base 8900 + slot*1000, from the
      // resolved profile). LOGIN_DASH_URL still wins for the tunnel case. iamUrl and
      // stateDir (⇒ PROFILE_DIR) are already slot-aware; the per-slot stateDir gives a
      // distinct persistent profile per slot. At slot 0 dashPort is 8900, so this is
      // byte-identical to the previous slot-0-only behaviour.
      const dashPort = profile.portOverrides['saga-dash'] ?? 8900;
      const dashUrl = process.env.LOGIN_DASH_URL || `http://localhost:${dashPort}`;
      await this.openVendoredBrowser(flags, { email, iamUrl, stateDir, dashUrl });
    }
```

(`profile`, `email`, `iamUrl`, `stateDir` are all already in scope from the native-jar section above.)

- [ ] **Step 5: Run the login-native suite to verify it PASSES**

Run: `pnpm test -- login-native --run`
Expected: PASS — all tests, including:
- the unchanged slot-0 `--browser` test (`DASH_URL: 'http://localhost:8900'`, `PROFILE_DIR: '/tmp/sds-synthetic/browser-profile'`),
- the new slot-1 test (`:9900` / `:4010` / `-s1` profile),
- the `LOGIN_DASH_URL` precedence test.

- [ ] **Step 6: Typecheck**

Run: `pnpm check-types`
Expected: no errors. (Confirms `profile.portOverrides['saga-dash']` is a valid `ServiceId` index and `dashUrl` matches the `openVendoredBrowser` ctx type.)

- [ ] **Step 7: Commit**

```bash
git add src/commands/stack/login.ts src/commands/stack/__tests__/login-native.int.test.ts
git commit -m "feat(saga-stack-cli): slot-parameterise stack login --browser

Open the headful Chromium against the slot's own dash (8900+slot*1000) instead
of refusing at slot > 0. iamUrl + per-slot profile were already slot-aware, so
two slots give two isolated logged-in browsers. LOGIN_DASH_URL still wins; slot 0
stays byte-identical.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Correct the stale slot-flag doc + regenerate the manifest

**Files:**
- Modify: `packages/node/saga-stack-cli/src/shared-flags.ts` (the ceiling comment ~lines 119-123 and the flag `description:` ~lines 125-126)
- Modify (generated): `packages/node/saga-stack-cli/oclif.manifest.json` (via `pnpm build`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Doc/help-text only. The `slot` flag's runtime `default`/`min`/`max` are unchanged.

- [ ] **Step 1: Fix the comment block**

In `src/shared-flags.ts`, replace the ceiling comment (currently lines 119-123):

```ts
    // CEILING 9 (M7 MINOR): the mesh's rabbitmq (:5672) and rabbitmq-mgmt (:15672)
    // differ by 10000 = 10 * the 1000 stride, so slot 10's rabbitmq (:15672) would
    // collide with slot 0's rabbitmq-mgmt (:15672). Cap at 9 so every slot's full
    // resolved port band stays disjoint. Slot > 0 is a BACKEND sub-stack (the
    // literal-port backends + browser frontends are excluded — see derive-instance).
```

with:

```ts
    // CEILING 9 (M7 MINOR): the mesh's rabbitmq (:5672) and rabbitmq-mgmt (:15672)
    // differ by 10000 = 10 * the 1000 stride, so slot 10's rabbitmq (:15672) would
    // collide with slot 0's rabbitmq-mgmt (:15672). Cap at 9 so every slot's full
    // resolved port band stays disjoint. Slot > 0 is a BACKEND + FRONTEND sub-stack:
    // the saga-dash/coach-web/connect-web frontends run on their OFFSET port; only the
    // literal-port playback trio stays excluded (soa#271 — see derive-instance).
```

- [ ] **Step 2: Fix the flag `description:` string**

In the same file, replace the `slot` flag description (currently lines 125-126):

```ts
    description:
      'stack instance slot (0 = default; N in 1..9 offsets ports by N*1000 into an isolated soa-s<N> BACKEND sub-stack — the literal-port backends + browser frontends stay on slot 0). Ceiling is 9: slot 10 would collide rabbitmq (:15672) with slot 0 rabbitmq-mgmt.',
```

with:

```ts
    description:
      'stack instance slot (0 = default; N in 1..9 offsets ports by N*1000 into an isolated soa-s<N> sub-stack — backend services AND the saga-dash/coach-web/connect-web frontends run on their offset port; only the literal-port playback trio stays on slot 0). Ceiling is 9: slot 10 would collide rabbitmq (:15672) with slot 0 rabbitmq-mgmt.',
```

- [ ] **Step 3: Regenerate the manifest**

Run: `pnpm build`
Expected: `tsc` succeeds, then `oclif manifest` rewrites `oclif.manifest.json` with the new slot description across every command entry.

Verify the swap took (old string gone, new string present):

Run: `grep -c "frontends stay on slot 0" oclif.manifest.json; grep -c "only the literal-port playback trio stays on slot 0" oclif.manifest.json`
Expected: first count `0`, second count `> 0`.

- [ ] **Step 4: Full test suite + lint**

Run: `pnpm test`
Expected: PASS (whole package — confirms the doc change and Task 1 together break nothing).

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared-flags.ts oclif.manifest.json
git commit -m "docs(saga-stack-cli): correct stale slot-flag help — frontends are slottable

The slot flag comment + --help description claimed browser frontends stay on /
are excluded from slot 0; soa#271 made saga-dash/coach-web/connect-web slottable
(they run on their offset port). Regenerate oclif.manifest.json to match.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end verification gate

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full local gate**

From `packages/node/saga-stack-cli`:

Run: `pnpm test && pnpm check-types && pnpm lint`
Expected: all pass. (Per the repo's "run the full suite before merge-ready" rule.)

- [ ] **Step 2: (Optional) zero-build manual smoke of the help text**

`bin/dev.js` runs straight from `src/` via `tsx` (no build needed):

Run: `node bin/dev.js stack login --help`
Expected: the `--slot` help line shows the corrected description (frontends run on their offset port; only the playback trio stays on slot 0), and `--browser` is listed with no slot restriction.

- [ ] **Step 3: (Optional, needs a machine with Docker + two free slots) real two-browser smoke**

This is environmental and not required to land the change; document the result if run:

```bash
ss stack up --slot 1 && ss stack up --slot 2
ss stack login --slot 1 --browser   # Chromium → dash :9900, iam :4010, profile /tmp/sds-synthetic-s1
ss stack login --slot 2 --browser   # Chromium → dash :10900, iam :5010, profile /tmp/sds-synthetic-s2
```

Expected: two separate Chromium windows, each logged into its own stack, with no shared cookies (distinct persistent profiles). Note: `ss` runs the **main** checkout's CLI, so this reflects the change only after merge; to smoke the worktree build, run the worktree's `bin/run.js` (after `pnpm build`) or `bin/dev.js` in place of `ss`.

---

## Self-Review

**1. Spec coverage:**
- Remove `slot > 0` refusal → Task 1, Step 3. ✓
- Compute slot dash URL from `profile.portOverrides['saga-dash']` and pass as `ctx.dashUrl` → Task 1, Step 4. ✓
- `LOGIN_DASH_URL` wins; slot 0 byte-identical → Task 1, Step 4 (code) + Step 1/Step 5 (tests). ✓
- No `up.ts` change, no transcripts warning → not in any task (correctly absent). ✓
- Decision: no per-slot profile suffix (isolation via per-slot `stateDir`) → reflected in Task 1 Step 4 comment + `PROFILE_DIR: '/tmp/sds-synthetic-s1/browser-profile'` assertion. ✓
- Housekeeping: fix stale `shared-flags.ts` comment → Task 2. ✓ (Extended to the `--help` description + manifest regen, which the spec's text also covers.)
- Tests: invert the slot>0 refusal test; assert slot-1 `DASH_URL`/`IAM_URL`/profile; keep `LOGIN_DASH_URL` override → Task 1. ✓ (Corrected the spec's imprecise mention of `slot-guard.unit.test.ts`: the refusal test actually lives in `login-native.int.test.ts`; `slot-guard` needs no change.)

**2. Placeholder scan:** none — every code/test/command step shows the full content.

**3. Type consistency:** `profile.portOverrides['saga-dash']` (`number | undefined`) → `?? 8900` → `number`; `dashUrl: string` matches `openVendoredBrowser`'s `ctx.dashUrl?: string`. Test env keys (`IAM_URL`/`DASH_URL`/`PROFILE_DIR`) match those set in `base-command.ts`'s `openVendoredBrowser`. Consistent.
