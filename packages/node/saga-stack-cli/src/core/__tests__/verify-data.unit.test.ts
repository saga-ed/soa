/**
 * Pure verify --full DATA-check unit tests (M9; verify.sh `── data ──`, D1–D5).
 *
 * Assert `assessData` maps the raw probe readings to the five pass/fail assertions,
 * that EACH failure hard-fails (`passed:false`), and that `users == 205` is a NOTE —
 * never a failure (journey/partial seeds vary the count).
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_USERS, assessData } from '../verify-data.js';
import type { DataReadings } from '../verify-data.js';

/** A fully-passing baseline: 205 users, dev id present, 6 admin personas, sis migrated, mongo up. */
const green: DataReadings = {
  usersRaw: String(CANONICAL_USERS),
  devIdRaw: '1',
  adminPersonasRaw: '6',
  sisMigrated: true,
  mongoReachable: true,
};

describe('assessData — verify --full DATA gate', () => {
  it('all green ⇒ passed, no notes', () => {
    const r = assessData(green);
    expect(r.passed).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(r.notes).toEqual([]);
  });

  it('D1: users == 205 is canonical (no note); a non-205 count is a NOTE, not a failure', () => {
    const r = assessData({ ...green, usersRaw: '190' });
    expect(r.passed).toBe(true); // still green — the count varies legitimately
    expect(r.checks.find((c) => c.id === 'D1')?.ok).toBe(true);
    expect(r.notes.join(' ')).toContain('users=190');
    expect(r.notes.join(' ')).toContain('canonical db:seed is 205');
  });

  it('D1: users == 0 HARD-fails (empty roster)', () => {
    const r = assessData({ ...green, usersRaw: '0' });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D1')?.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'D1')?.label).toContain('EMPTY');
  });

  it('D1: empty scalar (unreachable iam_local) HARD-fails', () => {
    const r = assessData({ ...green, usersRaw: '' });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D1')?.label).toContain('unreachable');
  });

  it('D2: absent deterministic dev id HARD-fails', () => {
    const r = assessData({ ...green, devIdRaw: '' });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D2')?.ok).toBe(false);
  });

  it('D3: fewer than 6 admin personas HARD-fails (#397)', () => {
    const r = assessData({ ...green, adminPersonasRaw: '2' });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D3')?.ok).toBe(false);
    // ≥ 6 passes.
    expect(assessData({ ...green, adminPersonasRaw: '8' }).checks.find((c) => c.id === 'D3')?.ok).toBe(true);
  });

  it('D4: sis_db not migrated HARD-fails', () => {
    const r = assessData({ ...green, sisMigrated: false });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D4')?.ok).toBe(false);
  });

  it('D5: connect-mongo unreachable HARD-fails', () => {
    const r = assessData({ ...green, mongoReachable: false });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D5')?.ok).toBe(false);
  });

  // V1: D2/D3 are only meaningful when iam_local is reachable AND non-empty (verify.sh
  // evaluates them inside its `users > 0` branch). When users is unreachable ('') or
  // empty ('0') the dev-id/persona reads are empty for the SAME reason D1 failed, so the
  // "random ids" / "#397 not seeded" root-causes MUST NOT be printed — they misattribute.
  it('V1: users unreachable (empty scalar) ⇒ D2/D3 relabelled skipped (no misattribution), gate still fails on D1', () => {
    const r = assessData({ ...green, usersRaw: '', devIdRaw: '', adminPersonasRaw: '' });
    expect(r.passed).toBe(false); // still hard-fails on the real gap (D1)
    const d1 = r.checks.find((c) => c.id === 'D1');
    expect(d1?.ok).toBe(false);
    expect(d1?.label).toContain('unreachable');
    const d2 = r.checks.find((c) => c.id === 'D2');
    const d3 = r.checks.find((c) => c.id === 'D3');
    // Relabelled as skipped — the misleading causes are NOT printed.
    expect(d2?.label).toContain('skipped');
    expect(d2?.label).not.toContain('random ids');
    expect(d3?.label).toContain('skipped');
    expect(d3?.label).not.toContain('#397');
    // ok stays false so they never render green while the roster is unreachable.
    expect(d2?.ok).toBe(false);
    expect(d3?.ok).toBe(false);
  });

  it('V1: users empty (0) ⇒ D2/D3 relabelled skipped, gate still fails', () => {
    const r = assessData({ ...green, usersRaw: '0', devIdRaw: '', adminPersonasRaw: '' });
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 'D2')?.label).toContain('skipped');
    expect(r.checks.find((c) => c.id === 'D3')?.label).toContain('skipped');
    // D2/D3 no longer print the misattributed root-causes.
    expect(r.checks.find((c) => c.id === 'D2')?.label).not.toContain('random ids');
    expect(r.checks.find((c) => c.id === 'D3')?.label).not.toContain('not seeded');
  });
});
