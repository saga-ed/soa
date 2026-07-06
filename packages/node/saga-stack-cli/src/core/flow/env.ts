/**
 * Centralized date env for e2e flows (plan §5.5, saga-ed/soa#214) — the M5
 * "Monday-flake" fix.
 *
 * Diagnosis (plan §5.5): only the interactive connect-session spec clamps its
 * occurrence date (`todayOrNextWeekday`); the four journey date-specs compute an
 * UNCLAMPED `mondayOfCurrentWeek()`. On Sat/Sun the targeted Monday is in the
 * PAST, the schedule occurrence is stale, the sessions query comes back empty,
 * and the stage flakes. The clamp is authoritative.
 *
 * The fix is two-layered. THIS module is layer (1): the CLI computes the clamped
 * dates ONCE and injects them as env vars for EVERY flow/SPA, so specs read the
 * value instead of recomputing it. Layer (2) is the shared kit (see
 * `./e2e-kit.ts`) that re-exports these helpers so the specs themselves become
 * env-first (`process.env.PLAYWRIGHT_OCCURRENCE_DATE ?? occurrenceDate(...)`).
 *
 * PURE: every function takes a REFERENCE `Date` as INPUT and never reads the
 * wall clock (no `new Date()` / `Date.now()` in core — that would break
 * determinism and the core purity rule). The runtime/command layer supplies the
 * real `now`. None of these helpers MUTATE their input Date.
 */

import type { FlowDef } from './types.js';

/** Env var carrying the clamped, live session occurrence date (`YYYY-MM-DD`). */
export const ENV_OCCURRENCE_DATE = 'PLAYWRIGHT_OCCURRENCE_DATE';
/** Env var carrying the term/schedule start (Monday of the reference week). */
export const ENV_TERM_START = 'PLAYWRIGHT_TERM_START';
/** Env var carrying the term/schedule end (term start + 6 weeks). */
export const ENV_TERM_END = 'PLAYWRIGHT_TERM_END';

/** How many weeks the default term window spans past its start (schedule spec). */
const TERM_WEEKS = 6;

/** Clone a Date so component-mutating helpers never touch the caller's value. */
function clone(d: Date): Date {
  return new Date(d.getTime());
}

/** Return a NEW date `n` days after `d` (local calendar; handles month rollover). */
function addDays(d: Date, n: number): Date {
  const r = clone(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Format a Date as a local `YYYY-MM-DD` string (NOT UTC — uses the local
 * calendar components, matching the saga-dash specs' `fmtLocal`). The dash date
 * inputs and the scheduling-api both speak local civil dates, so formatting in
 * UTC here would shift the day across the midnight/timezone boundary.
 */
export function fmtLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Monday of the (ISO) week containing `d`, as a NEW Date. Mirrors the saga-dash
 * `mondayOfCurrentWeek` arithmetic exactly — `getDay()` is 0=Sun…6=Sat, so
 * `(getDay() + 6) % 7` is the number of days back to Monday (Mon→0 … Sun→6).
 * This is the schedule/term-start anchor.
 */
export function mondayOfWeekOf(d: Date): Date {
  const r = clone(d);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

/**
 * Clamp `d` to the nearest weekday at or after it: Sat → next Mon (+2),
 * Sun → next Mon (+1), any weekday → `d` unchanged. Returns a NEW Date.
 *
 * This is the authoritative clamp (plan §5.5). The journey schedule meets every
 * weekday (BYDAY=MO,TU,WE,TH,FR), so a weekday "today" is always a live
 * occurrence; on a weekend we roll forward to the next Monday rather than back
 * to a stale past Monday — which is exactly the bug the journey specs hit.
 */
export function todayOrNextWeekday(d: Date): Date {
  const r = clone(d);
  const dow = r.getDay(); // 0=Sun … 6=Sat
  if (dow === 0) r.setDate(r.getDate() + 1); // Sun → Mon
  else if (dow === 6) r.setDate(r.getDate() + 2); // Sat → Mon
  return r;
}

/**
 * The live session occurrence date the specs should target, as a NEW Date.
 * Defined as the clamped weekday (`todayOrNextWeekday`) so it is always a real
 * rrule occurrence and never a past day. Named distinctly from the clamp so the
 * kit's public intent ("the date a session occurs on") reads at the call site.
 */
export function occurrenceDate(d: Date): Date {
  return todayOrNextWeekday(d);
}

/**
 * Compute the centralized date env the CLI injects for a flow's Playwright run
 * (plan §5.4/§5.5). Given the resolved `flow` and the real `referenceDate`
 * (supplied by the command/runtime — never read here), returns the env vars the
 * runner overlays onto the Playwright child process:
 *
 *   - PLAYWRIGHT_OCCURRENCE_DATE — clamped live occurrence (fixes the flake).
 *   - PLAYWRIGHT_TERM_START      — Monday of the reference week (schedule dtstart).
 *   - PLAYWRIGHT_TERM_END        — term start + 6 weeks (the schedule window).
 *
 * All three are emitted unconditionally (they are pure derived dates and a flow
 * that does not schedule a term simply ignores TERM_*); a flow's own
 * `flow.env` is merged LAST so an author can pin/override any of them for a
 * deliberately date-fixed flow. The returned record is the CLI-authoritative
 * layer; the runner is free to overlay per-stage env on top of it.
 */
export function computeEnv(flow: FlowDef, referenceDate: Date): Record<string, string> {
  const termStart = mondayOfWeekOf(referenceDate);
  return {
    [ENV_OCCURRENCE_DATE]: fmtLocal(occurrenceDate(referenceDate)),
    [ENV_TERM_START]: fmtLocal(termStart),
    [ENV_TERM_END]: fmtLocal(addDays(termStart, TERM_WEEKS * 7)),
    // Flow-level env wins (lets a date-fixed flow pin an explicit date).
    ...(flow.env ?? {}),
  };
}
