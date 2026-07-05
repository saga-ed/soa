/**
 * verify-posture PURE unit tests (M12; verify.sh P1–P4).
 *
 * The overriding invariant is STRUCTURAL: every function returns `PostureLine`s whose
 * levels are only `ok`/`warn`/`note` — there is NO `fail` level, so posture cannot flip
 * the verify exit code. These tests assert the per-check DECISIONS (branch, pin-merged,
 * the unpinned set-subtraction + branch extraction, freshness) and that NOTHING ever
 * escalates past a warn.
 */

import { describe, expect, it } from 'vitest';
import {
  POSTURE_ALWAYS_MAIN_REPOS,
  POSTURE_MANAGED_REPOS,
  assessBranch,
  assessFreshness,
  assessMainBranch,
  assessNotGit,
  assessPinMerged,
  assessUnknownOverlayRepo,
  computeUnpinnedOverlays,
  extractMergedOverlayBranches,
  isFreshnessCandidate,
  unpinnedOverlayLines,
  type PostureLine,
} from '../verify-posture.js';

describe('posture constants match verify.sh', () => {
  it('MANAGED_REPOS is verify.sh set (incl qboard + rtsm — larger than the overlay engine set)', () => {
    expect([...POSTURE_MANAGED_REPOS]).toEqual(['rostering', 'program-hub', 'saga-dash', 'qboard', 'rtsm']);
  });
  it('ALWAYS_MAIN_REPOS is soa + student-data-system', () => {
    expect([...POSTURE_ALWAYS_MAIN_REPOS]).toEqual(['soa', 'student-data-system']);
  });
});

describe('P1 — branch posture (warn-only)', () => {
  it('on the expected branch ⇒ ok', () => {
    expect(assessBranch('saga-dash', 'local/integration', 'local/integration').level).toBe('ok');
  });
  it('on the WRONG branch ⇒ WARN (never fail)', () => {
    const l = assessBranch('saga-dash', 'feature/x', 'local/integration');
    expect(l.level).toBe('warn');
    expect(l.message).toContain('posture drift');
  });
});

describe('P1 — un-pinned managed repo (main, or empty local/integration ≡ main)', () => {
  it('on main ⇒ ok', () => {
    expect(assessMainBranch('rostering', 'main', false).level).toBe('ok');
  });
  it('on local/integration that ≡ main (diff-quiet) ⇒ ok', () => {
    const l = assessMainBranch('rostering', 'local/integration', true);
    expect(l.level).toBe('ok');
    expect(l.message).toContain('≡ main');
  });
  it('on local/integration that DIFFERS from main ⇒ WARN', () => {
    expect(assessMainBranch('rostering', 'local/integration', false).level).toBe('warn');
  });
  it('on some other branch ⇒ WARN', () => {
    expect(assessMainBranch('rostering', 'feature/x', false).level).toBe('warn');
  });
});

describe('P2 — pin merged (warn-only)', () => {
  it('head SHA is an ancestor of HEAD ⇒ ok', () => {
    expect(assessPinMerged('saga-dash', '410', 'deadbeef', true).level).toBe('ok');
  });
  it('pin present but NOT an ancestor ⇒ WARN (stale pin, not a failure)', () => {
    const l = assessPinMerged('saga-dash', '410', 'deadbeef', false);
    expect(l.level).toBe('warn');
    expect(l.message).toContain('NOT in checkout');
  });
  it('gh could not resolve the head (oid === "") ⇒ "couldn\'t check" WARN (gh offline/unauthed)', () => {
    const l = assessPinMerged('saga-dash', '410', '', false);
    expect(l.level).toBe('warn');
    expect(l.message).toContain('couldn’t'.replace('’', "'")); // "couldn't resolve head via gh"
    expect(l.message).toContain('gh');
  });
});

