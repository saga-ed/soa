# Multiple frontend versions against one stack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ss frontend up <label>=<path>` and `ss frontend browser [labels]` so extra saga-dash versions (from supplied checkouts) run against one backend stack and open as tabs in one logged-in browser.

**Architecture:** A variant is another launch of the existing `saga-dash` service via the real `ServiceLauncher` with three overrides (id `saga-dash@<label>`, the variant checkout as cwd, its own port), reusing the `sync-dash-local-defaults` backend-wiring hook and pidfile tracking. A per-slot `frontends.json` registry maps labels→URLs. The browser opens one `launchPersistentContext` with one `devLogin` and one tab per variant URL — scoped to a single slot (one backend ⇒ one login). Everything is slot-aware, reusing Phase 1's `deriveInstance`/`resolveIamUrl`.

**Tech Stack:** TypeScript (ESM, strict), oclif CLI, Vitest, pnpm. Package: `packages/node/saga-stack-cli`.

## Global Constraints

- **Indentation: 2 spaces** (this package's own `eslint.config.js`; NOT the repo-wide 4-space). Match the file being edited.
- **pnpm only**; ESM; run every command from `packages/node/saga-stack-cli`.
- **`src/core/**` must never import `src/runtime/**`** (enforced invariant). Pure logic in `core`, IO in `runtime`/commands.
- **Slot-aware, default slot 0.** Reuse `deriveInstance({slot})`, `profile.portOverrides['saga-dash']` (the slot's dash base port), `resolveIamUrl({slot})`. All per-variant state lives under the target slot's `stateDir` (`/tmp/sds-synthetic-s<S>`).
- **Single-slot browser invariant:** one `frontend browser` invocation opens tabs for one slot only (one backend ⇒ one iam ⇒ one login ⇒ one profile).
- **Phase-1 browser path stays byte-identical:** the vendored `browser-login.mjs` single-`DASH_URL` behavior must not change; `DASH_URLS` is additive.
- `oclif.manifest.json` is git-tracked; adding a command/topic requires `pnpm build` (runs `oclif manifest`) + committing the regenerated manifest. `dist/` is git-ignored (do not stage).
- Seam pattern: new IO goes behind a `protected get…()` on `BaseCommand` (default real), overridden in tests via `vi.spyOn(BaseCommand.prototype, 'get…')` — mirror `getLauncher`/`getDashFs`/`getCookiePoster`.

**Spec:** `docs/superpowers/specs/2026-07-15-multi-frontend-per-stack-design.md`

---

### Task 1: Core — variant parsing, ids, ports (pure)

**Files:**
- Create: `src/core/frontend-variant.ts`
- Test: `src/core/__tests__/frontend-variant.unit.test.ts`

**Interfaces:**
- Consumes: `deriveInstance`, `SLOT_PORT_STRIDE` from `./derive-instance.js`; `Manifest`, `ServiceId`, `manifest as defaultManifest` from `./manifest/index.js`.
- Produces:
  - `FRONTEND_ID_PREFIX = 'saga-dash@'`
  - `frontendServiceId(label: string): string`
  - `MAX_VARIANTS_PER_SLOT = 9`
  - `parseVariantArg(raw: string): { label: string; path: string }`
  - `reservedServicePorts(m?: Manifest): Set<number>`
  - `variantPortCandidates(dashBase: number, reserved: Set<number>, occupied: Set<number>): number[]`
  - `variantLaunchArgs(port: number): string[]`
  - `variantHealthUrl(port: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/core/__tests__/frontend-variant.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FRONTEND_ID_PREFIX,
  MAX_VARIANTS_PER_SLOT,
  frontendServiceId,
  parseVariantArg,
  reservedServicePorts,
  variantHealthUrl,
  variantLaunchArgs,
  variantPortCandidates,
} from '../frontend-variant.js';

describe('frontend-variant (pure)', () => {
  it('parseVariantArg splits on the FIRST = and validates the label', () => {
    expect(parseVariantArg('main=/home/me/saga-dash')).toEqual({
      label: 'main',
      path: '/home/me/saga-dash',
    });
    // a path may itself contain '=' — only the first splits.
    expect(parseVariantArg('x=/tmp/a=b')).toEqual({ label: 'x', path: '/tmp/a=b' });
  });

  it('parseVariantArg rejects malformed input', () => {
    expect(() => parseVariantArg('no-equals')).toThrow(/label=path/);
    expect(() => parseVariantArg('=/tmp/x')).toThrow(/label/);
    expect(() => parseVariantArg('main=')).toThrow(/path/);
    expect(() => parseVariantArg('bad label=/tmp/x')).toThrow(/label/);
  });

  it('frontendServiceId namespaces the pidfile id under the saga-dash service', () => {
    expect(frontendServiceId('main')).toBe('saga-dash@main');
    expect(FRONTEND_ID_PREFIX).toBe('saga-dash@');
  });

  it('reservedServicePorts includes every slot dash port (8900, 9900, …)', () => {
    const reserved = reservedServicePorts();
    expect(reserved.has(8900)).toBe(true); // slot 0 dash
    expect(reserved.has(9900)).toBe(true); // slot 1 dash
    expect(reserved.has(3010)).toBe(true); // slot 0 iam
  });

  it('variantPortCandidates yields in-band free ports above the dash base', () => {
    const reserved = reservedServicePorts();
    const cands = variantPortCandidates(8900, reserved, new Set([8901]));
    expect(cands[0]).toBe(8902); // 8901 occupied, 8900 excluded (base), 8900 reserved
    expect(cands.every((p) => p > 8900 && p < 8900 + 1000)).toBe(true);
    expect(cands.includes(9900)).toBe(false); // next slot's dash is reserved
  });

  it('variantLaunchArgs / variantHealthUrl build the pnpm-dev launch', () => {
    expect(variantLaunchArgs(8902)).toEqual(['dev', '--port', '8902']);
    expect(variantHealthUrl(8902)).toBe('http://localhost:8902/');
    expect(MAX_VARIANTS_PER_SLOT).toBe(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- frontend-variant --run`
Expected: FAIL — `Cannot find module '../frontend-variant.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/frontend-variant.ts`:

```ts
/**
 * frontend-variant — pure helpers for the multi-frontend feature (`ss frontend`).
 *
 * A "variant" is an extra saga-dash dev server (from a caller-supplied checkout)
 * launched against a running stack. This module owns the PURE decisions: parsing
 * the `<label>=<path>` arg, the pidfile id namespacing, and port selection. No IO
 * (`src/core/**` never imports `src/runtime/**`); the command layer supplies the
 * checkout path, runs the launcher, and probes ports.
 */

import { SLOT_PORT_STRIDE, deriveInstance } from './derive-instance.js';
import { manifest as defaultManifest, type Manifest, type ServiceId } from './manifest/index.js';

/** Pidfile-id prefix: a variant is tracked as `saga-dash@<label>` so `stack down`
 *  reaps it like any service while staying distinct from the primary `saga-dash`. */
export const FRONTEND_ID_PREFIX = 'saga-dash@';

/** Max variants per slot — well beyond real use; guards a runaway registry. */
export const MAX_VARIANTS_PER_SLOT = 9;

/** The pidfile/service id for a variant label. */
export function frontendServiceId(label: string): string {
  return `${FRONTEND_ID_PREFIX}${label}`;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse a `<label>=<path>` arg. Splits on the FIRST `=` (a path may contain `=`).
 * The label must be a bare slug (it becomes a pidfile name + a browser tab key).
 * Throws a user-facing Error on any malformed input.
 */
export function parseVariantArg(raw: string): { label: string; path: string } {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    throw new Error(`expected <label>=<path>, got "${raw}"`);
  }
  const label = raw.slice(0, eq).trim();
  const path = raw.slice(eq + 1).trim();
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `invalid label "${label}" — use letters/digits/_/- (starts alnum), e.g. main=/path/to/saga-dash`,
    );
  }
  if (path === '') {
    throw new Error(`empty path in "${raw}" — expected <label>=<path>`);
  }
  return { label, path };
}

