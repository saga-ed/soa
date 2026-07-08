/**
 * M13-C pure mutation tests — serialize (on-disk shape), withSetAdded (name/slot
 * conflict guards), withSetRemoved. No IO; the store round-trips these.
 */

import { describe, expect, it } from 'vitest';
import {
  parseWorktreeSetsFile,
  serializeWorktreeSetsFile,
  withSetAdded,
  withSetRemoved,
  type WorktreeSet,
} from '../worktree-sets.js';

const emptyFile = () => parseWorktreeSetsFile({ version: 1, sets: {} });
const setSched: WorktreeSet = {
  name: 'sched',
  slot: 1,
  repos: { 'saga-dash': { path: '~/dev/worktrees/saga-dash-sched', createdBy: 'ss', createdFrom: 'feat/sched' } },
  note: 'scheduling tweak',
};

describe('serializeWorktreeSetsFile', () => {
  it('keys sets by name, drops the name field, emits object form for created entries', () => {
    const file = withSetAdded(emptyFile(), setSched);
    expect(serializeWorktreeSetsFile(file)).toEqual({
      version: 1,
      sets: {
        sched: {
          slot: 1,
          repos: { 'saga-dash': { path: '~/dev/worktrees/saga-dash-sched', createdBy: 'ss', createdFrom: 'feat/sched' } },
          note: 'scheduling tweak',
        },
      },
    });
  });

  it('emits a BARE STRING for a hand-authored entry with no provenance', () => {
    const file = parseWorktreeSetsFile({ version: 1, sets: { a: { slot: 3, repos: { rostering: '/wt/r' } } } });
    expect(serializeWorktreeSetsFile(file).sets.a.repos.rostering).toBe('/wt/r');
  });

  it('round-trips through parse unchanged (serialize ∘ parse = id)', () => {
    const file = withSetAdded(emptyFile(), setSched);
    expect(parseWorktreeSetsFile(serializeWorktreeSetsFile(file))).toEqual(file);
  });
});

describe('withSetAdded', () => {
  it('adds a set without mutating the input', () => {
    const before = emptyFile();
    const after = withSetAdded(before, setSched);
    expect(Object.keys(before.sets)).toEqual([]); // input untouched
    expect(after.sets.sched?.slot).toBe(1);
  });

  it('rejects a duplicate name', () => {
    const file = withSetAdded(emptyFile(), setSched);
    expect(() => withSetAdded(file, { ...setSched, slot: 2 })).toThrow(/already exists/);
  });

  it('rejects a slot already owned by another set', () => {
    const file = withSetAdded(emptyFile(), setSched);
    expect(() => withSetAdded(file, { ...setSched, name: 'other' })).toThrow(/slot 1 is already owned by set 'sched'/);
  });
});

describe('withSetRemoved', () => {
  it('removes a set and returns it, input untouched', () => {
    const file = withSetAdded(emptyFile(), setSched);
    const { file: after, removed } = withSetRemoved(file, 'sched');
    expect(removed.name).toBe('sched');
    expect(after.sets.sched).toBeUndefined();
    expect(file.sets.sched).toBeDefined(); // input untouched
  });

  it('throws on an unknown set (listing known names)', () => {
    const file = withSetAdded(emptyFile(), setSched);
    expect(() => withSetRemoved(file, 'nope')).toThrow(/unknown set 'nope'.*Known sets: sched/);
  });
});
