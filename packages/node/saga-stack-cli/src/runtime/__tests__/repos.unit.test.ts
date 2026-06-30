/**
 * Sibling-repo → env mapping (plan §7.2 M1).
 *
 * Asserts the EXACT env var names up.sh reads, and the "set only what the user
 * pinned" rule — everything else is left for up.sh's own `${VAR:-$DEV/<repo>}`
 * defaulting.
 */

import { describe, expect, it } from 'vitest';
import { REPO_ENV_VAR, buildRepoEnv } from '../repos.js';

describe('REPO_ENV_VAR', () => {
  it('maps each --<repo> flag to up.sh\'s env var name', () => {
    expect(REPO_ENV_VAR).toEqual({
      soa: 'SOA',
      rostering: 'ROSTERING',
      'program-hub': 'PROGRAM_HUB',
      'saga-dash': 'SAGA_DASH',
      sds: 'SDS',
      qboard: 'QBOARD',
      rtsm: 'RTSM',
      fleek: 'FLEEK',
    });
  });
});

describe('buildRepoEnv', () => {
  it('is empty when nothing is overridden (up.sh defaults everything)', () => {
    expect(buildRepoEnv()).toEqual({});
    expect(buildRepoEnv({})).toEqual({});
  });

  it('sets DEV only when --dev is provided (--dev /d => DEV=/d)', () => {
    expect(buildRepoEnv({ dev: '/w/dev' })).toEqual({ DEV: '/w/dev' });
    expect(buildRepoEnv({ dev: '/d' })).toEqual({ DEV: '/d' });
  });

  it('--rostering /x => ROSTERING=/x; --dev untouched repos stay unset', () => {
    expect(buildRepoEnv({ rostering: '/x' })).toEqual({ ROSTERING: '/x' });
  });

  it('maps every repo key to its up.sh env var (one override per repo)', () => {
    expect(buildRepoEnv({ soa: '/p/soa' })).toEqual({ SOA: '/p/soa' });
    expect(buildRepoEnv({ 'program-hub': '/p/ph' })).toEqual({ PROGRAM_HUB: '/p/ph' });
    expect(buildRepoEnv({ 'saga-dash': '/p/dash' })).toEqual({ SAGA_DASH: '/p/dash' });
    expect(buildRepoEnv({ sds: '/p/sds' })).toEqual({ SDS: '/p/sds' });
    expect(buildRepoEnv({ qboard: '/p/qb' })).toEqual({ QBOARD: '/p/qb' });
    expect(buildRepoEnv({ rtsm: '/p/rtsm' })).toEqual({ RTSM: '/p/rtsm' });
    expect(buildRepoEnv({ fleek: '/p/fleek' })).toEqual({ FLEEK: '/p/fleek' });
  });

  it('sets only the pinned repos, using up.sh env var names', () => {
    expect(
      buildRepoEnv({ dev: '/w/dev', rostering: '/alt/rostering', 'program-hub': '/alt/ph' }),
    ).toEqual({
      DEV: '/w/dev',
      ROSTERING: '/alt/rostering',
      PROGRAM_HUB: '/alt/ph',
    });
  });

  it('ignores empty-string overrides (treated as unset)', () => {
    expect(buildRepoEnv({ dev: '', sds: '' })).toEqual({});
  });
});
