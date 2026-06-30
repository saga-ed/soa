/**
 * The minimal native mesh bring-up (plan §7.2 "M4"). A FAITHFUL-IN-SPIRIT port
 * of up.sh's `mesh_up` (~521-566), trimmed to the essentials M4 needs:
 *
 *   1. `check_ports` preflight (preflight.ts) — abort with named conflicts before
 *      we touch docker.
 *   2. `make up PROJECT=saga-mesh PROFILE=empty POSTGRES_PORT=… REDIS_PORT=…
 *      RABBITMQ_PORT=… RABBITMQ_MGMT_PORT=… CONNECT_MONGO_PORT=…` in `$SOA/infra`
 *      (with `EXTRA_POSTGRES_SEED_DIR=../../projects/saga-mesh/seed`) via the
 *      shared `Runner`. The mesh starts as ONE unit regardless of the closure, so
 *      all five port vars are always passed — exactly up.sh.
 *   3. per-unit readiness gating — poll each NEEDED mesh unit's manifest readiness
 *      command (`pg_isready` / `redis-cli ping` / `rabbitmq-diagnostics ping` /
 *      `mongosh ping`) up to its manifest `timeoutSec`, via the injectable
 *      `MeshExec` (`docker exec <container> …`).
 *
 * The port vars + readiness commands + container names are DERIVED FROM THE
 * MANIFEST (`mesh.ts`), not hardcoded, so they can't drift from the topology.
 * Only the closure's mesh units are readiness-gated (a postgres-only partial
 * stack doesn't wait on rabbitmq), even though `make up` still starts the whole
 * mesh — matching up.sh starting everything but the launcher only needing a
 * subset healthy.
 *
 * DELIBERATELY OMITTED (vs up.sh `mesh_up`, this being the MINIMAL bring-up):
 * the "all 4 containers already running ⇒ skip" docker-ps fast path and the
 * one-time legacy standalone-connect-mongo migration. Those are docker-ps
 * niceties, not correctness; noted as TODOs for the full M6 port. The readiness
 * poll is still idempotent (a healthy unit passes on the first probe), so a
 * re-run is safe.
 *
 * Production wires `makeRealMeshExec()` (the only place `docker exec` runs for
 * readiness) + the shared real Runner; tests inject fakes so the make-up
 * invocation and the readiness gating are asserted with NO real make/docker.
 *
 * INVARIANT (plan hard constraint): make/docker IO lives only in
 * `src/runtime/**`; `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { allMesh, getMesh, manifest as defaultManifest } from '../core/manifest/index.js';
import type { Manifest, MeshDef, MeshId } from '../core/manifest/index.js';
import type { Runner } from './exec.js';
import { checkPorts, makeRealPortProbe, meshOwnedContainers, meshPortSpecs } from './preflight.js';
import type { PortConflict, PortProbe } from './preflight.js';

/**
 * The injectable mesh readiness seam: run one unit's readiness command inside its
 * container, resolving true iff it answered ready. A real impl shells out
 * (`docker exec <container> sh -c '<readinessCmd>'`); a fake answers from a script.
 */
export interface MeshExec {
  ready(container: string, readinessCmd: string): Promise<boolean>;
}

