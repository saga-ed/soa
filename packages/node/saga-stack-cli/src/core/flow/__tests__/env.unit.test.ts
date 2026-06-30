/**
 * Centralized date-env unit tests (plan §5.5, §6 — the Monday-flake fix).
 *
 * Anchors (LOCAL calendar, built via `new Date(y, m, d)` so the suite is
 * timezone-independent — month is 0-indexed, June = 5):
 *   Mon 2026-06-22 · Tue 2026-06-23 · Sat 2026-06-27 · Sun 2026-06-28 ·
 *   Mon 2026-06-29.
 *
 * PURE: every helper takes the reference Date in; nothing reads the wall clock.
 */

import { describe, expect, it } from 'vitest';
import type { FlowDef } from '../types.js';
import {
  ENV_OCCURRENCE_DATE,
  ENV_TERM_END,
  ENV_TERM_START,
  computeEnv,
  fmtLocal,
  mondayOfWeekOf,
  occurrenceDate,
  todayOrNextWeekday,
} from '../env.js';

const MON = new Date(2026, 5, 22);
const TUE = new Date(2026, 5, 23);
const WED = new Date(2026, 5, 24);
const SAT = new Date(2026, 5, 27);
const SUN = new Date(2026, 5, 28);
const NEXT_MON = new Date(2026, 5, 29);

const baseFlow: FlowDef = {
  name: 'journey',
  description: 'progressive journey',
  lanes: ['stack'],
  progressive: true,
  stages: [{ id: 'schedule', project: 'stage-5', spec: 'schedule.e2e.test.ts', requiredSystems: [] }],
};

describe('fmtLocal', () => {
  it('formats local YYYY-MM-DD, zero-padded', () => {
    expect(fmtLocal(new Date(2026, 0, 4))).toBe('2026-01-04');
    expect(fmtLocal(SAT)).toBe('2026-06-27');
  });
});

describe('mondayOfWeekOf', () => {
  it('returns the Monday of the containing week for every weekday', () => {
    expect(fmtLocal(mondayOfWeekOf(MON))).toBe('2026-06-22'); // Mon → itself
    expect(fmtLocal(mondayOfWeekOf(TUE))).toBe('2026-06-22');
    expect(fmtLocal(mondayOfWeekOf(SAT))).toBe('2026-06-22'); // Sat → that week's Mon
    expect(fmtLocal(mondayOfWeekOf(SUN))).toBe('2026-06-22'); // Sun → that week's Mon (ISO)
  });

  it('does not mutate its input', () => {
    const d = new Date(2026, 5, 27);
    mondayOfWeekOf(d);
    expect(d.getTime()).toBe(new Date(2026, 5, 27).getTime());
  });
});

describe('todayOrNextWeekday (the authoritative clamp)', () => {
  it('leaves weekdays unchanged', () => {
    expect(fmtLocal(todayOrNextWeekday(MON))).toBe('2026-06-22');
    expect(fmtLocal(todayOrNextWeekday(TUE))).toBe('2026-06-23');
  });

  it('rolls a weekend FORWARD to the next Monday (never back to a stale Monday)', () => {
    expect(fmtLocal(todayOrNextWeekday(SAT))).toBe('2026-06-29'); // Sat → +2
    expect(fmtLocal(todayOrNextWeekday(SUN))).toBe('2026-06-29'); // Sun → +1
  });

  it('does not mutate its input', () => {
    const d = new Date(2026, 5, 27);
    todayOrNextWeekday(d);
    expect(d.getTime()).toBe(new Date(2026, 5, 27).getTime());
  });
});

describe('occurrenceDate', () => {
  it('equals the weekday clamp (live occurrence, never a past day)', () => {
    expect(fmtLocal(occurrenceDate(SAT))).toBe(fmtLocal(NEXT_MON));
    expect(fmtLocal(occurrenceDate(TUE))).toBe('2026-06-23');
  });
});

describe('computeEnv', () => {
  it('injects clamped occurrence + term window for a weekend run (the flake case)', () => {
    const env = computeEnv(baseFlow, SAT);
    expect(env[ENV_OCCURRENCE_DATE]).toBe('2026-06-29'); // clamped forward — NOT the past Mon 22
    expect(env[ENV_TERM_START]).toBe('2026-06-22'); // Monday of the reference week
    expect(env[ENV_TERM_END]).toBe('2026-08-03'); // term start + 6 weeks (42 days)
  });

  it('on a Monday, occurrence == term start (clamp is a no-op — not the flake)', () => {
    const env = computeEnv(baseFlow, NEXT_MON);
    expect(env[ENV_OCCURRENCE_DATE]).toBe('2026-06-29');
    expect(env[ENV_TERM_START]).toBe('2026-06-29');
  });

  it('on a midweek Wednesday, occurrence == that weekday; term start == that week’s Monday', () => {
    const env = computeEnv(baseFlow, WED);
    expect(env[ENV_OCCURRENCE_DATE]).toBe('2026-06-24'); // weekday clamp is a no-op
    expect(env[ENV_TERM_START]).toBe('2026-06-22'); // Monday of the reference week
    expect(env[ENV_TERM_END]).toBe('2026-08-03'); // term start + 6 weeks
  });

  it("merges flow.env LAST so an author can pin a date", () => {
    const flow: FlowDef = { ...baseFlow, env: { [ENV_OCCURRENCE_DATE]: '2099-01-01', EXTRA: 'x' } };
    const env = computeEnv(flow, SAT);
    expect(env[ENV_OCCURRENCE_DATE]).toBe('2099-01-01'); // flow-level override wins
    expect(env[ENV_TERM_START]).toBe('2026-06-22'); // un-overridden default still present
    expect(env.EXTRA).toBe('x');
  });
});