describe('P3 — merged-branch extraction (sed-equivalent)', () => {
  it('captures origin/<branch> from each merge subject, drops main/master, unique + sorted', () => {
    const subjects = [
      "Merge remote-tracking branch 'origin/feat/b' into local/integration",
      "Merge remote-tracking branch 'origin/feat/a' into local/integration",
      "Merge remote-tracking branch 'origin/feat/a' into local/integration", // dup
      "Merge remote-tracking branch 'origin/main' into local/integration", // dropped
      'Some unrelated commit subject', // no match
    ].join('\n');
    expect(extractMergedOverlayBranches(subjects)).toEqual(['feat/a', 'feat/b']);
  });
  it('empty log ⇒ []', () => {
    expect(extractMergedOverlayBranches('')).toEqual([]);
  });
});

describe('P3 — the unpinned set-subtraction (merged MINUS pinned)', () => {
  it('leaves only branches that are NOT pinned', () => {
    const merged = ['feat/a', 'feat/b', 'feat/c'];
    const pinned = ['feat/a', 'feat/c'];
    expect(computeUnpinnedOverlays(merged, pinned)).toEqual(['feat/b']);
  });
  it('every merged branch pinned ⇒ no unpinned overlays', () => {
    expect(computeUnpinnedOverlays(['feat/a'], ['feat/a', 'feat/z'])).toEqual([]);
  });
  it('no pins ⇒ every merged branch is unpinned', () => {
    expect(computeUnpinnedOverlays(['feat/a', 'feat/b'], [])).toEqual(['feat/a', 'feat/b']);
  });
  it('renders two WARN lines (count + caveat) with the #num decoration; empty ⇒ no lines', () => {
    expect(unpinnedOverlayLines('rostering', [])).toEqual([]);
    const lines = unpinnedOverlayLines('rostering', [
      { branch: 'feat/b', num: '77' },
      { branch: 'feat/d', num: '' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.level === 'warn')).toBe(true);
    expect(lines[0].message).toContain('+2 unpinned overlay(s)');
    expect(lines[0].message).toContain('#77 feat/b');
    expect(lines[0].message).toContain('feat/d'); // no # decoration when num === ''
    expect(lines[0].message).not.toContain('# feat/d');
  });
});

describe('P4 — freshness (warn-only)', () => {
  it('current (behind 0) ⇒ ok', () => {
    expect(assessFreshness('qboard', true, 0).level).toBe('ok');
  });
  it('behind origin ⇒ WARN (never fail)', () => {
    const l = assessFreshness('qboard', true, 5);
    expect(l.level).toBe('warn');
    expect(l.message).toContain('5 behind origin/main');
  });
  it('fetch failed ⇒ WARN "freshness unknown" (network IO degraded, not a failure)', () => {
    const l = assessFreshness('qboard', false, null);
    expect(l.level).toBe('warn');
    expect(l.message).toContain('fetch failed');
  });
  it('behind === null (rev-list "?") ⇒ WARN "could not compare"', () => {
    expect(assessFreshness('qboard', true, null).message).toContain('could not compare');
  });
  it('only main / local/integration are freshness candidates', () => {
    expect(isFreshnessCandidate('main')).toBe(true);
    expect(isFreshnessCandidate('local/integration')).toBe(true);
    expect(isFreshnessCandidate('feature/x')).toBe(false);
    expect(isFreshnessCandidate('')).toBe(false);
  });
});

describe('WARN-ONLY invariant — NO function ever returns a failure level', () => {
  it('every posture line across every check is ok | warn | note (never a fail)', () => {
    const all: PostureLine[] = [
      assessNotGit('rostering', '/x/rostering'),
      assessUnknownOverlayRepo('coach'),
      assessBranch('a', 'x', 'y'),
      assessMainBranch('a', 'local/integration', false),
      assessPinMerged('a', '1', '', false),
      assessPinMerged('a', '1', 'sha', false),
      assessFreshness('a', false, null),
      assessFreshness('a', true, 9),
      ...unpinnedOverlayLines('a', [{ branch: 'b', num: '2' }]),
    ];
    for (const l of all) expect(['ok', 'warn', 'note']).toContain(l.level);
  });
  it('assessNotGit downgrades verify.sh\'s lone badline to a WARN (posture never fails)', () => {
    expect(assessNotGit('rostering', '/x/rostering').level).toBe('warn');
  });
});