/**
 * Every resolved service port across all slots (0..9). Used to keep an
 * auto-assigned variant port from ever colliding with a stack service — including
 * one that is not up yet but could be brought up later.
 */
export function reservedServicePorts(m: Manifest = defaultManifest): Set<number> {
  const ports = new Set<number>();
  for (let slot = 0; slot <= 9; slot++) {
    const { portOverrides } = deriveInstance({ slot }, m);
    for (const p of Object.values(portOverrides)) {
      if (typeof p === 'number') ports.add(p);
    }
  }
  return ports;
}

/**
 * Ordered candidate ports for a variant at a slot whose dash base is `dashBase`:
 * `dashBase+1 …` up to (but not into) the next slot's band, excluding any
 * `reserved` stack service port and any `occupied` (already-registered) port. The
 * caller probes these in order for the first not-listening one.
 */
export function variantPortCandidates(
  dashBase: number,
  reserved: Set<number>,
  occupied: Set<number>,
): number[] {
  const out: number[] = [];
  for (let p = dashBase + 1; p < dashBase + SLOT_PORT_STRIDE; p++) {
    if (reserved.has(p) || occupied.has(p)) continue;
    out.push(p);
  }
  return out;
}

/** argv for `pnpm dev --port <port>` (no `--` separator, so vite honours it). */
export function variantLaunchArgs(port: number): string[] {
  return ['dev', '--port', String(port)];
}

/** The health URL a variant is polled at (saga-dash healthPath is `/`). */
export function variantHealthUrl(port: number): string {
  return `http://localhost:${port}/`;
}

