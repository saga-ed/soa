/**
 * Stage checkpoints — the PURE identity + compatibility half of M14 (plan
 * `11-e2e-stage-snapshots.md` §1-§2, saga-ed/soa#214).
 *
 * A checkpoint is a DB snapshot of a progressive flow's state AFTER stage k.
 * `--from <stage>` restores the predecessor's checkpoint instead of replaying
 * Playwright stages 1..k. This module owns what makes that safe:
 *
 *   - `checkpointFixtureId` — the deterministic snapshot name
 *     (`flow-<spa>-<flow>-s<phase>-<stageId>`; re-bakes overwrite);
 *   - `stagePrefixHash` — sha256 over an EXPLICIT projection of the producing
 *     stage definitions + the flow's seed/env (§2.1): any edit to the prefix
 *     that produced the state invalidates downstream checkpoints. An explicit
 *     field-ordered projection (not a generic key-sorter) keeps "what
 *     invalidates a checkpoint" auditable;
 *   - `evaluateCheckpoint` — the compat verdict a `--from` run enforces:
 *     identity + prefixHash + seed profile are HARD, the >7-day staleness
 *     cliff is HARD unless `--from-stale-ok` downgrades it, and SPA-HEAD
 *     drift is WARN-only (§2.3 — checkpoints are a dev accelerant, the full
 *     replay stays the source of truth).
 *
 * PURE: no IO, no wall clock (callers pass `now`). `node:crypto` is
 * deterministic and allowed under the core-purity rule (precedent:
 * `runtime/lock.ts`).
 */

import { createHash } from 'node:crypto';
import type { SnapshotFlowBlock } from '../snapshot/manifest.js';
import type { FlowDef, StageDef } from './types.js';

/** The staleness cliff (§2.2): older checkpoints refuse without `--from-stale-ok`. */
export const CHECKPOINT_MAX_AGE_DAYS = 7;

/**
 * The deterministic snapshot fixtureId for a stage's checkpoint. `position`
 * is the stage's 1-based index in the FULL flow stage list — used when the
 * stage declares no explicit `phase` (progressive flows normally do).
 */
export function checkpointFixtureId(
  spaId: string,
  flowName: string,
  stage: StageDef,
  position: number,
): string {
  return `flow-${spaId}-${flowName}-s${stage.phase ?? position}-${stage.id}`;
}

/**
 * §2.1: hash of everything that PRODUCED the checkpointed state — the stage
 * prefix definitions plus the flow-level seed/env. Explicit projection, fixed
 * field order, sha256 hex.
 */
export function stagePrefixHash(flow: FlowDef, producingStages: StageDef[]): string {
  const projection = {
    flow: flow.name,
    seed: flow.seed ?? null,
    env: flow.env ?? null,
    stages: producingStages.map((s) => ({
      id: s.id,
      phase: s.phase ?? null,
      project: s.project,
      spec: s.spec,
      requiredSystems: [...s.requiredSystems],
      seed: s.seed ?? null,
      tags: s.tags ?? [],
    })),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

/** What a `--from` run expects the predecessor checkpoint to be. */
export interface CheckpointExpectation {
  spaId: string;
  flowName: string;
  stageId: string;
  prefixHash: string;
  seedProfile?: string;
  /** Advisory: the SPA checkout HEAD now (git probe at the command layer). */
  currentSpaHead?: string;
}

/** The compat verdict — violations block the restore, warnings just print. */
export interface CheckpointVerdict {
  ok: boolean;
  violations: string[];
  warnings: string[];
}

/**
 * §2: is this snapshot a valid input for `--from`? The schema-ahead migration
 * guard is NOT evaluated here — `restorePlan` enforces it unchanged at
 * restore time; this evaluator covers the flow-level rules.
 */
export function evaluateCheckpoint(
  block: SnapshotFlowBlock | undefined,
  expect: CheckpointExpectation,
  now: Date,
  staleOk = false,
): CheckpointVerdict {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (block === undefined) {
    return {
      ok: false,
      violations: ['snapshot has no stage-checkpoint provenance (not baked by --snapshot-stages)'],
      warnings,
    };
  }

  if (block.spa !== expect.spaId || block.flow !== expect.flowName || block.stageId !== expect.stageId) {
    violations.push(
      `checkpoint identity mismatch: baked for ${block.spa}/${block.flow} stage '${block.stageId}', ` +
        `expected ${expect.spaId}/${expect.flowName} stage '${expect.stageId}'`,
    );
  }

  if (block.prefixHash !== expect.prefixHash) {
    violations.push(
      'the producing stage prefix changed since this checkpoint was baked (prefixHash mismatch) — ' +
        're-bake with --snapshot-stages',
    );
  }

  if (expect.seedProfile !== undefined && block.seedProfile !== undefined && block.seedProfile !== expect.seedProfile) {
    violations.push(
      `seed profile mismatch: checkpoint baked with '${block.seedProfile}', flow now seeds '${expect.seedProfile}'`,
    );
  }

  // The cliff guards the DATES the state embeds, so it keys on BOTH timestamps:
  // bakedAt alone is launderable — a `--from --snapshot-stages` re-bake stamps a
  // fresh bakedAt while carrying the RESTORED (old) occurrence date forward, and
  // it's the occurrence date the Monday-flake class actually breaks on.
  const bakedAt = Date.parse(block.bakedAt);
  const occurredAt = Date.parse(block.dates.occurrenceDate);
  if (Number.isNaN(bakedAt)) {
    violations.push(`checkpoint has an unreadable bakedAt timestamp ('${block.bakedAt}')`);
  } else {
    const ageDays = Math.max(
      (now.getTime() - bakedAt) / 86_400_000,
      // A future-dated occurrence (the weekday clamp lands on next Monday) is
      // fine — only a PAST drift ages the checkpoint.
      Number.isNaN(occurredAt) ? 0 : (now.getTime() - occurredAt) / 86_400_000,
    );
    if (ageDays > CHECKPOINT_MAX_AGE_DAYS) {
      const msg = `checkpoint is ${Math.floor(ageDays)} days old (cliff ${CHECKPOINT_MAX_AGE_DAYS}d, oldest of bakedAt/occurrenceDate) — its baked dates likely no longer fit; re-bake with --snapshot-stages`;
      if (staleOk) warnings.push(`${msg} (--from-stale-ok override)`);
      else violations.push(`${msg}, or pass --from-stale-ok`);
    }
  }

  if (
    expect.currentSpaHead !== undefined &&
    block.spaHead !== undefined &&
    block.spaHead.sha !== expect.currentSpaHead
  ) {
    warnings.push(
      `SPA checkout moved since the bake (${block.spaHead.sha.slice(0, 8)}${block.spaHead.dirty ? '+dirty' : ''} → ` +
        `${expect.currentSpaHead.slice(0, 8)}) — re-bake if earlier stages changed behavior`,
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}
