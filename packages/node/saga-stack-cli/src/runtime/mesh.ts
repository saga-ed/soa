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
import { getMesh, manifest as defaultManifest } from '../core/manifest/index.js';
import type { Manifest, MeshDef, MeshId } from '../core/manifest/index.js';
import type { Runner } from './exec.js';
import { checkPorts, makeRealPortProbe, meshOwnedContainers, meshPortSpecs } from './preflight.js';
import type { PortConflict, PortProbe } from './preflight.js';

/**
 * Mesh units gated behind a docker-compose `profiles:` entry — NOT started by a
 * bare `docker compose up -d` unless their profile is active. `openfga` (+ its
 * `openfga_migrate` one-shot sidecar, unmodeled as a `MeshId`) is the first: the
 * `authz` bundle is opt-in (plan decision), but `make up`'s `$(COMPOSE) up -d` has
 * no per-service filter (confirmed in `infra/Makefile`) — profiles are the only
 * way to keep it out of every OTHER `stack up`'s footprint without touching the
 * shared Makefile that every project's mesh depends on.
 *
 * Keyed by mesh unit id, valued by the compose `profiles:` name that unit's
 * service definition actually carries (`../services/openfga/compose.yml` uses
 * `profiles: ["authz"]`, NOT `["openfga"]` — the unit id and the compose
 * profile name are independent strings, so this map, not the unit id itself,
 * is what `COMPOSE_PROFILES` must be built from).
 */
const PROFILE_GATED_MESH: ReadonlyMap<MeshId, string> = new Map<MeshId, string>([['openfga', 'authz']]);

/** Strip a `meshPortSpecs` mgmt-port suffix (`'<id>-mgmt'` → `'<id>'`) back to its unit id. */
function baseUnitId(specName: string): string {
  return specName.endsWith('-mgmt') ? specName.slice(0, -'-mgmt'.length) : specName;
}

/**
 * The injectable mesh readiness seam: run one unit's readiness command inside its
 * container, resolving true iff it answered ready. A real impl shells out
 * (`docker exec <container> sh -c '<readinessCmd>'`); a fake answers from a script.
 */
export interface MeshExec {
  ready(container: string, readinessCmd: string, shell?: boolean): Promise<boolean>;
}

