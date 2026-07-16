/**
 * M14 stage-checkpoint EXECUTION (split out of e2e-orchestrate in M15): the
 * restore ceremony a `--from`/prerequisite run performs in place of the
 * reset+seed (load → flow-level compat verdict → window DB-coverage check →
 * CheckpointStore.restore), and the per-green-stage bake. Composes the runtime
 * `CheckpointStore` seam via `ExecDeps.checkpoints` — the type imports from
 * e2e-orchestrate are TYPE-ONLY (erased), so the module cycle is compile-time
 * only. `FlowExecError` lives here (both halves throw it); e2e-orchestrate
 * re-exports it, keeping the command layer's imports stable.
 */

import { evaluateCheckpoint, checkpointFixtureId, stagePrefixHash } from './core/flow/checkpoint.js';
import { ENV_OCCURRENCE_DATE, ENV_TERM_END, ENV_TERM_START } from './core/flow/env.js';
import type { ResolvedFlow } from './core/flow/index.js';
import type { Manifest, ServiceId } from './core/manifest/index.js';
import type { SnapshotFlowBlock } from './core/snapshot/index.js';
import type { ExecDeps, ExecOptions } from './e2e-orchestrate.js';

/** Raised when a native pre-Playwright stage (up/reset/seed/verify/restore) fails. */
export class FlowExecError extends Error {}

/** M14 §1.2: load + validate + restore the predecessor checkpoint; returns its baked dates. */
export async function restoreCheckpoint(
  resolved: ResolvedFlow,
  deps: ExecDeps,
  opts: ExecOptions,
  services: ServiceId[],
  m: Manifest,
): Promise<SnapshotFlowBlock['dates']> {
  const cp = resolved.checkpoint as NonNullable<ResolvedFlow['checkpoint']>;
  if (deps.checkpoints === undefined) {
    throw new FlowExecError('--from requires the checkpoint store (internal wiring error)');
  }

  const fixtureId = checkpointFixtureId(
    resolved.spa.id,
    resolved.flow.name,
    cp.predecessor,
    cp.predecessorPosition,
  );
  const snapshot = deps.checkpoints.load(fixtureId);
  if (snapshot === null) {
    // Plan §1.2: list the stages that ARE baked so the fix is self-evident.
    const baked = resolved.flow.stages
      .filter((s, i) => deps.checkpoints?.load(checkpointFixtureId(resolved.spa.id, resolved.flow.name, s, i + 1)))
      .map((s) => s.id);
    throw new FlowExecError(
      `no checkpoint '${fixtureId}' — baked stages: ${baked.join(', ') || '(none)'}. Bake first:\n` +
        `  ss e2e run ${resolved.spa.id}/${resolved.flow.name} --snapshot-stages --headless`,
    );
  }

  const verdict = evaluateCheckpoint(
    snapshot.flow,
    {
      spaId: resolved.spa.id,
      flowName: resolved.flow.name,
      stageId: cp.predecessor.id,
      prefixHash: stagePrefixHash(resolved.flow, cp.producingStages),
      seedProfile: resolved.seedSelection?.profile,
      currentSpaHead: opts.spaHead?.sha,
    },
    deps.now,
    opts.fromStaleOk === true,
  );

  // The checkpoint must COVER the window's state: any DB a window stage needs
  // that the bake never dumped would keep un-reset leftover rows (a full replay
  // would have reset+seeded it). Bake wider (--through) or re-bake.
  const dumped = new Set(snapshot.databases.map((d) => d.db));
  const missing = [...new Set(services.flatMap((id) => m.services[id]?.databases ?? []))].filter(
    (db) => !dumped.has(db),
  );
  if (missing.length > 0) {
    verdict.violations.push(
      `the checkpoint does not cover the window's database(s): ${missing.join(', ')} — ` +
        'it was baked from a narrower closure; re-bake with a wider --through',
    );
    verdict.ok = false;
  }

  for (const w of verdict.warnings) deps.log(`⚠ checkpoint: ${w}`);
  if (!verdict.ok) {
    throw new FlowExecError(
      `checkpoint '${fixtureId}' failed validation:\n` + verdict.violations.map((v) => `  ✗ ${v}`).join('\n'),
    );
  }

  const flowBlock = snapshot.flow as SnapshotFlowBlock; // verdict.ok ⇒ present
  deps.log(`==> restore: ${fixtureId} (baked ${flowBlock.bakedAt}, occurrence ${flowBlock.dates.occurrenceDate})`);
  try {
    await deps.checkpoints.restore(snapshot, { currentProfile: resolved.seedSelection?.profile });
  } catch (err) {
    throw new FlowExecError((err as Error).message);
  }
  return flowBlock.dates;
}

