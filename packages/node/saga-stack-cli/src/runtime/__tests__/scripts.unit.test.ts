/**
 * Script-path resolution — precedence + guard coverage (plan §7.2 M1).
 *
 * Pins the `--soa`/`$SOA`/`<dev>/soa` and `--dev`/`$DEV`/`$HOME/dev` precedence
 * and the synthetic-dev cwd, and that `resolveScript` throws on a missing file.
 * No process is spawned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDevRoot, resolveScript, resolveSoaRoot, scriptCwd } from '../scripts.js';

const ENV_KEYS = ['DEV', 'SOA', 'HOME'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveDevRoot', () => {
  it('prefers --dev, then $DEV, then $HOME/dev', () => {
    expect(resolveDevRoot({ dev: '/flag/dev' })).toBe('/flag/dev');
    process.env.DEV = '/env/dev';
    expect(resolveDevRoot()).toBe('/env/dev');
    delete process.env.DEV;
    process.env.HOME = '/home/me';
    expect(resolveDevRoot()).toBe('/home/me/dev');
  });
});

describe('resolveSoaRoot', () => {
  it('prefers --soa, then $SOA, then <dev>/soa', () => {
    expect(resolveSoaRoot({ soa: '/flag/soa' })).toBe('/flag/soa');
    process.env.SOA = '/env/soa';
    expect(resolveSoaRoot()).toBe('/env/soa');
    delete process.env.SOA;
    expect(resolveSoaRoot({ dev: '/d' })).toBe('/d/soa');
  });
});

describe('scriptCwd', () => {
  it('is <soaRoot>/tools/synthetic-dev', () => {
    expect(scriptCwd({ soa: '/x/soa' })).toBe('/x/soa/tools/synthetic-dev');
  });
});

describe('resolveScript', () => {
  it('returns the absolute path when the script exists', () => {
    // Point at the real soa checkout (read-only; the script is NOT executed).
    const soa = saved.SOA ?? `${saved.HOME ?? ''}/dev/soa`;
    const path = resolveScript('up.sh', { soa });
    expect(path).toBe(`${soa}/tools/synthetic-dev/up.sh`);
  });

  it('throws a pointed error when the script is missing', () => {
    expect(() => resolveScript('up.sh', { soa: '/no/such/soa' })).toThrow(/could not find up\.sh/);
  });
});
