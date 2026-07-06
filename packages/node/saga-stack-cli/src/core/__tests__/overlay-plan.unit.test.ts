/**
 * overlay-plan pure planner + accounting unit tests (M10).
 *
 * Token classification, token splitting, the managed-repo set, and the
 * merged/conflicted/missing → exit-code decision (0 clean / 1 if any repo
 * hard-skipped or any branch conflicted-or-missing). No git/gh/fs.
 */

import { describe, expect, it } from 'vitest';
import {
  MANAGED_REPOS,
  classifyToken,
  overlayExitCode,
  refreshFailed,
  resetExitCode,
  resetFailed,
  splitTokens,
  type RefreshOutcome,
  type ResetOutcome,
} from '../overlay-plan.js';

/** A refresh outcome with sensible empties; override per case. */
function refresh(o: Partial<RefreshOutcome> & Pick<RefreshOutcome, 'status'>): RefreshOutcome {
  return {
    name: 'saga-dash',
    path: '/dev/saga-dash',
    base: 'main',
    merged: [],
    conflicted: [],
    missing: [],
    notFound: [],
    ...o,
  };
}

function reset(o: Partial<ResetOutcome> & Pick<ResetOutcome, 'status'>): ResetOutcome {
  return { name: 'saga-dash', path: '/dev/saga-dash', base: 'main', ...o };
}

describe('classifyToken', () => {
  it('a purely-numeric token → a PR to resolve via gh', () => {
    expect(classifyToken('165')).toEqual({ kind: 'pr', pr: '165' });
  });
  it('anything else → a literal branch used verbatim', () => {
    expect(classifyToken('fix/foo')).toEqual({ kind: 'branch', branch: 'fix/foo' });
    expect(classifyToken('release-2')).toEqual({ kind: 'branch', branch: 'release-2' });
    expect(classifyToken('12a')).toEqual({ kind: 'branch', branch: '12a' });
  });
});

describe('splitTokens', () => {
  it('splits on commas, strips spaces, drops empties', () => {
    expect(splitTokens('410, 432')).toEqual(['410', '432']);
    expect(splitTokens('165')).toEqual(['165']);
    expect(splitTokens('410,,432,')).toEqual(['410', '432']);
    expect(splitTokens('')).toEqual([]);
    expect(splitTokens('  ')).toEqual([]);
  });
});

describe('MANAGED_REPOS', () => {
  it('is exactly rostering, program-hub, saga-dash (soa/sds never overlaid by default)', () => {
    expect([...MANAGED_REPOS]).toEqual(['rostering', 'program-hub', 'saga-dash']);
  });
});

describe('refreshFailed + overlayExitCode', () => {
  it('overridden / no-prs / a clean merge do NOT fail (rc 0)', () => {
    expect(refreshFailed(refresh({ status: 'overridden' }))).toBe(false);
    expect(refreshFailed(refresh({ status: 'no-prs' }))).toBe(false);
    expect(refreshFailed(refresh({ status: 'merged', merged: ['b1', 'b2'] }))).toBe(false);
  });

  it('a hard pre-merge skip fails (not-git / dirty / fetch-failed / base-missing)', () => {
    for (const status of ['not-git', 'dirty', 'fetch-failed', 'base-missing'] as const) {
      expect(refreshFailed(refresh({ status }))).toBe(true);
    }
  });

  it('a completed merge fails iff a branch conflicted OR was missing', () => {
    expect(refreshFailed(refresh({ status: 'merged', merged: ['b1'], conflicted: ['b2'] }))).toBe(true);
    expect(refreshFailed(refresh({ status: 'merged', merged: ['b1'], missing: ['b3'] }))).toBe(true);
  });

  it('a not-found PR is WARN-ONLY — never flips the outcome', () => {
    expect(refreshFailed(refresh({ status: 'merged', merged: ['b1'], notFound: ['999'] }))).toBe(false);
    expect(refreshFailed(refresh({ status: 'no-prs', notFound: ['999'] }))).toBe(false);
  });

  it('overlayExitCode is 1 iff ANY repo failed (else 0)', () => {
    expect(overlayExitCode([refresh({ status: 'merged', merged: ['b'] }), refresh({ status: 'no-prs' })])).toBe(0);
    expect(overlayExitCode([refresh({ status: 'merged', merged: ['b'] }), refresh({ status: 'base-missing' })])).toBe(1);
    expect(overlayExitCode([])).toBe(0);
  });
});

describe('resetFailed + resetExitCode', () => {
  it('only dirty-on-INT or a failed checkout fail; not-git/not-overlaid/reset/overridden pass', () => {
    expect(resetFailed(reset({ status: 'dirty' }))).toBe(true);
    expect(resetFailed(reset({ status: 'checkout-failed' }))).toBe(true);
    for (const status of ['overridden', 'not-git', 'not-overlaid', 'reset'] as const) {
      expect(resetFailed(reset({ status }))).toBe(false);
    }
  });

  it('resetExitCode is 1 iff ANY repo failed (else 0)', () => {
    expect(resetExitCode([reset({ status: 'reset' }), reset({ status: 'not-overlaid' })])).toBe(0);
    expect(resetExitCode([reset({ status: 'reset' }), reset({ status: 'dirty' })])).toBe(1);
  });
});