/** M14 §1.1: overwrite-store the checkpoint for a just-green stage. */
export async function bakeStageCheckpoint(
  resolved: ResolvedFlow,
  stage: ResolvedFlow['stages'][number],
  services: ServiceId[],
  env: Record<string, string>,
  deps: ExecDeps,
  opts: ExecOptions,
  m: Manifest,
): Promise<void> {
  const checkpoints = deps.checkpoints as NonNullable<ExecDeps['checkpoints']>;
  const position = resolved.flow.stages.findIndex((s) => s.id === stage.id) + 1;
  const fixtureId = checkpointFixtureId(resolved.spa.id, resolved.flow.name, stage, position);

  // The bake scope is the SLOT-FILTERED closure's DB set (post-closure exclusion,
  // same rule as `snapshot store --slot N`) — never dump DBs the slot never provisioned.
  const dbs = [...new Set(services.flatMap((id) => m.services[id]?.databases ?? []))];

  // soa#327 quiescence barrier — BEFORE the first dump. A green Playwright stage
  // is not proof the DBs are settled: roster-sync's outbox relay (and the
  // in-flight pii-write window) can still be draining when the stage's HTTP
  // responses return, and a dump taken then bakes a TORN checkpoint whose
  // personas 401 after restore (the walkthrough failure). Gated on the flow
  // DECLARING settlePersonas (no personas ⇒ nothing trustworthy to probe) and
  // on the bake actually covering iam_pii_local (a closure without iam has no
  // roster pipeline to settle). A barrier timeout FAILS the bake loudly — the
  // seam contract says it throws rather than let torn state be written.
  const personas = resolved.flow.settlePersonas ?? [];
  if (deps.settleBarrier !== undefined && personas.length > 0 && dbs.includes('iam_pii_local')) {
    try {
      await deps.settleBarrier({ fixtureId, stageId: stage.id, personas });
    } catch (err) {
      throw new FlowExecError((err as Error).message);
    }
  }

  await checkpoints.bake({
    fixtureId,
    // No fabricated default: a seedless flow's checkpoint says so ('unseeded'
    // never false-matches a real profile in the restore-time double guard).
    profile: resolved.seedSelection?.profile ?? 'unseeded',
    dbs,
    flow: {
      spa: resolved.spa.id,
      flow: resolved.flow.name,
      stageId: stage.id,
      ...(stage.phase !== undefined ? { phase: stage.phase } : {}),
      prefixHash: stagePrefixHash(resolved.flow, resolved.flow.stages.slice(0, position)),
      ...(resolved.seedSelection?.profile !== undefined ? { seedProfile: resolved.seedSelection.profile } : {}),
      dates: {
        occurrenceDate: env[ENV_OCCURRENCE_DATE] ?? '',
        termStart: env[ENV_TERM_START] ?? '',
        termEnd: env[ENV_TERM_END] ?? '',
      },
      ...(opts.spaHead !== undefined ? { spaHead: opts.spaHead } : {}),
      bakedAt: deps.now.toISOString(),
    },
  });
  deps.log(`==> checkpoint: baked ${fixtureId}`);
}
