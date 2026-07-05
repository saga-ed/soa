/**
 * Flow-discovery candidate paths (plan §5.3): `--spa-path`/$SAGA_E2E_SPA_PATHS
 * entries are files when they name ANY `*.json` (`my-flows.json` works as-is —
 * the documented `--spa-path <file-or-dir>` contract; previously only a
 * basename of exactly `flows.json` counted and anything else was silently
 * treated as a directory), else dirs that get `flows.json` appended. Overrides
 * come FIRST, then the repo-derived default.
 */

import { describe, expect, it } from 'vitest';
import { flowsCandidatePaths, splitSpaPaths } from '../discover.js';
import type { SpaDescriptor } from '../types.js';

const SPA: SpaDescriptor = {
  id: 'saga-dash',
  system: 'saga-dash',
  repoEnvVar: 'SAGA_DASH',
  defaultRepoSubpath: 'saga-dash',
  appDir: 'apps/web/dash',
  e2eDir: 'apps/web/dash/e2e',
  playwrightConfig: 'playwright.stack.config.ts',
};

const ENV = { SAGA_DASH: '/repo/saga-dash' };

describe('flowsCandidatePaths — file-vs-dir normalization', () => {
  it('any *.json entry is used as a FILE verbatim (my-flows.json, not just flows.json)', () => {
    const paths = flowsCandidatePaths({ spa: SPA, env: ENV, extraPaths: ['/tmp/my-flows.json'] });
    expect(paths[0]).toBe('/tmp/my-flows.json');
  });

  it('a plain flows.json entry stays verbatim too', () => {
    const paths = flowsCandidatePaths({ spa: SPA, env: ENV, extraPaths: ['/tmp/flows.json'] });
    expect(paths[0]).toBe('/tmp/flows.json');
  });

  it('a directory entry gets flows.json appended', () => {
    const paths = flowsCandidatePaths({ spa: SPA, env: ENV, extraPaths: ['/tmp/somedir'] });
    expect(paths[0]).toBe('/tmp/somedir/flows.json');
  });

  it('overrides come before the repo-derived default', () => {
    const paths = flowsCandidatePaths({ spa: SPA, env: ENV, extraPaths: ['/tmp/a.json'] });
    expect(paths[0]).toBe('/tmp/a.json');
    expect(paths[1]).toBe('/repo/saga-dash/apps/web/dash/e2e/flows.json');
  });

  it('splitSpaPaths splits PATH-style and drops empties', () => {
    expect(splitSpaPaths('/a:/b.json::  ')).toEqual(['/a', '/b.json']);
    expect(splitSpaPaths(undefined)).toEqual([]);
  });
});
