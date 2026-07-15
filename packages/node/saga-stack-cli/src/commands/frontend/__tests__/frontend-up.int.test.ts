import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { MAX_VARIANTS_PER_SLOT } from '../../../core/frontend-variant.js';
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

  it('rejects the primary saga-dash checkout', async () => {
    const primary = join(DEV_ROOT, 'saga-dash'); // resolveRepoRoot('SAGA_DASH', …) default under --dev
    await expect(FrontendUp.run([`feat=${primary}`, ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('primary saga-dash checkout'),
    });
  });

  it('rejects an explicit --port that is already in use', async () => {
    vi.spyOn(
      BaseCommand.prototype as unknown as {
        getPortProbe: () => { dockerHolder: () => Promise<null>; listening: (p: number) => Promise<boolean> };
      },
      'getPortProbe',
    ).mockReturnValue({
      async dockerHolder() {
        return null;
      },
      async listening() {
        return true; // every probed port reports "in use"
      },
    });
    await expect(FrontendUp.run([`feat=${VARIANT}`, '--port', '8950', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('port 8950 is already in use'),
    });
  });

  it('rejects once slot 0 is at the MAX_VARIANTS_PER_SLOT cap', async () => {
    const reg: Record<string, { label: string; path: string; port: number; pid: number; slot: number }> = {};
    for (let i = 0; i < MAX_VARIANTS_PER_SLOT; i += 1) {
      reg[`v${i}`] = { label: `v${i}`, path: `/home/me/dash-v${i}`, port: 8901 + i, pid: 1000 + i, slot: 0 };
    }
    regFiles['/tmp/sds-synthetic/frontends.json'] = JSON.stringify(reg);
    await expect(FrontendUp.run([`feat=${VARIANT}`, ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining(`${MAX_VARIANTS_PER_SLOT}`),
    });
  });
});
