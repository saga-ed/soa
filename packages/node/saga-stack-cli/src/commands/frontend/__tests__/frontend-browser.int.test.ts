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
