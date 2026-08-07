/**
 * Listener provenance (PURE) — "is the process answering this port still serving
 * the code I think it is?", split out so the command layer + tests reason about
 * it with zero IO.
 *
 * WHY THIS EXISTS, and how it differs from its two neighbours:
 *
 *   core/foreign-procs   "did `ss` launch this?"        — ownership, by pgid
 *   runtime/verify-posture  "is the CHECKOUT what I expect?" — branch/pins/drift
 *   THIS MODULE          "is what ss launched still CURRENT?"
 *
 * The gap is real and was measured on 2026-08-05: slot 0's coach-web was served
 * by a `vite` process started six days earlier, which had survived a `git
 * checkout` of its own repo — so it answered 200 on the right port, from the
 * right checkout, under the right pgid, while serving code that no longer existed
 * on disk. `stack status` reported 13/13 healthy throughout. Ownership could not
 * see it (the process was owned), posture could not see it (the checkout was
 * correct); only the process's START TIME against the checkout's last ref
 * movement reveals it.
 *
 * TWO CHECKS, and why both are needed:
 *
 *   wrong-checkout  the listener's checkout root != the root ss resolves for that
 *                   service. Catches a process left over from a worktree/slot.
 *   stale           the listener started BEFORE its checkout's HEAD last moved.
 *                   Catches the case above, which `wrong-checkout` misses because
 *                   the path is right and only the time is wrong.
 *
 * CHECKOUT ROOT, not a path prefix. A naive `cwd.startsWith(expectedRoot)` calls
 * `~/dev/soa/.claude/worktrees/x/apps/…` a match for `~/dev/soa` — exactly
 * backwards, since a linked worktree is a DIFFERENT checkout that happens to
 * live inside the primary one. The IO layer resolves each cwd to its nearest
 * `.git`-bearing ancestor and this module compares roots for EQUALITY.
 *
 * DEGRADES TO `unknown`, NEVER TO A FALSE ALARM. Missing `/proc`, an unreadable
 * reflog, a process that vanished mid-probe — all yield `unknown`, which renders
 * as a note and never as a failure. A provenance check that cries wolf gets
 * switched off, and then it protects nothing.
 *
 * INVARIANT (plan hard constraint): this lives in `core/` and stays PURE — no
 * `/proc`, no `ps`, no spawn, no clock. The host IO lives only in
 * `runtime/provenance`.
 */

import type { ServiceId } from './manifest/index.js';
import type { PortListener } from './foreign-procs.js';

/** Where a live process came from, as resolved by the IO layer. */
export interface ProcOrigin {
  pid: number;
  /**
   * The nearest `.git`-bearing ancestor of the process's cwd — its CHECKOUT, not
   * its cwd. `null` when it could not be determined (no `/proc`, vanished, or a
   * cwd outside any repo).
   */
  checkoutRoot: string | null;
  /** Wall-clock ms at which the process started; `null` when unreadable. */
  startedAtMs: number | null;
}

/** What is wrong with a listener, if anything. */
export type ProvenanceVerdict =
  /** Listener's checkout matches and it started after the last ref movement. */
  | 'ok'
  /** Nothing is listening — the service is down, which `status`'s health leg reports. */
  | 'down'
  /** Could not determine provenance; reported as a note, never as a failure. */
  | 'unknown'
  /** Serving from a different checkout than the one `ss` resolves for this service. */
  | 'wrong-checkout'
  /** Right checkout, but the process predates that checkout's last HEAD movement. */
  | 'stale';

/** One service's provenance assessment. */
export interface ProvenanceRow {
  id: ServiceId;
  port: number;
  verdict: ProvenanceVerdict;
  /** The listening pid, when there is one. */
  pid: number | null;
  /** The checkout `ss` resolves for this service's repo. */
  expectedRoot: string;
  /** The checkout the listener is actually running from. */
  actualRoot: string | null;
  startedAtMs: number | null;
  /** When `expectedRoot`'s HEAD last moved (checkout/pull/reset). */
  refMovedAtMs: number | null;
}

/** True iff this verdict should draw the operator's attention. */
export function isProvenanceProblem(v: ProvenanceVerdict): boolean {
  return v === 'wrong-checkout' || v === 'stale';
}

/**
 * Classify every target's listener provenance. Pure and order-preserving: the
 * targets order in, one row each out.
 *
 * - `listeners` maps port → its live listener (absent ⇒ `down`).
 * - `origins` maps pid → where that process came from (absent ⇒ `unknown`).
 * - `expectedRoots` maps service → the checkout `ss` resolves for its repo.
 * - `refMovedAt` maps a checkout root → when its HEAD last moved (`null` ⇒ the
 *   staleness leg is skipped for that root, not failed).
 *
 * Precedence is `wrong-checkout` before `stale`: if the process is running from
 * the wrong tree entirely, when it started is a detail of a bigger problem.
 */
export function classifyProvenance(
  targets: { id: ServiceId; port: number }[],
  listeners: Map<number, PortListener>,
  origins: Map<number, ProcOrigin>,
  expectedRoots: Map<ServiceId, string>,
  refMovedAt: Map<string, number | null>,
): ProvenanceRow[] {
  return targets.map(({ id, port }) => {
    const expectedRoot = expectedRoots.get(id) ?? '';
    const base: Omit<ProvenanceRow, 'verdict'> = {
      id,
      port,
      expectedRoot,
      pid: null,
      actualRoot: null,
      startedAtMs: null,
      refMovedAtMs: refMovedAt.get(expectedRoot) ?? null,
    };

    const listener = listeners.get(port);
    if (!listener) return { ...base, verdict: 'down' };

    const origin = origins.get(listener.pid);
    if (!origin || origin.checkoutRoot === null) {
      return { ...base, verdict: 'unknown', pid: listener.pid, startedAtMs: origin?.startedAtMs ?? null };
    }

    const row: ProvenanceRow = {
      ...base,
      verdict: 'ok',
      pid: listener.pid,
      actualRoot: origin.checkoutRoot,
      startedAtMs: origin.startedAtMs,
    };

    // An empty expectedRoot means the caller could not resolve the repo — say so
    // rather than accusing the process of being in the wrong place.
    if (expectedRoot === '') return { ...row, verdict: 'unknown' };
    if (origin.checkoutRoot !== expectedRoot) return { ...row, verdict: 'wrong-checkout' };

    const movedAt = row.refMovedAtMs;
    if (movedAt !== null && origin.startedAtMs !== null && origin.startedAtMs < movedAt) {
      return { ...row, verdict: 'stale' };
    }
    return row;
  });
}
