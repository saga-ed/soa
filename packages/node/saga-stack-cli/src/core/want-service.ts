/**
 * wantService — pure port of up.sh's `want_service` gate (up.sh:1046-1057).
 *
 * `want_service` is the membership predicate the launch loop consults to decide
 * whether a given service should be brought up:
 *
 *   - Workspace mode: launch only services in the run-set (WS_RUN_SET).
 *   - Classic `--only`: launch ONLY the named service.
 *   - Neither set: launch EVERYTHING (the normal full-local stack).
 *
 * Here that collapses to a single pure predicate over an explicit run-set:
 * an empty / absent run-set means "want everything" (full stack), otherwise
 * membership. The caller supplies the run-set — typically a `computeClosure`
 * result for the partial-stack (`--only`) case, or the full service list for
 * the classic full stack.
 *
 * PURE: zero IO.
 */

import type { ServiceId } from './manifest/index.js';

/**
 * Should `service` be launched given `runSet`?
 *
 * `runSet` of `null`/`undefined`/empty ⇒ true (full stack — up.sh's empty
 * `ONLY_SERVICE`). Otherwise membership in the set.
 */
export function wantService(
  service: ServiceId,
  runSet?: Iterable<ServiceId> | null,
): boolean {
  if (runSet == null) return true;
  const set = runSet instanceof Set ? runSet : new Set(runSet);
  if (set.size === 0) return true;
  return set.has(service);
}

/** Filter `services` down to the ones `wantService` keeps for `runSet`. */
export function filterWanted(
  services: ServiceId[],
  runSet?: Iterable<ServiceId> | null,
): ServiceId[] {
  if (runSet == null) return [...services];
  const set = runSet instanceof Set ? runSet : new Set(runSet);
  if (set.size === 0) return [...services];
  return services.filter((s) => set.has(s));
}
