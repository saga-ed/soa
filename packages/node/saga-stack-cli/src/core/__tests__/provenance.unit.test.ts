/**
 * Listener-provenance classification — PURE (no /proc, no ps, no spawn, no
 * clock). The rule under test: a listener is suspect when it is serving a
 * DIFFERENT checkout than `ss` resolves for that service (`wrong-checkout`), or
 * when it started BEFORE its checkout's HEAD last moved (`stale`).
 *
 * The `stale` case is the one that motivated the module: it is invisible to both
 * neighbouring checks, because the process is owned and the checkout is correct.
 */

import { describe, expect, it } from 'vitest';
import { classifyProvenance, isProvenanceProblem, type ProcOrigin } from '../provenance.js';
import type { PortListener } from '../foreign-procs.js';
import type { ServiceId } from '../manifest/index.js';

const COACH_WEB: ServiceId = 'coach-web';
const IAM: ServiceId = 'iam-api';

const T0 = Date.parse('2026-08-05T10:00:00Z');
const MINUTE = 60_000;

function listener(port: number, pid: number): PortListener {
  return { port, pid, pgid: pid, command: 'node vite.js dev' };
}

function origin(pid: number, checkoutRoot: string | null, startedAtMs: number | null): ProcOrigin {
  return { pid, checkoutRoot, startedAtMs };
}

/** One coach-web target on :8800, expected to run from /dev/coach. */
const TARGETS = [{ id: COACH_WEB, port: 8800 }];
const EXPECTED = new Map<ServiceId, string>([[COACH_WEB, '/dev/coach']]);

function assess(
  listeners: Map<number, PortListener>,
  origins: Map<number, ProcOrigin>,
  refMoved: number | null = T0 - 10 * MINUTE,
) {
  return classifyProvenance(
    TARGETS,
    listeners,
    origins,
    EXPECTED,
    new Map([['/dev/coach', refMoved]]),
  );
}

describe('classifyProvenance', () => {
  it('is ok when the checkout matches and the process started after HEAD moved', () => {
    const [row] = assess(
      new Map([[8800, listener(8800, 42)]]),
      new Map([[42, origin(42, '/dev/coach', T0)]]),
      T0 - 10 * MINUTE,
    );
    expect(row?.verdict).toBe('ok');
    expect(isProvenanceProblem('ok')).toBe(false);
  });

  it('flags STALE when the process predates the checkout’s last HEAD movement', () => {
    // The measured 2026-08-05 case: right port, right checkout, right owner —
    // and a process six days older than the branch it claims to serve.
    const sixDays = 6 * 24 * 60 * MINUTE;
    const [row] = assess(
      new Map([[8800, listener(8800, 42)]]),
      new Map([[42, origin(42, '/dev/coach', T0 - sixDays)]]),
      T0,
    );
    expect(row?.verdict).toBe('stale');
    expect(row?.startedAtMs).toBe(T0 - sixDays);
    expect(row?.refMovedAtMs).toBe(T0);
    expect(isProvenanceProblem('stale')).toBe(true);
  });

  it('flags WRONG-CHECKOUT when the listener runs from another tree', () => {
    const [row] = assess(
      new Map([[8800, listener(8800, 42)]]),
      new Map([[42, origin(42, '/dev/coach/.claude/worktrees/pr332', T0)]]),
    );
    expect(row?.verdict).toBe('wrong-checkout');
    expect(row?.actualRoot).toBe('/dev/coach/.claude/worktrees/pr332');
    expect(row?.expectedRoot).toBe('/dev/coach');
  });

  it('prefers WRONG-CHECKOUT over STALE when both are true', () => {
    const [row] = assess(
      new Map([[8800, listener(8800, 42)]]),
      new Map([[42, origin(42, '/dev/elsewhere', T0 - 99 * MINUTE)]]),
      T0,
    );
    expect(row?.verdict).toBe('wrong-checkout');
  });

  it('reports DOWN, not a problem, when nothing is listening', () => {
    const [row] = assess(new Map(), new Map());
    expect(row?.verdict).toBe('down');
    expect(row?.pid).toBeNull();
    expect(isProvenanceProblem('down')).toBe(false);
  });

  describe('degrades to unknown rather than crying wolf', () => {
    it('when the origin could not be read at all', () => {
      const [row] = assess(new Map([[8800, listener(8800, 42)]]), new Map());
      expect(row?.verdict).toBe('unknown');
      expect(row?.pid).toBe(42);
    });

    it('when the cwd resolved to no checkout (non-Linux, or outside a repo)', () => {
      const [row] = assess(
        new Map([[8800, listener(8800, 42)]]),
        new Map([[42, origin(42, null, T0)]]),
      );
      expect(row?.verdict).toBe('unknown');
    });

    it('when the expected root could not be resolved', () => {
      const [row] = classifyProvenance(
        TARGETS,
        new Map([[8800, listener(8800, 42)]]),
        new Map([[42, origin(42, '/dev/coach', T0)]]),
        new Map([[COACH_WEB, '']]),
        new Map(),
      );
      expect(row?.verdict).toBe('unknown');
    });

    it('when HEAD movement is unknown — the staleness leg is SKIPPED, not failed', () => {
      const [row] = assess(
        new Map([[8800, listener(8800, 42)]]),
        new Map([[42, origin(42, '/dev/coach', T0 - 99 * MINUTE)]]),
        null,
      );
      expect(row?.verdict).toBe('ok');
    });

    it('when the start time is unknown but the checkout is right', () => {
      const [row] = assess(
        new Map([[8800, listener(8800, 42)]]),
        new Map([[42, origin(42, '/dev/coach', null)]]),
        T0,
      );
      expect(row?.verdict).toBe('ok');
    });
  });

  it('is order-preserving and returns one row per target', () => {
    const rows = classifyProvenance(
      [
        { id: IAM, port: 3010 },
        { id: COACH_WEB, port: 8800 },
      ],
      new Map([[3010, listener(3010, 7)]]),
      new Map([[7, origin(7, '/dev/rostering', T0)]]),
      new Map([
        [IAM, '/dev/rostering'],
        [COACH_WEB, '/dev/coach'],
      ]),
      new Map([
        ['/dev/rostering', T0 - MINUTE],
        ['/dev/coach', T0 - MINUTE],
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual([IAM, COACH_WEB]);
    expect(rows.map((r) => r.verdict)).toEqual(['ok', 'down']);
  });

  it('a process started exactly when HEAD moved is not stale (strict <)', () => {
    const [row] = assess(
      new Map([[8800, listener(8800, 42)]]),
      new Map([[42, origin(42, '/dev/coach', T0)]]),
      T0,
    );
    expect(row?.verdict).toBe('ok');
  });
});