/** Inputs to a native mesh bring-up. */
export interface MeshContext {
  /** Absolute path to the soa repo checkout (the `make up` runs in `<soaRoot>/infra`). */
  soaRoot: string;
  /** The Runner the `make up` invocation goes through (shared M1 process seam). */
  runner: Runner;
  /** The readiness-probe seam. Default `makeRealMeshExec()`. */
  exec?: MeshExec;
  /**
   * Which mesh units to readiness-gate (typically the active `closure.mesh`).
   * Omitted ⇒ all manifest mesh units. `make up` always starts the full mesh
   * regardless; this only narrows what we WAIT on.
   */
  units?: MeshId[];
  /** Port probe for the `check_ports` preflight. Default `makeRealPortProbe()`. */
  portProbe?: PortProbe;
  /** Skip the host-port preflight (the caller already ran it). Default false. */
  skipPreflight?: boolean;
  /** Sleep between readiness polls (overridden in tests to resolve instantly). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

/** Per-unit readiness outcome. */
export interface MeshUnitResult {
  id: MeshId;
  container: string;
  ok: boolean;
}

/** The outcome of `meshUp`. */
export interface MeshResult {
  ok: boolean;
  /** Non-empty ⇒ the preflight aborted before `make up` (mesh ports conflict). */
  conflicts: PortConflict[];
  /** True iff `make up` exited 0. */
  makeOk: boolean;
  /** Per-unit readiness results (only the gated units). */
  units: MeshUnitResult[];
}

/** Resolved container name for a mesh unit: `SAGA_MESH_<UNIT>_CONTAINER` env override ?? manifest. */
export function meshContainer(unit: MeshDef): string {
  const envKey = `SAGA_MESH_${unit.id.toUpperCase().replace(/-/g, '_')}_CONTAINER`;
  return process.env[envKey] ?? unit.container;
}

/**
 * Build the `make` argv that brings the mesh up. Ports come from the manifest
 * mesh defs (postgres/redis/rabbitmq + mgmt/connect-mongo), so this can't drift.
 */
export function meshMakeArgs(m: Manifest = defaultManifest): string[] {
  const pg = getMesh('postgres', m);
  const redis = getMesh('redis', m);
  const rabbit = getMesh('rabbitmq', m);
  const mongo = getMesh('connect-mongo', m);
  return [
    'up',
    'PROJECT=saga-mesh',
    'PROFILE=empty',
    `POSTGRES_PORT=${pg.port}`,
    `REDIS_PORT=${redis.port}`,
    `RABBITMQ_PORT=${rabbit.port}`,
    `RABBITMQ_MGMT_PORT=${rabbit.mgmtPort ?? 15672}`,
    `CONNECT_MONGO_PORT=${mongo.port}`,
  ];
}

/**
 * Bring the mesh up natively: preflight → `make up` → per-unit readiness poll.
 * Returns a structured result; never throws on a normal failure (conflicts, a
 * non-zero `make up`, or a unit that never goes ready) — the caller renders it.
 */
export async function meshUp(ctx: MeshContext): Promise<MeshResult> {
  const m = ctx.manifest ?? defaultManifest;
  const exec = ctx.exec ?? makeRealMeshExec();
  const probe = ctx.portProbe ?? makeRealPortProbe();
  const gatedIds = ctx.units ?? (Object.keys(m.mesh) as MeshId[]);

  // 1. check_ports preflight (unless the caller already did it).
  if (!ctx.skipPreflight) {
    const conflicts = await checkPorts(meshPortSpecs(m), probe, meshOwnedContainers(m));
    if (conflicts.length > 0) {
      return { ok: false, conflicts, makeOk: false, units: [] };
    }
  }

  // 2. make up — the mesh always starts as a whole; ports are manifest-derived.
  const { code } = await ctx.runner.run({
    cwd: join(ctx.soaRoot, 'infra'),
    command: 'make',
    args: meshMakeArgs(m),
    env: { EXTRA_POSTGRES_SEED_DIR: '../../projects/saga-mesh/seed' },
    stdio: 'inherit',
  });
  if (code !== 0) {
    return { ok: false, conflicts: [], makeOk: false, units: [] };
  }

  // 3. readiness-gate each NEEDED unit up to its manifest timeoutSec.
  const units: MeshUnitResult[] = [];
  let allReady = true;
  for (const id of gatedIds) {
    const unit = getMesh(id, m);
    const container = meshContainer(unit);
    const ready = await pollReady(exec, container, unit.readinessCmd, unit.timeoutSec, ctx.sleep);
    units.push({ id, container, ok: ready });
    if (!ready) allReady = false;
  }

  return { ok: allReady, conflicts: [], makeOk: true, units };
}

/** Poll one unit's readiness command up to `timeoutSec` (1s interval), true on the first ready. */
async function pollReady(
  exec: MeshExec,
  container: string,
  readinessCmd: string,
  timeoutSec: number,
  sleep: (ms: number) => Promise<void> = (ms): Promise<void> =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let attempt = 0; attempt < timeoutSec; attempt += 1) {
    if (await exec.ready(container, readinessCmd)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * The production mesh-readiness exec: `docker exec <container> sh -c '<cmd>'`,
 * resolving true iff it exits 0. `sh -c` carries the readiness command verbatim
 * (incl. the `mongosh --eval '…'` quoting) — exit-0 is the readiness signal for
 * every probe (pg_isready / redis-cli ping / rabbitmq-diagnostics ping / mongosh).
 * NEVER throws — a missing docker / dead container resolves to `false`.
 */
export function makeRealMeshExec(): MeshExec {
  return {
    ready(container: string, readinessCmd: string): Promise<boolean> {
      return new Promise((resolve) => {
        execFile('docker', ['exec', container, 'sh', '-c', readinessCmd], (err) => {
          resolve(!err);
        });
      });
    },
  };
}