// `ServiceId` re-exported for the command layer's manifest env lookup.
export type { ServiceId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- frontend-variant --run`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/frontend-variant.ts src/core/__tests__/frontend-variant.unit.test.ts
git commit -m "feat(saga-stack-cli): core helpers for frontend variants (parse/id/ports)"
```

---

### Task 2: Runtime — frontend registry + BaseCommand seam

**Files:**
- Create: `src/runtime/frontend-registry.ts`
- Modify: `src/base-command.ts` (add one `protected getFrontendRegistryIo()` seam next to the other seam getters, e.g. after `getJarWriter` ~line 650)
- Test: `src/runtime/__tests__/frontend-registry.unit.test.ts`

**Interfaces:**
- Produces (from `frontend-registry.ts`):
  - `interface FrontendRecord { label: string; path: string; port: number; pid: number; slot: number }`
  - `type FrontendRegistry = Record<string, FrontendRecord>`
  - `interface FrontendRegistryIo { read(path: string): string | null; write(path: string, contents: string): void; remove(path: string): void }`
  - `makeRealFrontendRegistryIo(): FrontendRegistryIo`
  - `frontendRegistryPath(stateDir: string): string`
  - `readRegistry(stateDir: string, io?: FrontendRegistryIo): FrontendRegistry`
  - `upsertRegistry(stateDir: string, record: FrontendRecord, io?: FrontendRegistryIo): void`
  - `clearRegistry(stateDir: string, io?: FrontendRegistryIo): void`
- Produces (from `base-command.ts`): `protected getFrontendRegistryIo(): FrontendRegistryIo` (default `makeRealFrontendRegistryIo()`).

- [ ] **Step 1: Write the failing test**

Create `src/runtime/__tests__/frontend-registry.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type FrontendRegistryIo,
  clearRegistry,
  frontendRegistryPath,
  readRegistry,
  upsertRegistry,
} from '../frontend-registry.js';

function fakeIo(seed: Record<string, string> = {}): FrontendRegistryIo & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    read: (p) => (p in files ? files[p] : null),
    write: (p, c) => {
      files[p] = c;
    },
    remove: (p) => {
      delete files[p];
    },
  };
}

const SD = '/tmp/sds-synthetic-s1';
const REC = { label: 'main', path: '/home/me/dash', port: 9901, pid: 4242, slot: 1 };

describe('frontend-registry', () => {
  it('path is <stateDir>/frontends.json', () => {
    expect(frontendRegistryPath(SD)).toBe('/tmp/sds-synthetic-s1/frontends.json');
  });

  it('read returns {} when absent or malformed', () => {
    expect(readRegistry(SD, fakeIo())).toEqual({});
    expect(readRegistry(SD, fakeIo({ [frontendRegistryPath(SD)]: 'not json' }))).toEqual({});
  });

  it('upsert writes the record keyed by label; read round-trips', () => {
    const io = fakeIo();
    upsertRegistry(SD, REC, io);
    expect(readRegistry(SD, io)).toEqual({ main: REC });
    // second label merges, doesn't clobber.
    upsertRegistry(SD, { ...REC, label: 'feat', port: 9902 }, io);
    expect(Object.keys(readRegistry(SD, io)).sort()).toEqual(['feat', 'main']);
  });

  it('clear removes the file', () => {
    const io = fakeIo();
    upsertRegistry(SD, REC, io);
    clearRegistry(SD, io);
    expect(readRegistry(SD, io)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- frontend-registry --run`
Expected: FAIL — `Cannot find module '../frontend-registry.js'`.

- [ ] **Step 3: Write the registry module**

Create `src/runtime/frontend-registry.ts`:

```ts
/**
 * frontend-registry — the per-slot record of running `ss frontend` variants.
 *
 * `ss frontend up` upserts `<stateDir>/frontends.json` (label → {path,port,pid,slot})
 * so `ss frontend browser` can resolve a label to its `http://localhost:<port>` URL.
 * `ss stack down` clears it after reaping the `saga-dash@<label>` pidfiles. IO is
 * behind the injectable `FrontendRegistryIo` so the logic is unit-tested with no fs.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One running variant. */
export interface FrontendRecord {
  label: string;
  /** Absolute path to the variant's saga-dash checkout root. */
  path: string;
  port: number;
  pid: number;
  slot: number;
}

/** label → record. */
export type FrontendRegistry = Record<string, FrontendRecord>;

/** Injectable fs surface (defaulted to real `node:fs`). */
export interface FrontendRegistryIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
  remove(path: string): void;
}

/** Production fs surface. */
export function makeRealFrontendRegistryIo(): FrontendRegistryIo {
  return {
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    write: (p, c) => writeFileSync(p, c),
    remove: (p) => rmSync(p, { force: true }),
  };
}

/** Absolute path to a slot's registry file. */
export function frontendRegistryPath(stateDir: string): string {
  return join(stateDir, 'frontends.json');
}

/** Read the registry; `{}` when absent or unparseable (never throws). */
export function readRegistry(
  stateDir: string,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): FrontendRegistry {
  const raw = io.read(frontendRegistryPath(stateDir));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as FrontendRegistry) : {};
  } catch {
    return {};
  }
}

/** Insert/replace one label's record (2-space JSON + trailing newline). */
export function upsertRegistry(
  stateDir: string,
  record: FrontendRecord,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): void {
  const reg = readRegistry(stateDir, io);
  reg[record.label] = record;
  io.write(frontendRegistryPath(stateDir), `${JSON.stringify(reg, null, 2)}\n`);
}

/** Remove the registry file (idempotent). */
export function clearRegistry(
  stateDir: string,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): void {
  io.remove(frontendRegistryPath(stateDir));
}
```

- [ ] **Step 4: Add the BaseCommand seam**

In `src/base-command.ts`, add the import near the other runtime imports (with `COOKIE_JAR_FILE, nativeLogin` ~line 55):

```ts
import { type FrontendRegistryIo, makeRealFrontendRegistryIo } from './runtime/frontend-registry.js';
```

Then add the seam getter next to `getJarWriter()` (~line 650):

```ts
  /** Injectable frontends.json IO (the `ss frontend` registry). Real fs in prod. */
  protected getFrontendRegistryIo(): FrontendRegistryIo {
    return makeRealFrontendRegistryIo();
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test -- frontend-registry --run && pnpm check-types`
Expected: PASS (4 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/frontend-registry.ts src/runtime/__tests__/frontend-registry.unit.test.ts src/base-command.ts
git commit -m "feat(saga-stack-cli): per-slot frontends.json registry + BaseCommand seam"
```

---

### Task 3: `ss frontend up` command

**Files:**
- Create: `src/commands/frontend/up.ts`
- Test: `src/commands/frontend/__tests__/frontend-up.int.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseVariantArg`, `frontendServiceId`, `reservedServicePorts`, `variantPortCandidates`, `variantLaunchArgs`, `variantHealthUrl`, `MAX_VARIANTS_PER_SLOT`); Task 2 (`readRegistry`, `upsertRegistry`, `getFrontendRegistryIo`); `deriveInstance` (`../../core/derive-instance.js`); `getService`, `manifest` (`../../core/manifest/index.js`); `syncDashLocalDefaults` (`../../runtime/dash-defaults.js`); `LaunchSpec` (`../../runtime/index.js`); seams `getLauncher(stateDir)`, `getPortProbe()`, `getRepoDirCheck()`, `getDashFs()`, `scriptContextFromFlags`, `resolveRepoRoot` (`../../runtime/scripts.js`).
- Produces: the `frontend up` command (no exported symbols consumed elsewhere).

