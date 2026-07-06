/**
 * Worktree-set store (M13-A runtime half): $SAGA_STACK_SETS override, the
 * missing-file ⇒ empty-store tolerance (mirrors runtime/flows.ts), and path
 * normalization (~ expansion, relative-against-file-dir resolution).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRealSetStore, normalizeSetPath, setsFilePath } from '../set-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'set-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('setsFilePath', () => {
  it('defaults to ~/.saga-stack/worktree-sets.json', () => {
    expect(setsFilePath({}, '/home/u')).toBe('/home/u/.saga-stack/worktree-sets.json');
  });

  it('honors $SAGA_STACK_SETS (hermetic CI/test fixtures)', () => {
    expect(setsFilePath({ SAGA_STACK_SETS: '/x/sets.json' }, '/home/u')).toBe('/x/sets.json');
  });

  it('ignores an EMPTY $SAGA_STACK_SETS', () => {
    expect(setsFilePath({ SAGA_STACK_SETS: '' }, '/home/u')).toBe('/home/u/.saga-stack/worktree-sets.json');
  });
});

describe('normalizeSetPath', () => {
  it('expands ~ and ~/…', () => {
    expect(normalizeSetPath('~', '/home/u', '/base')).toBe('/home/u');
    expect(normalizeSetPath('~/wt/x', '/home/u', '/base')).toBe('/home/u/wt/x');
  });

  it('resolves a relative path against the sets file dir', () => {
    expect(normalizeSetPath('wt/x', '/home/u', '/base')).toBe('/base/wt/x');
  });

  it('keeps an absolute path verbatim', () => {
    expect(normalizeSetPath('/abs/x', '/home/u', '/base')).toBe('/abs/x');
  });
});

describe('makeRealSetStore().load', () => {
  it('a missing file is the empty store, not an error', () => {
    const store = makeRealSetStore({ SAGA_STACK_SETS: join(dir, 'nope.json') }, '/home/u');
    expect(store.load()).toEqual({ version: 1, sets: {} });
  });

  it('reads, re-validates, and normalizes paths on every load', () => {
    const file = join(dir, 'sets.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sets: { x: { slot: 1, repos: { 'saga-dash': '~/wt/dash', rostering: 'rel/rostering', soa: '/abs/soa' } } },
      }),
    );
    const store = makeRealSetStore({ SAGA_STACK_SETS: file }, '/home/u');
    const sets = store.load().sets;
    expect(sets.x!.repos['saga-dash']!.path).toBe('/home/u/wt/dash');
    expect(sets.x!.repos.rostering!.path).toBe(join(dir, 'rel/rostering'));
    expect(sets.x!.repos.soa!.path).toBe('/abs/soa');
  });

  it('malformed JSON names the file', () => {
    const file = join(dir, 'sets.json');
    writeFileSync(file, '{nope');
    const store = makeRealSetStore({ SAGA_STACK_SETS: file }, '/home/u');
    expect(() => store.load()).toThrow(new RegExp(`${file}.*not valid JSON`));
  });

  it('schema violations propagate the pure layer error (duplicate slot)', () => {
    const file = join(dir, 'sets.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sets: { a: { slot: 1, repos: {} }, b: { slot: 1, repos: {} } } }),
    );
    const store = makeRealSetStore({ SAGA_STACK_SETS: file }, '/home/u');
    expect(() => store.load()).toThrow(/both declare slot 1/);
  });
});
