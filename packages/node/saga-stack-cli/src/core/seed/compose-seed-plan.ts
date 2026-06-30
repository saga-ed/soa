/**
 * `composeSeedPlan` — the pure seed planner (plan §4.1, saga-ed/soa#214).
 *
 * Resolves a `SeedSelection` (profile + add-ons, optionally narrowed by
 * `only`/`exclude`) into the canonical `SeedPlan` by applying three gates, in
 * the canonical run order:
 *
 *   1. partial-stack — drop a step whose service is not in the active closure
 *      (the N-of-M capability bash lacked).
 *   2. snapshot-skip — drop a step whose service was FULLY restored from a
 *      snapshot. `restored` is the set of fully-restored services (the snapshot
 *      layer computes "all of a service's DBs restored" → service ∈ restored;
 *      a PARTIAL restore leaves the service OUT, so the step is KEPT — matching
 *      up.sh:1727's `restored_db` all-DBs rule).
 *   3. partition — split the survivors into `offline` / `online` by
 *      `requiresServiceUp` (online = deferred until those services are up).
 *
 * PURE: no IO. Operates over the frozen registry derived from the manifest.
 */

import type { ServiceId } from '../manifest/index.js';
import { ADDON_STEPS, PROFILE_STEPS, SEED_RUN_ORDER, SEED_STEPS } from './profiles.js';
import type { SeedStepId } from './profiles.js';
import type { SeedPlan, SeedSelection, SeedStep, SkipNote } from './types.js';

export function composeSeedPlan(
  sel: SeedSelection,
  active: Set<ServiceId>,
  restored: Set<ServiceId>,
): SeedPlan {
  // Resolve the selected step-id set: base profile ∪ add-ons ∪ per-system
  // profile overrides. The per-system override unions in only the steps that
  // belong to the named system at its (possibly heavier) profile, so a flow can
  // seed e.g. programs-api at `full` while the base stays `roster` (plan §5).
  const selected = new Set<SeedStepId>(PROFILE_STEPS[sel.profile]);
  for (const addOn of sel.addOns ?? []) {
    for (const id of ADDON_STEPS[addOn]) selected.add(id);
  }
  for (const { system, profile } of sel.perSystem ?? []) {
    for (const id of PROFILE_STEPS[profile]) {
      if (SEED_STEPS[id].service === system) selected.add(id);
    }
  }

  const onlyServices = sel.only ? new Set<ServiceId>(sel.only) : undefined;
  const excludeIds = sel.exclude ? new Set<string>(sel.exclude) : undefined;

  const offline: SeedStep[] = [];
  const online: SeedStep[] = [];
  const skipped: SkipNote[] = [];

  for (const id of SEED_RUN_ORDER) {
    if (!selected.has(id)) continue;

    const step = SEED_STEPS[id];

    // Selection refinements (not gates — these were never requested).
    if (excludeIds?.has(id)) continue;
    if (onlyServices && !onlyServices.has(step.service)) continue;

    // Gate 1: service not in the active closure.
    if (!active.has(step.service)) {
      skipped.push({
        id,
        service: step.service,
        reason: 'service-inactive',
        detail: `${step.service} is not in the active stack`,
      });
      continue;
    }

    // Gate 2: service fully restored from a snapshot (partial restore ⇒ kept).
    if (restored.has(step.service)) {
      skipped.push({
        id,
        service: step.service,
        reason: 'service-restored',
        detail: `${step.service} was restored from a snapshot — db:seed skipped`,
      });
      continue;
    }

    // Gate 3: partition offline vs online.
    if (step.requiresServiceUp.length > 0) online.push(step);
    else offline.push(step);
  }

  return { offline, online, skipped };
}