- [ ] **Step 1: Write the failing test**

Create `src/commands/frontend/__tests__/frontend-up.int.test.ts`:

```ts
import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { LaunchSpec } from '../../../runtime/index.js';
import type { FrontendRegistryIo } from '../../../runtime/frontend-registry.js';
import FrontendUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];
const VARIANT = '/home/me/dash-feat';

let config: Config;
let launched: LaunchSpec[];
let regFiles: Record<string, string>;
let dashActions: string[];
let logged: string[];

function install(): void {
  launched = [];
  regFiles = {};
  dashActions = [];
  const proto = BaseCommand.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

  vi.spyOn(proto, 'getLauncher').mockReturnValue({
    async launch(spec: LaunchSpec) {
      launched.push(spec);
      return { id: spec.id, ok: true, pid: 5150 };
    },
    async stopServices() {
      return [];
    },
  });
  vi.spyOn(proto, 'getPortProbe').mockReturnValue({
    async dockerHolder() {
      return null;
    },
    async listening() {
      return false; // every probed port is free
    },
  });
  vi.spyOn(proto, 'getRepoDirCheck').mockReturnValue(() => true);
  vi.spyOn(proto, 'getDashFs').mockReturnValue({
    existsDir: () => true,
    existsFile: () => true,
    remove: (p: string) => dashActions.push(`remove ${p}`),
    write: (p: string) => dashActions.push(`write ${p}`),
  });
  const io: FrontendRegistryIo = {
    read: (p) => (p in regFiles ? regFiles[p] : null),
    write: (p, c) => {
      regFiles[p] = c;
    },
    remove: (p) => {
      delete regFiles[p];
    },
  };
  vi.spyOn(proto, 'getFrontendRegistryIo').mockReturnValue(io);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
    logged.push(m ?? '');
  });
  install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ss frontend up', () => {
  it('launches saga-dash@<label> from the variant checkout on an auto port (slot 0)', async () => {
    await FrontendUp.run([`feat=${VARIANT}`, ...WS], config);

    expect(launched).toHaveLength(1);
    const spec = launched[0];
    expect(spec.id).toBe('saga-dash@feat');
    expect(spec.cwd).toBe(join(VARIANT, 'apps', 'web', 'dash'));
    expect(spec.command).toBe('pnpm');
    expect(spec.args).toEqual(['dev', '--port', '8901']); // first free above 8900
    expect(spec.healthUrl).toBe('http://localhost:8901/');
    expect(spec.env).toMatchObject({ VITE_ADS_ADM_REAL: 'true' });

    // slot 0: config.local.json REMOVED in the variant checkout (base-port backend).
    expect(dashActions.some((a) => a.startsWith('remove') && a.includes(VARIANT))).toBe(true);

    // registry recorded under slot-0 state dir.
    const reg = JSON.parse(regFiles['/tmp/sds-synthetic/frontends.json']);
    expect(reg.feat).toMatchObject({ label: 'feat', path: VARIANT, port: 8901, pid: 5150, slot: 0 });
  });

  it('honours --port and targets a non-0 slot (writes offset config)', async () => {
    await FrontendUp.run([`feat=${VARIANT}`, '--port', '8950', '--slot', '1', ...WS], config);
    const spec = launched[0];
    expect(spec.args).toEqual(['dev', '--port', '8950']);
    expect(spec.healthUrl).toBe('http://localhost:8950/');
    // slot > 0: config.local.json WRITTEN (offset-port backend).
    expect(dashActions.some((a) => a.startsWith('write') && a.includes(VARIANT))).toBe(true);
    const reg = JSON.parse(regFiles['/tmp/sds-synthetic-s1/frontends.json']);
    expect(reg.feat).toMatchObject({ port: 8950, slot: 1 });
  });

  it('rejects a duplicate label at the same slot', async () => {
    await FrontendUp.run([`feat=${VARIANT}`, ...WS], config);
    await expect(FrontendUp.run([`feat=/home/me/other`, ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('feat'),
    });
  });

  it('rejects a checkout whose apps/web/dash is missing', async () => {
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (d: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue(() => false);
    await expect(FrontendUp.run([`feat=${VARIANT}`, ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('apps/web/dash'),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- frontend-up --run`
Expected: FAIL — `Cannot find module '../up.js'`.

- [ ] **Step 3: Write the command**

Create `src/commands/frontend/up.ts`:

