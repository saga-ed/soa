/**
 * Script-path resolution — precedence + guard coverage (plan §7.2 M1/M2).
 *
 * Pins the `--<repo>`/`$<REPO>`/`<dev>/<defaultDir>` and `--dev`/`$DEV`/`$HOME/dev`
 * precedence and the script-directory cwd, and that `resolveScript` throws on a
 * missing file. Generalized in M2: a script is named by a `ScriptLocator`
 * (`{ repo, relPath }`), so resolution works for ANY sibling repo — exercised
 * here for both SOA (synthetic-dev) and SAGA_DASH (e2e). No process is spawned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScriptLocator } from '../../core/flag-map.js';
import { resolveDevRoot, resolveRepoRoot, resolveScript, scriptCwd } from '../scripts.js';

const ENV_KEYS = ['DEV', 'SOA', 'SAGA_DASH', 'HOME'] as const;
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

const UP: ScriptLocator = { repo: 'SOA', relPath: 'tools/synthetic-dev/up.sh' };

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

describe('resolveRepoRoot', () => {
  it('prefers the repoRoots pin, then $<REPO>, then <dev>/<defaultDir>', () => {
    expect(resolveRepoRoot('SOA', { repoRoots: { SOA: '/flag/soa' } })).toBe('/flag/soa');
    process.env.SOA = '/env/soa';
    expect(resolveRepoRoot('SOA')).toBe('/env/soa');
    delete process.env.SOA;
    expect(resolveRepoRoot('SOA', { dev: '/d' })).toBe('/d/soa');
  });

  it('uses up.sh default checkout dir names (SDS → student-data-system, SAGA_DASH → saga-dash)', () => {
    expect(resolveRepoRoot('SDS', { dev: '/d' })).toBe('/d/student-data-system');
    expect(resolveRepoRoot('SAGA_DASH', { dev: '/d' })).toBe('/d/saga-dash');
    expect(resolveRepoRoot('PROGRAM_HUB', { dev: '/d' })).toBe('/d/program-hub');
  });

  it('a per-repo pin overrides the env var', () => {
    process.env.SAGA_DASH = '/env/dash';
    expect(resolveRepoRoot('SAGA_DASH', { repoRoots: { SAGA_DASH: '/flag/dash' } })).toBe(
      '/flag/dash',
    );
  });
});

describe('scriptCwd', () => {
  it('is the located script’s own directory (synthetic-dev for an SOA up.sh)', () => {
    expect(scriptCwd(UP, { repoRoots: { SOA: '/x/soa' } })).toBe('/x/soa/tools/synthetic-dev');
  });

  it('resolves a SAGA_DASH e2e script dir', () => {
    const check: ScriptLocator = { repo: 'SAGA_DASH', relPath: 'apps/web/dash/e2e/check-e2e.sh' };
    expect(scriptCwd(check, { repoRoots: { SAGA_DASH: '/y/dash' } })).toBe(
      '/y/dash/apps/web/dash/e2e',
    );
  });
});

describe('resolveScript', () => {
  it('returns the absolute path when the script exists', () => {
    // Point at the real soa checkout (read-only; the script is NOT executed).
    const soa = saved.SOA ?? `${saved.HOME ?? ''}/dev/soa`;
    const path = resolveScript(UP, { repoRoots: { SOA: soa } });
    expect(path).toBe(`${soa}/tools/synthetic-dev/up.sh`);
  });

  it('throws a pointed error (naming the relPath + repo) when the script is missing', () => {
    expect(() => resolveScript(UP, { repoRoots: { SOA: '/no/such/soa' } })).toThrow(
      /could not find tools\/synthetic-dev\/up\.sh/,
    );
  });
});