/** Inputs to a native mesh bring-up. */
export interface MeshContext {
  /** Absolute path to the soa repo checkout (the `make up` runs in `<soaRoot>/infra`). */
  soaRoot: string;
  /** The Runner the `make up` invocation goes through (shared M1 process seam). */
  runner: Runner;
  /**
   * COMPOSE_PROJECT_NAME for this slot (M7). `soa-s<N>` at slot > 0; OMITTED at
   * slot 0 so the make argv/env stay byte-identical (the Makefile defaults to
   * `soa` via `?=`). Passed BOTH as a make arg (visible/testable) and via child
   * env (the Makefile's `?=` env-override path).
   */
  project?: string;
  /**
   * Offset added to every published mesh port (M7). `slot * 1000` at slot > 0; 0
   * (the default) at slot 0 ⇒ base ports, byte-identical to no offset.
   */
  meshOffset?: number;
  /** The readiness-probe seam. Default `makeRealMeshExec()`. */
  exec?: MeshExec;
  /**
   * Which mesh units the active closure needs (typically `closure.mesh`).
   * Omitted ⇒ all manifest mesh units. Narrows what we readiness-WAIT on for
   * every unit; for `PROFILE_GATED_MESH` units specifically (`openfga`) it also
   * decides whether they're preflighted/started at all — the base mesh
   * (postgres/redis/rabbitmq/connect-mongo) always starts via `make up`
   * regardless, since that target has no per-service filter.
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
 *
 * M7: `opts.offset` shifts every published mesh port by `slot * 1000`, and
 * `opts.project` prepends `COMPOSE_PROJECT_NAME=<project>` so the mesh comes up
 * under the slot's `soa-s<N>` namespace. At slot 0 (offset 0, no project) the
 * argv is byte-identical to the pre-M7 form.
 */
export function meshMakeArgs(
  m: Manifest = defaultManifest,
  opts: { project?: string; offset?: number } = {},
): string[] {
  const offset = opts.offset ?? 0;
  const pg = getMesh('postgres', m);
  const redis = getMesh('redis', m);
  const rabbit = getMesh('rabbitmq', m);
  const mongo = getMesh('connect-mongo', m);
  return [
    'up',
    ...(opts.project ? [`COMPOSE_PROJECT_NAME=${opts.project}`] : []),
    'PROJECT=saga-mesh',
    'PROFILE=empty',
    `POSTGRES_PORT=${pg.port + offset}`,
    `REDIS_PORT=${redis.port + offset}`,
    `RABBITMQ_PORT=${rabbit.port + offset}`,
    `RABBITMQ_MGMT_PORT=${(rabbit.mgmtPort ?? 15672) + offset}`,
    `CONNECT_MONGO_PORT=${mongo.port + offset}`,
  ];
}

/** Inputs to a native mesh teardown. */
export interface MeshDownContext {
  /** Absolute path to the soa repo checkout (the `make down` runs in `<soaRoot>/infra`). */
  soaRoot: string;
  /** The Runner the `make down` invocation goes through (shared M1 process seam). */
  runner: Runner;
  /**
   * COMPOSE_PROJECT_NAME for this slot (M7). `soa-s<N>` at slot > 0; OMITTED at
   * slot 0 (defaults to `soa`). CRITICAL: without it `make down` tears down the
   * DEFAULT project — i.e. slot 0's mesh — instead of the slot's own.
   */
  project?: string;
}

/** The outcome of `meshDown`. */
export interface MeshDownResult {
  ok: boolean;
  /** The `make down` exit code (0 ⇒ mesh stopped). */
  code: number;
}

/**
 * The `make` argv that tears the mesh down — the faithful inverse of
 * `meshMakeArgs`. up.sh brings the mesh up with `make up PROJECT=saga-mesh …`
 * (mesh_up), so teardown is `make down PROJECT=saga-mesh`. `down` needs neither
 * the PORT vars nor PROFILE (infra's `down:` target is just `docker compose down`,
 * keyed only by PROJECT), so we pass only PROJECT.
 */
export function meshDownArgs(opts: { project?: string } = {}): string[] {
  return [
    'down',
    ...(opts.project ? [`COMPOSE_PROJECT_NAME=${opts.project}`] : []),
    'PROJECT=saga-mesh',
  ];
}

/**
 * Tear the mesh down: `make down PROJECT=saga-mesh` in `<soaRoot>/infra`, through
 * the shared Runner. Stops the mesh containers but PRESERVES their volumes (infra
 * `down` = `docker compose down`, no `-v`). Returns the make exit code; never runs
 * docker directly, so a test asserts the argv with no real make/docker.
 */
export async function meshDown(ctx: MeshDownContext): Promise<MeshDownResult> {
  const { code } = await ctx.runner.run({
    cwd: join(ctx.soaRoot, 'infra'),
    command: 'make',
    args: meshDownArgs({ project: ctx.project }),
    // COMPOSE_PROJECT_NAME also via env (the Makefile's `?=` override path); OMITTED
    // at slot 0 so the env stays byte-identical to the pre-M7 `{}`.
    env: ctx.project ? { COMPOSE_PROJECT_NAME: ctx.project } : {},
    stdio: 'inherit',
  });
  return { ok: code === 0, code };
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
  const offset = ctx.meshOffset ?? 0;

  // Profile-gated units (e.g. `openfga`) only actually start when their compose
  // `profiles:` entry is active — derive the active profile set from which gated
  // units the caller's closure needs, so a plain `stack up` (no --with authz)
  // neither preflights their ports nor starts their containers.
  const activeGatedIds = gatedIds.filter((id) => PROFILE_GATED_MESH.has(id));
  const composeProfiles = [...new Set(activeGatedIds.map((id) => PROFILE_GATED_MESH.get(id)))].join(',');

  // 1. check_ports preflight (unless the caller already did it) — probe the SLOT's
  // offset ports, and treat the slot's own `soa-s<N>-*` containers as owned (via
  // the env-aware `meshOwnedContainers`) so an idempotent re-up isn't a conflict.
  // Profile-gated units are excluded unless active — their ports aren't published
  // by a container that won't be started, so checking them would be a false
  // conflict against whatever else happens to be bound to that host port.
  if (!ctx.skipPreflight) {
    const ports = meshPortSpecs(m, offset).filter(
      (spec) => !PROFILE_GATED_MESH.has(baseUnitId(spec.name) as MeshId) || activeGatedIds.includes(baseUnitId(spec.name) as MeshId),
    );
    const conflicts = await checkPorts(ports, probe, meshOwnedContainers(m));
    if (conflicts.length > 0) {
      return { ok: false, conflicts, makeOk: false, units: [] };
    }
  }

  // 2. make up — the BASE mesh always starts as a whole; ports are
  // manifest-derived (+ the slot offset). Profile-gated units (`openfga`) only
  // join via `COMPOSE_PROFILES`, set iff the caller's closure needs them — `make
  // up`'s `$(COMPOSE) up -d` has no per-service filter (confirmed: the shared
  // Makefile's `up:` target is bare), so compose profiles are the only seam that
  // keeps an opt-in unit out of every OTHER project's mesh footprint without
  // touching that shared target. COMPOSE_PROJECT_NAME goes both as a make arg and
  // via env (the Makefile's `?=` env-override path). At slot 0 both are omitted
  // ⇒ identical to pre-M7/pre-profile behavior when no gated unit is needed.
  const { code } = await ctx.runner.run({
    cwd: join(ctx.soaRoot, 'infra'),
    command: 'make',
    args: meshMakeArgs(m, { project: ctx.project, offset }),
    env: {
      EXTRA_POSTGRES_SEED_DIR: '../../projects/saga-mesh/seed',
      ...(ctx.project ? { COMPOSE_PROJECT_NAME: ctx.project } : {}),
      ...(composeProfiles ? { COMPOSE_PROFILES: composeProfiles } : {}),
    },
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
    const ready = await pollReady(exec, container, unit.readinessCmd, unit.shell, unit.timeoutSec, ctx.sleep);
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
  shell: boolean | undefined,
  timeoutSec: number,
  sleep: (ms: number) => Promise<void> = (ms): Promise<void> =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let attempt = 0; attempt < timeoutSec; attempt += 1) {
    if (await exec.ready(container, readinessCmd, shell)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Pure argv builder for the readiness `docker exec`, split out so the
 * shell-vs-direct branch is testable without a real docker/child_process.
 * `shell: false` (openfga's distroless image, no `sh`) execs the
 * whitespace-split readinessCmd directly — only safe for a command with no
 * shell metacharacters, which is why it's opt-in per mesh unit, not the
 * default.
 */
export function meshExecArgs(container: string, readinessCmd: string, shell = true): string[] {
  return shell ? ['exec', container, 'sh', '-c', readinessCmd] : ['exec', container, ...readinessCmd.split(' ')];
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
    ready(container: string, readinessCmd: string, shell = true): Promise<boolean> {
      return new Promise((resolve) => {
        execFile('docker', meshExecArgs(container, readinessCmd, shell), (err) => {
          resolve(!err);
        });
      });
    },
  };
}
