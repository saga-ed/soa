/**
 * Worktree-sets pure layer (M13-A): schema validation rules (plan §1.2),
 * name resolution, and the parse-choke-point flag injection with its four
 * precedence rungs (plan §2.3 — 'the one subtle bit').
 */

import { describe, expect, it } from 'vitest';
import {
  SET_REPO_KEYS,
  applySetToFlags,
  emptyWorktreeSetsFile,
  nearestRepoKey,
  parseWorktreeSetsFile,
  resolveSet,
} from '../worktree-sets.js';
import type { SetInjectableFlags, WorktreeSet } from '../worktree-sets.js';
import { REPO_ENV_VAR } from '../../../runtime/repos.js';

const VALID = {
  version: 1,
  sets: {
    'journey-fix': {
      slot: 1,
      repos: {
        'saga-dash': '~/dev/worktrees/saga-dash-journey',
        rostering: { path: '/abs/rostering-a', createdBy: 'ss', createdFrom: 'feat/a' },
      },
      note: 'PR #345',
    },
    topology: {
      slot: 2,
      repos: { 'saga-dash': '/abs/saga-dash-topology' },
    },
  },
};

describe('parseWorktreeSetsFile', () => {
  it('parses a valid file, normalizing bare-string entries to {path}', () => {
    const file = parseWorktreeSetsFile(VALID);
    expect(Object.keys(file.sets)).toEqual(['journey-fix', 'topology']);
    const jf = file.sets['journey-fix']!;
    expect(jf.name).toBe('journey-fix');
    expect(jf.slot).toBe(1);
    expect(jf.note).toBe('PR #345');
    expect(jf.repos['saga-dash']).toEqual({ path: '~/dev/worktrees/saga-dash-journey' });
    expect(jf.repos.rostering).toEqual({ path: '/abs/rostering-a', createdBy: 'ss', createdFrom: 'feat/a' });
  });

  it('rejects an unknown repo key with a did-you-mean hint', () => {
    const bad = { version: 1, sets: { x: { slot: 1, repos: { 'saga-dashh': '/p' } } } };
    expect(() => parseWorktreeSetsFile(bad)).toThrow(/unknown repo key 'saga-dashh'.*did you mean\s+'saga-dash'/s);
  });

  it('rejects slot 0 (reserved for the baseline)', () => {
    const bad = { version: 1, sets: { x: { slot: 0, repos: {} } } };
    expect(() => parseWorktreeSetsFile(bad)).toThrow(/slot 0 is reserved/);
  });

  it('rejects slot 10 (ceiling 9)', () => {
    const bad = { version: 1, sets: { x: { slot: 10, repos: {} } } };
    expect(() => parseWorktreeSetsFile(bad)).toThrow(/ceiling is 9/);
  });

  it('rejects two sets on one slot, naming both', () => {
    const bad = {
      version: 1,
      sets: { a: { slot: 3, repos: {} }, b: { slot: 3, repos: {} } },
    };
    expect(() => parseWorktreeSetsFile(bad)).toThrow(/'a' and 'b' both declare slot 3/);
  });

  it('rejects an unknown version', () => {
    expect(() => parseWorktreeSetsFile({ version: 2, sets: {} })).toThrow(/invalid sets file/);
  });

  it('tolerates unknown top-level keys (forward-compat)', () => {
    const file = parseWorktreeSetsFile({ version: 1, sets: {}, futureKnob: true });
    expect(file.sets).toEqual({});
  });
});

describe('SET_REPO_KEYS lockstep', () => {
  it('matches the runtime REPO_ENV_VAR kebab keys exactly (core cannot import runtime)', () => {
    expect([...SET_REPO_KEYS].sort()).toEqual(Object.keys(REPO_ENV_VAR).sort());
  });

  it('nearestRepoKey suggests the closest known key', () => {
    expect(nearestRepoKey('saga-dashh')).toBe('saga-dash');
    expect(nearestRepoKey('rosterin')).toBe('rostering');
  });
});

describe('resolveSet', () => {
  it('resolves a known set', () => {
    const file = parseWorktreeSetsFile(VALID);
    expect(resolveSet(file, 'topology').slot).toBe(2);
  });

  it('lists the known names on an unknown set', () => {
    const file = parseWorktreeSetsFile(VALID);
    expect(() => resolveSet(file, 'nope')).toThrow(/unknown set 'nope'.*journey-fix, topology/s);
  });

  it('points at the file convention when no sets exist at all', () => {
    expect(() => resolveSet(emptyWorktreeSetsFile(), 'nope')).toThrow(/No sets are defined/);
  });
});

describe('applySetToFlags — the four precedence rungs', () => {
  const set: WorktreeSet = {
    name: 'x',
    slot: 2,
    repos: {
      'saga-dash': { path: '/set/saga-dash' },
      rostering: { path: '/set/rostering' },
    },
  };

  it('rung 1: a user-TYPED repo flag beats the set', () => {
    const flags: SetInjectableFlags = { 'saga-dash': '/typed/saga-dash', rostering: undefined, slot: 0 };
    const result = applySetToFlags(flags, new Set(['saga-dash']), set);
    expect(flags['saga-dash']).toBe('/typed/saga-dash');
    expect(result.kept).toEqual(['saga-dash']);
  });

  it('rung 2: the set beats an env-DEFAULTED flag value (same value, not typed)', () => {
    // $SAGA_DASH arrives as an oclif DEFAULT, so the flag is populated but NOT
    // in the typed set — the set must overwrite it.
    const flags: SetInjectableFlags = { 'saga-dash': '/env/saga-dash', slot: 0 };
    applySetToFlags(flags, new Set(), set);
    expect(flags['saga-dash']).toBe('/set/saga-dash');
  });

  it('rung 3+4: repos the set does not pin are untouched (env/default falls through)', () => {
    const flags: SetInjectableFlags = { soa: '/env/soa', slot: 0 };
    applySetToFlags(flags, new Set(), set);
    expect(flags.soa).toBe('/env/soa');
    expect(flags.qboard).toBeUndefined();
  });

  it('stamps the set slot and reports applied/kept', () => {
    const flags: SetInjectableFlags = { slot: 0 };
    const result = applySetToFlags(flags, new Set(), set);
    expect(flags.slot).toBe(2);
    expect(result.slot).toBe(2);
    expect(result.applied.sort()).toEqual(['rostering', 'saga-dash']);
    expect(result.kept).toEqual([]);
  });
});
