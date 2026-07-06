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
 *      up.sh:1727's `restored_db` all-DBs rule). EXEMPTION: a `databases: []`
 *      static-fixture step (e.g. the coach curriculum mongoimport, whose mongo
 *      data is NOT in the service's PG snapshot) is KEPT even when restored — its
 *      data isn't part of what a snapshot restores (up.sh always runs it).
 *   3. partition — split the survivors into `offline` / `online` by
 *      `requiresServiceUp` (online = deferred until those services are up).
 *
 * MULTI-SEED (#221): a `scenario`/`datasets` selection resolves to a per-system
 * dataset map (`resolveDatasetMap`). Each SURVIVING step whose service is in the
 * map is emitted as a CLONE with `SEED_DATASET=<name>` added to its env vars —
 * the ONLY place the frozen registry is ever varied per selection. After the
 * gates, coherence is enforced: every mapped system must have contributed at
 * least one stamped step, else the compose THROWS (`SeedDatasetError`) — a
 * coupled scenario (the triad) must never be half-applied (multiseed-research §1).
 *
 * PURE: no IO. Operates over the frozen registry derived from the manifest.
 */

import type { ServiceId } from '../manifest/index.js';
import { SEED_DATASET_VAR, SeedDatasetError, resolveDatasetMap } from './datasets.js';
import { ADDON_STEPS, PROFILE_STEPS, SEED_RUN_ORDER, SEED_STEPS } from './profiles.js';
import type { SeedStepId } from './profiles.js';
import type { SeedPlan, SeedSelection, SeedStep, SkipNote } from './types.js';

/**
 * Clone `step` with `SEED_DATASET=<dataset>` stamped into its env var bag —
 * recursively stamping any nested `optionalSteps` owned by a mapped service.
 * The registry object itself is never mutated (it stays frozen); a `dotenv`
 * env kind has no var bag to stamp, so a dataset on such a step is rejected.
 */
function stampDataset(step: SeedStep, datasetsBySystem: Map<ServiceId, string>): SeedStep {
  const dataset = datasetsBySystem.get(step.service);
  const optionalSteps = step.optionalSteps?.map((sub) => stampDataset(sub, datasetsBySystem));
  if (dataset === undefined) {
    return optionalSteps === undefined ? step : { ...step, optionalSteps };
  }
  if (step.env.kind === 'dotenv') {
    throw new SeedDatasetError(
      `seed step '${step.id}' (${step.service}) uses the dotenv env kind — a named dataset cannot be stamped onto it`,
    );
  }
  return {
    ...step,
    env: { kind: step.env.kind, vars: { ...step.env.vars, [SEED_DATASET_VAR]: dataset } },
    ...(optionalSteps === undefined ? {} : { optionalSteps }),
  };
}

/** Collect every dataset-mapped system `step` (or a nested optionalStep) covers. */
function recordStamped(
  step: SeedStep,
  datasetsBySystem: Map<ServiceId, string>,
  stampedSystems: Set<ServiceId>,
): void {
  if (datasetsBySystem.has(step.service)) stampedSystems.add(step.service);
  for (const sub of step.optionalSteps ?? []) recordStamped(sub, datasetsBySystem, stampedSystems);
}

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

  // #221 multi-seed: scenario ∪ datasets → one per-system dataset map (throws
  // SeedDatasetError on a conflicting/unknown selection).
  const datasetsBySystem = resolveDatasetMap(sel);
  const stampedSystems = new Set<ServiceId>();

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
    // EXEMPTION: a step with `databases: []` seeds a STATIC FIXTURE that lives OUTSIDE
    // the service's tracked (PG) snapshot — e.g. the coach curriculum mongoimport
    // (saga_local/wmlms_local mongo, NOT in coach-api's PG snapshot). up.sh's
    // seed_coach_mongo_only ALWAYS runs, so a coach PG-snapshot restore must not skip
    // it (else subjectData 500s post-restore). Only DB-writing steps are snapshot-gated.
    if (restored.has(step.service) && step.databases.length > 0) {
      skipped.push({
        id,
        service: step.service,
        reason: 'service-restored',
        detail: `${step.service} was restored from a snapshot — db:seed skipped`,
      });
      continue;
    }

    // #221 multi-seed: stamp the dataset onto a CLONE of the surviving step.
    // Record every mapped system the emitted step reaches (incl. nested
    // optionalSteps) so coherence sees a system stamped only via a sub-step.
    const emitted = stampDataset(step, datasetsBySystem);
    recordStamped(emitted, datasetsBySystem, stampedSystems);

    // Gate 3: partition offline vs online.
    if (emitted.requiresServiceUp.length > 0) online.push(emitted);
    else offline.push(emitted);
  }

  // #221 multi-seed coherence: every mapped system must have contributed at
  // least one stamped step — a coupled scenario (the triad) half-applied is the
  // one cross-system hazard this feature introduces, so it is an ERROR, never a
  // silent partial seed. The skip notes explain WHY a system missed (inactive /
  // restored); a system absent from them was simply never selected (profile too
  // light, or narrowed out by only/exclude).
  const unapplied = [...datasetsBySystem.keys()].filter((s) => !stampedSystems.has(s));
  if (unapplied.length > 0) {
    const why = unapplied.map((s) => {
      const note = skipped.find((n) => n.service === s);
      return `${s} (${note ? note.reason : 'no step selected — check profile/perSystem/only/exclude'})`;
    });
    throw new SeedDatasetError(
      `dataset selection cannot be applied coherently — no seed step ran for: ${why.join('; ')}`,
    );
  }

  return { offline, online, skipped };
}
