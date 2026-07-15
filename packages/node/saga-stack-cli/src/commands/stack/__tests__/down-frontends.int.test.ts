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