```ts
/**
 * `ss frontend up <label>=<path> [--port N] [--slot S]` — launch an extra
 * saga-dash dev server (from the caller's checkout) against the stack at slot S.
 *
 * A variant is another launch of the `saga-dash` service via the real launcher
 * with three overrides — a distinct pidfile id (`saga-dash@<label>`), the
 * variant's checkout as cwd, and its own port — so `stack down` reaps it like any
 * service. The `sync-dash-local-defaults` hook wires the variant's config.local.json
 * to slot S's backend (removed at slot 0 → base ports; written at slot > 0). The
 * variant is recorded in `<stateDir>/frontends.json` for `frontend browser`.
 */

import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import {
  MAX_VARIANTS_PER_SLOT,
  frontendServiceId,
  parseVariantArg,
  reservedServicePorts,
  variantHealthUrl,
  variantLaunchArgs,
  variantPortCandidates,
} from '../../core/frontend-variant.js';
import { getService } from '../../core/manifest/index.js';
import { syncDashLocalDefaults } from '../../runtime/dash-defaults.js';
import { readRegistry, upsertRegistry } from '../../runtime/frontend-registry.js';
import { resolveRepoRoot } from '../../runtime/scripts.js';

export default class FrontendUp extends BaseCommand {
  static description =
    'Launch an extra saga-dash version (from a supplied checkout) against the running stack.';

  static examples = [
    '<%= config.bin %> <%= command.id %> feat=/home/me/saga-dash-feat',
    '<%= config.bin %> <%= command.id %> feat=/home/me/saga-dash-feat --port 8950 --slot 1',
  ];

  static args = {
    variant: Args.string({ description: 'label=path (e.g. feat=/home/me/saga-dash-feat)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    port: Flags.integer({ min: 1, description: 'pin the dev-server port (default: auto-assigned)' }),
  };

  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FrontendUp);
    const { label, path: rawPath } = parseVariantArg(args.variant);
    const checkout = resolve(rawPath);

    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const dashBase = profile.portOverrides['saga-dash'] ?? 8900;

    // Validate the checkout has a dash app.
    const dashAppDir = join(checkout, 'apps', 'web', 'dash');
    if (!this.getRepoDirCheck()(dashAppDir)) {
      this.error(`no saga-dash app at ${dashAppDir} — pass the checkout ROOT (…/saga-dash)`);
    }

    // Guard: not the primary checkout, not a dup label/path.
    const primary = resolve(resolveRepoRoot('SAGA_DASH', this.scriptContextFromFlags(flags)));
    if (checkout === primary) {
      this.error(`${checkout} is the primary saga-dash checkout (already the stack's :${dashBase} dash)`);
    }
    const reg = readRegistry(stateDir, this.getFrontendRegistryIo());
    if (reg[label]) {
      this.error(`frontend "${label}" is already running at slot ${flags.slot} (port ${reg[label].port})`);
    }
    if (Object.values(reg).some((r) => resolve(r.path) === checkout)) {
      this.error(`${checkout} is already running under another label at slot ${flags.slot}`);
    }
    if (Object.keys(reg).length >= MAX_VARIANTS_PER_SLOT) {
      this.error(`slot ${flags.slot} already has ${MAX_VARIANTS_PER_SLOT} frontends (the cap)`);
    }

    // Choose the port.
    const probe = this.getPortProbe();
    const occupied = new Set<number>(Object.values(reg).map((r) => r.port));
    let port: number;
    if (flags.port !== undefined) {
      if (occupied.has(flags.port) || (await probe.listening(flags.port))) {
        this.error(`port ${flags.port} is already in use`);
      }
      port = flags.port;
    } else {
      port = 0;
      for (const cand of variantPortCandidates(dashBase, reservedServicePorts(), occupied)) {
        if (!(await probe.listening(cand))) {
          port = cand;
          break;
        }
      }
      if (port === 0) this.error(`no free port found in slot ${flags.slot}'s band`);
    }

    // Wire the variant's backend config for slot S (removed at slot 0, written at slot > 0).
    syncDashLocalDefaults(
      { sagaDashRoot: checkout, tunnel: false, slot: flags.slot, stackPorts: profile.portOverrides },
      this.getDashFs(),
    );

    // Launch it as saga-dash@<label>.
    const id = frontendServiceId(label);
    const res = await this.getLauncher(stateDir).launch({
      id,
      cwd: dashAppDir,
      command: 'pnpm',
      args: variantLaunchArgs(port),
      env: { ...getService('saga-dash').launch.env },
      healthUrl: variantHealthUrl(port),
    });

    upsertRegistry(
      stateDir,
      { label, path: checkout, port, pid: res.pid ?? 0, slot: flags.slot },
      this.getFrontendRegistryIo(),
    );

    this.emit(
      flags,
      { id, label, path: checkout, port, slot: flags.slot, ok: res.ok, pid: res.pid ?? null },
      [
        `${res.ok ? '✓' : '⚠'} frontend "${label}" → http://localhost:${port} (${id}, slot ${flags.slot})`,
        `  open it: ss frontend browser ${label}${flags.slot ? ` --slot ${flags.slot}` : ''}`,
      ],
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- frontend-up --run`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm check-types`
Expected: no errors. (`getService('saga-dash').launch.env`, the `LaunchResult.pid`, and the `PortProbe` shape all type-check.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/frontend/up.ts src/commands/frontend/__tests__/frontend-up.int.test.ts
git commit -m "feat(saga-stack-cli): ss frontend up — launch an extra saga-dash against the stack"
```

---

### Task 4: Multi-URL browser (vendored script + BaseCommand seam)

**Files:**
- Modify: `vendor/browser-login.mjs` (the env-doc comment ~lines 17-23; the single-`goto` block ~lines 96-101)
- Modify: `src/base-command.ts` (add `protected async openFrontendBrowser(...)` next to `openVendoredBrowser` ~line 1019)
- Test: `src/commands/stack/__tests__/browser-login-lockstep.unit.test.ts` already pins the devLogin payload — no change needed; add a small assertion file for the multi-URL contract via the command in Task 5. (No test in this task; the vendored change is covered by Task 5's env-contract test + the existing lockstep pin.)

**Interfaces:**
- Produces: `BaseCommand.openFrontendBrowser(flags: WorkspaceFlags, ctx: { iamUrl: string; stateDir: string; urls: string[]; email: string }): Promise<void>` — opens ONE Chromium (profile `<stateDir>/frontend-browser-profile`), one devLogin, one tab per url.

- [ ] **Step 1: Extend the vendored script's env doc**

In `vendor/browser-login.mjs`, add a line to the `Env in:` block after the `DASH_URL` line (~line 19):

```js
//   DASH_URLS        comma-separated dash bases → one TAB each (overrides DASH_URL)
```

- [ ] **Step 2: Open one tab per URL**

Replace the single-goto block (currently lines 96-101):

```js
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(DASH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
// Give the dash's tRPC auth probe a moment, then report where we ended up so a
// lingering Janus redirect is visible in the log.
await page.waitForTimeout(1500);
const finalUrl = page.url();
```

with:

```js
// DASH_URLS (comma-separated) opens one TAB per url in this ONE logged-in profile
// (frontend-compare mode); an unset DASH_URLS keeps the original single-tab flow.
const urls = (process.env.DASH_URLS || DASH_URL)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
let firstPage;
for (let i = 0; i < urls.length; i++) {
  const page = i === 0 ? (ctx.pages()[0] ?? (await ctx.newPage())) : await ctx.newPage();
  if (i === 0) firstPage = page;
  await page.goto(urls[i], { waitUntil: 'domcontentloaded' }).catch(() => {});
}
// Give the dash's tRPC auth probe a moment, then report where we ended up so a
// lingering Janus redirect is visible in the log.
await firstPage.waitForTimeout(1500);
const finalUrl = firstPage.url();
```

(Unset `DASH_URLS` ⇒ `urls = [DASH_URL]` ⇒ byte-identical single-tab behavior; the `identifier: EMAIL` devLogin body is untouched, so the lockstep pin stays green.)

- [ ] **Step 3: Add the `openFrontendBrowser` seam**

In `src/base-command.ts`, immediately after `openVendoredBrowser` (~line 1019), add:

```ts
  /**
   * Open ONE Chromium with a tab per url (`ss frontend browser`) — a single
   * devLogin against `ctx.iamUrl`, a dedicated per-slot profile
   * (`<stateDir>/frontend-browser-profile`, distinct from `stack login --browser`'s
   * to avoid Chrome's singleton lock), and `DASH_URLS` (one tab each). Reuses the
   * vendored browser-login.mjs + saga-dash playwright resolution. Best-effort: a
   * browser failure warns, never throws.
   */
  protected async openFrontendBrowser(
    flags: WorkspaceFlags,
    ctx: { iamUrl: string; stateDir: string; urls: string[]; email: string },
  ): Promise<void> {
    const script = resolveVendorScript('browser-login.mjs');
    const sagaDashDash = join(
      resolveRepoRoot('SAGA_DASH', this.scriptContextFromFlags(flags)),
      'apps',
      'web',
      'dash',
    );
    if (!this.getRepoDirCheck()(sagaDashDash)) {
      this.warn(
        `frontend browser skipped — saga-dash dash app not found at ${sagaDashDash} ` +
          '(playwright resolves from there; clone saga-dash for the browser step)',
      );
      return;
    }
    const env: Record<string, string> = {
      IAM_URL: ctx.iamUrl,
      DASH_URLS: ctx.urls.join(','),
      LOGIN_EMAIL: ctx.email,
      PROFILE_DIR: join(ctx.stateDir, 'frontend-browser-profile'),
      SAGA_DASH_DASH: sagaDashDash,
    };
    try {
      await this.runVendor({ cwd: sagaDashDash, command: 'node', args: [script], env }, flags, {
        propagateExit: false,
      });
    } catch (err) {
      this.warn(`frontend browser skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

- [ ] **Step 4: Verify the existing lockstep test + typecheck still pass**

Run: `pnpm test -- browser-login-lockstep --run && pnpm check-types`
Expected: PASS (the devLogin payload is unchanged); no type errors.

- [ ] **Step 5: Commit**

```bash
git add vendor/browser-login.mjs src/base-command.ts
git commit -m "feat(saga-stack-cli): multi-URL browser (DASH_URLS) + openFrontendBrowser seam"
```

---

### Task 5: `ss frontend browser` command

**Files:**
- Create: `src/commands/frontend/browser.ts`
- Test: `src/commands/frontend/__tests__/frontend-browser.int.test.ts`

**Interfaces:**
- Consumes: Task 2 (`readRegistry`, `getFrontendRegistryIo`); Task 4 (`openFrontendBrowser`); `deriveInstance` (`../../core/derive-instance.js`); `resolveIamUrl`, `DEFAULT_LOGIN_USER` (`../../core/login.js`).
- Produces: the `frontend browser` command.

- [ ] **Step 1: Write the failing test**

Create `src/commands/frontend/__tests__/frontend-browser.int.test.ts`:

```ts
import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { FrontendRegistryIo } from '../../../runtime/frontend-registry.js';
import { frontendRegistryPath, upsertRegistry } from '../../../runtime/frontend-registry.js';
import FrontendBrowser from '../browser.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;
let opened: { flags: unknown; ctx: { iamUrl: string; stateDir: string; urls: string[]; email: string } }[];
let regFiles: Record<string, string>;

function io(): FrontendRegistryIo {
  return {
    read: (p) => (p in regFiles ? regFiles[p] : null),
    write: (p, c) => {
      regFiles[p] = c;
    },
    remove: (p) => {
      delete regFiles[p];
    },
  };
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  opened = [];
  regFiles = {};
  const proto = BaseCommand.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  vi.spyOn(proto, 'getFrontendRegistryIo').mockReturnValue(io());
  vi.spyOn(proto, 'openFrontendBrowser').mockImplementation(async (flags: unknown, ctx: never) => {
    opened.push({ flags, ctx });
  });
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  // seed two slot-0 variants.
  upsertRegistry('/tmp/sds-synthetic', { label: 'main', path: '/a', port: 8901, pid: 1, slot: 0 }, io());
  upsertRegistry('/tmp/sds-synthetic', { label: 'feat', path: '/b', port: 8902, pid: 2, slot: 0 }, io());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ss frontend browser', () => {
  it('no labels → opens all slot-0 variants as tabs (one login, slot-0 iam)', async () => {
    await FrontendBrowser.run([...WS], config);
    expect(opened).toHaveLength(1);
    expect(opened[0].ctx.urls.sort()).toEqual(['http://localhost:8901', 'http://localhost:8902']);
    expect(opened[0].ctx.iamUrl).toBe('http://localhost:3010');
    expect(opened[0].ctx.stateDir).toBe('/tmp/sds-synthetic');
  });

  it('primary + one label opens the stack dash and the variant', async () => {
    await FrontendBrowser.run(['primary,feat', ...WS], config);
    expect(opened[0].ctx.urls).toEqual(['http://localhost:8900', 'http://localhost:8902']);
  });

  it('errors on an unknown label', async () => {
    await expect(FrontendBrowser.run(['nope', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('nope'),
    });
  });

  it('errors when there is nothing to open', async () => {
    regFiles = {}; // empty registry, no labels
    await expect(FrontendBrowser.run([...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('no frontends'),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- frontend-browser --run`
Expected: FAIL — `Cannot find module '../browser.js'`.

- [ ] **Step 3: Write the command**

Create `src/commands/frontend/browser.ts`:

```ts
/**
 * `ss frontend browser [<label>[,<label2>…]] [--slot S]` — open the slot-S
 * frontends as tabs in ONE logged-in browser.
 *
 * No labels ⇒ every running variant at slot S. The special label `primary` maps
 * to the stack's own dash (`dashBase`). SINGLE-SLOT INVARIANT: all tabs share one
 * profile + one devLogin, so every requested label must be at slot S (one backend
 * ⇒ one iam ⇒ one login). Delegates the open to `openFrontendBrowser`.
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { DEFAULT_LOGIN_USER, resolveIamUrl } from '../../core/login.js';
import { readRegistry } from '../../runtime/frontend-registry.js';

export default class FrontendBrowser extends BaseCommand {
  static description = 'Open one or more frontend variants (of one slot) as tabs in a single logged-in browser.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> primary,feat',
    '<%= config.bin %> <%= command.id %> feat --slot 1',
  ];

  static args = {
    labels: Args.string({ description: 'comma-separated labels (default: all at this slot; `primary` = the stack dash)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FrontendBrowser);
    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const dashBase = profile.portOverrides['saga-dash'] ?? 8900;
    const reg = readRegistry(stateDir, this.getFrontendRegistryIo());

    const requested = args.labels
      ? args.labels.split(',').map((l) => l.trim()).filter(Boolean)
      : Object.keys(reg);

    const urls: string[] = [];
    for (const label of requested) {
      if (label === 'primary') {
        urls.push(`http://localhost:${dashBase}`);
        continue;
      }
      const rec = reg[label];
      if (!rec) {
        this.error(
          `no frontend "${label}" at slot ${flags.slot} — run \`ss frontend up ${label}=<path>${
            flags.slot ? ` --slot ${flags.slot}` : ''
          }\` first`,
        );
      }
      urls.push(`http://localhost:${rec.port}`);
    }

    if (urls.length === 0) {
      this.error(
        `no frontends to open at slot ${flags.slot} — run \`ss frontend up <label>=<path>\` first, or pass \`primary\``,
      );
    }

    this.emit(flags, { slot: flags.slot, urls }, [
      `opening ${urls.length} tab(s) in one logged-in browser (slot ${flags.slot}): ${urls.join(', ')}`,
    ]);

    await this.openFrontendBrowser(flags, {
      iamUrl: resolveIamUrl({ slot: flags.slot, loginIamUrl: process.env.LOGIN_IAM_URL }),
      stateDir,
      urls,
      email: DEFAULT_LOGIN_USER,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- frontend-browser --run`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm check-types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/frontend/browser.ts src/commands/frontend/__tests__/frontend-browser.int.test.ts
git commit -m "feat(saga-stack-cli): ss frontend browser — open variants as tabs in one browser"
```

---

### Task 6: `stack down` clears the registry + `frontend` topic + manifest

**Files:**
- Modify: `src/commands/stack/down.ts` (after the stopper call ~line 85)
- Modify: `package.json` (add the `frontend` topic to the `oclif.topics` map)
- Modify (generated): `oclif.manifest.json` (via `pnpm build`)
- Test: `src/commands/stack/__tests__/down-frontends.int.test.ts`

**Interfaces:**
- Consumes: Task 2 (`clearRegistry`, `getFrontendRegistryIo`).

- [ ] **Step 1: Write the failing test**

Create `src/commands/stack/__tests__/down-frontends.int.test.ts`:

```ts
import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { FrontendRegistryIo } from '../../../runtime/frontend-registry.js';
import { frontendRegistryPath } from '../../../runtime/frontend-registry.js';
import StackDown from '../down.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;
let regFiles: Record<string, string>;

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  regFiles = { [frontendRegistryPath('/tmp/sds-synthetic')]: '{"feat":{}}' };
  const proto = BaseCommand.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  vi.spyOn(proto, 'getServiceStopper').mockReturnValue(async () => []);
  const io: FrontendRegistryIo = {
    read: (p) => (p in regFiles ? regFiles[p] : null),
    write: (p, c) => {
      regFiles[p] = c;
    },
    remove: (p) => {
      delete regFiles[p];
    },
  };
  vi.spyOn(proto, 'getFrontendRegistryIo').mockReturnValue(io);
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack down clears the frontend registry', () => {
  it('removes <stateDir>/frontends.json after reaping', async () => {
    await StackDown.run([...WS], config);
    expect(regFiles[frontendRegistryPath('/tmp/sds-synthetic')]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- down-frontends --run`
Expected: FAIL — `frontends.json` is still present (down does not clear it yet).

- [ ] **Step 3: Clear the registry in `down.ts`**

In `src/commands/stack/down.ts`, add the import near the top with the other runtime imports:

```ts
import { clearRegistry } from '../../runtime/frontend-registry.js';
```

Then, immediately after `this.reportStopped(profile, stateDir, stopped);` (~line 86), add:

```ts
    // `ss frontend` variants were reaped above (their `saga-dash@<label>.pid` files
    // live under this state dir); clear the now-stale registry so `frontend browser`
    // doesn't point at dead ports.
    clearRegistry(stateDir, this.getFrontendRegistryIo());
```

- [ ] **Step 4: Add the `frontend` topic**

In `package.json`, add to the `oclif.topics` map (alongside `stack`, `e2e`, `set`):

```json
    "frontend": { "description": "Run extra saga-dash versions against one stack (compare frontends)." }
```

- [ ] **Step 5: Regenerate the manifest + full gate**

Run: `pnpm build`
Expected: `tsc` + `oclif manifest` succeed; `oclif.manifest.json` now lists `frontend up` and `frontend browser`.

Verify: `grep -c '"frontend up"' oclif.manifest.json; grep -c '"frontend browser"' oclif.manifest.json`
Expected: each `1`.

Run: `pnpm test`
Expected: PASS (whole package, incl. `down-frontends`).

- [ ] **Step 6: Commit**

```bash
git add src/commands/stack/down.ts src/commands/stack/__tests__/down-frontends.int.test.ts package.json oclif.manifest.json
git commit -m "feat(saga-stack-cli): stack down clears frontends.json; register frontend topic"
```

---

### Task 7: End-to-end verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full local gate**

From `packages/node/saga-stack-cli`:

Run: `pnpm test && pnpm check-types && pnpm lint`
Expected: all pass (~85 pre-existing lint warnings are OK; 0 errors).

- [ ] **Step 2: Zero-build help smoke**

Run: `node bin/dev.js frontend --help`
Expected: lists `frontend up` and `frontend browser` under the topic description.

Run: `node bin/dev.js frontend up --help`
Expected: shows the `<label>=<path>` arg, `--port`, `--slot`.

- [ ] **Step 3: (Optional, needs Docker + a running stack) real smoke**

```bash
ss stack up
ss frontend up feat=/path/to/saga-dash-feature-branch     # → http://localhost:8901
ss frontend browser primary,feat                          # one browser, two tabs, one login
ss stack down                                             # reaps saga-dash@feat, clears frontends.json
```

Environmental; not required to land. Reflects the change only after merge (global `ss` runs the main checkout) — until then use the worktree's `bin/dev.js`.

---

## Self-Review

**1. Spec coverage:**
- `ss frontend up <label>=<path> [--port] [--slot]` → Task 3. ✓
- `ss frontend browser [labels] [--slot]`, `primary` includable, single-slot invariant → Task 5. ✓
- Reuse launcher + prelaunch hook, id `saga-dash@<label>` → Task 3. ✓
- Per-slot registry (`frontends.json`) → Task 2 + Task 3 (write) + Task 5 (read) + Task 6 (clear). ✓
- Backend targeting/config wiring per slot (removed at 0, written at >0) → Task 3 (asserted both). ✓
- Port auto-assign from `dashBase+1`, band-capped, skips reserved, `--port` override → Task 1 (pure) + Task 3 (probe). ✓
- Browser: one profile, one devLogin, tab per URL, dedicated `frontend-browser-profile` → Task 4 + Task 5. ✓
- Teardown via `stack down` (pidfile reap is automatic; registry cleared) → Task 6. ✓
- Constraints: distinct checkouts / dup label / occupied port / missing dash app / cross-slot (unknown label errors) → Task 3 + Task 5. ✓
- Testing through injectable seams, no real vite/browser → every task. ✓
- oclif topic + manifest regen → Task 6. ✓

**2. Placeholder scan:** none — every code/test/command step is complete.

**3. Type consistency:** `frontendServiceId`/`parseVariantArg`/`variantPortCandidates`/`variantLaunchArgs`/`variantHealthUrl`/`reservedServicePorts` (Task 1) are used with the same signatures in Task 3. `FrontendRecord`/`readRegistry`/`upsertRegistry`/`clearRegistry`/`FrontendRegistryIo`/`getFrontendRegistryIo` (Task 2) are consumed unchanged in Tasks 3/5/6. `openFrontendBrowser(flags, {iamUrl,stateDir,urls,email})` (Task 4) matches its call in Task 5. `LaunchSpec` fields (`id/cwd/command/args/env/healthUrl`) match `runtime/launcher.ts`. Consistent.
