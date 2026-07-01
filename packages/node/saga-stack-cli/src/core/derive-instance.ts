/**
 * derive-instance — the single pure factory for M7 multi-instance ("slots").
 *
 * `deriveInstance({ slot })` maps a numeric slot to an `InstanceProfile`: the
 * complete set of per-slot namespacing knobs (port offset, compose project,
 * state/snapshot dirs, mesh container-name overrides, seed profile, and the
 * generic per-service port-override map). It is the ONE place slot → concrete
 * values is computed; every downstream seam consumes the profile so no call
 * site ever hardcodes a slot-derived value.
 *
 * SLOT MODEL (plan §1): deterministic port-offset `offset = slot * 1000` +
 * project-suffixed namespace `soa-s<slot>`. Slot 0 returns TODAY'S constants
 * verbatim (offset 0, project `soa`, state `/tmp/sds-synthetic`, no snapshot
 * override, no container env) — the byte-identical regression guard: feeding
 * slot-0's `portOverrides`/`meshOffset` through `defaultLaunchContext` yields
 * exactly the no-offset context.
 *
 * PURITY: no docker/make/network IO. The only host-derived read is
 * `os.homedir()` for the per-slot snapshot root (matching `snapshot-store`'s
 * own default) — deterministic per host, no filesystem touch — which the fixed
 * `{ slot }` signature requires. `src/core/**` never imports `src/runtime/**`.
 *
 * The port-override map is derived GENERICALLY over `manifest.services` (never a
 * hand-maintained table), so any future service slots for free. After computing,
 * the factory ASSERTS full-set port disjointness (every service port + the five
 * mesh ports, each + offset) and throws on any collision — guarding a future
 * service whose base could land a multiple of the stride from another.
 */

import { homedir } from 'node:os';
import { getMesh, manifest as defaultManifest } from './manifest/index.js';
import type { Manifest, ServiceId } from './manifest/index.js';

/** The stride between adjacent slots' port bands. `offset = slot * STRIDE`. */
export const SLOT_PORT_STRIDE = 1000;

/**
 * The complete per-slot namespacing profile. Slot 0 is byte-identical to
 * today's implicit defaults (the regression guard); slot N ≥ 1 offsets ports by
 * `N * SLOT_PORT_STRIDE` into an isolated `soa-s<N>` stack.
 */
export interface InstanceProfile {
  /** The numeric slot this profile was derived for. */
  slot: number;
  /** Port offset applied to every service + mesh port (`slot * SLOT_PORT_STRIDE`). */
  offset: number;
  /** COMPOSE_PROJECT_NAME: `soa` at slot 0, `soa-s<N>` for N ≥ 1. */
  project: string;
  /** Default `--state-dir`: `/tmp/sds-synthetic` at slot 0, `…-s<N>` for N ≥ 1. */
  stateDir: string;
  /**
   * Per-slot snapshot root (`SAGA_MESH_SNAPSHOTS_DIR`). `undefined` at slot 0 so
   * `snapshot-store` falls back to today's `~/.saga-mesh/snapshots`; for N ≥ 1 an
   * isolated `~/.saga-mesh/snapshots-s<N>` root so a slot's fixtures can't clobber
   * another's.
   */
  snapshotsDir: string | undefined;
  /**
   * Mesh container-name overrides (the existing `SAGA_MESH_*_CONTAINER` seam).
   * Empty at slot 0 (manifest defaults win); for N ≥ 1 points every mesh
   * container at `soa-s<N>-<unit>-1`. Both mongo reader names are set — see the
   * note by `containerEnvFor`.
   */
  containerEnv: Record<string, string>;
  /** Seed profile — ALWAYS `empty` (load-bearing, plan §3): isolation comes from
   *  the project prefix, not the profile, and only `profile-empty.sql` exists. */
  seedProfile: 'empty';
  /** Per-service resolved port (manifest base + offset), keyed by service id. */
  portOverrides: Partial<Record<ServiceId, number>>;
  /** Offset fed to the mesh ports (postgres/rabbitmq/mongo) — equals `offset`. */
  meshOffset: number;
}

/**
 * The mesh container-name override env for slot N ≥ 1.
 *
 * IMPORTANT — two readers, two mongo names. The mesh readiness resolver
 * (`runtime/mesh.ts` `meshContainer`) derives its key from the unit id, so the
 * connect-mongo unit reads `SAGA_MESH_CONNECT_MONGO_CONTAINER`; the snapshot
 * store (`runtime/snapshot-store.ts` `mongoContainer`) reads the SHORTER
 * `SAGA_MESH_MONGO_CONTAINER`. postgres/redis/rabbitmq agree across both
 * readers. To isolate the mongo container for BOTH code paths at slot > 0 we set
 * both mongo keys to the same value. (At slot 0 this map is empty, so slot 0 is
 * unaffected regardless.)
 */
function containerEnvFor(slot: number): Record<string, string> {
  if (slot === 0) return {};
  const project = `soa-s${slot}`;
  return {
    SAGA_MESH_POSTGRES_CONTAINER: `${project}-postgres-1`,
    SAGA_MESH_REDIS_CONTAINER: `${project}-redis-1`,
    SAGA_MESH_RABBITMQ_CONTAINER: `${project}-rabbitmq-1`,
    // snapshot-store's `mongoContainer` reader:
    SAGA_MESH_MONGO_CONTAINER: `${project}-connect-mongo-1`,
    // mesh.ts's `meshContainer` reader (unit-id-derived key):
    SAGA_MESH_CONNECT_MONGO_CONTAINER: `${project}-connect-mongo-1`,
  };
}

/**
 * Assert the fully-resolved port set for one slot is collision-free: every
 * service port + the five mesh ports (postgres/redis/rabbitmq/rabbitmq-mgmt/
 * connect-mongo), each + offset. Throws a clear error on the first duplicate.
 * Stride 1000 is collision-free by construction today; this guards a FUTURE
 * service whose base could sit a multiple of the stride from another.
 */
function assertPortsDisjoint(slot: number, offset: number, m: Manifest): void {
  const ports: number[] = [];
  for (const id of Object.keys(m.services) as ServiceId[]) {
    ports.push(m.services[id].port + offset);
  }
  const rabbit = getMesh('rabbitmq', m);
  ports.push(
    getMesh('postgres', m).port + offset,
    getMesh('redis', m).port + offset,
    rabbit.port + offset,
    (rabbit.mgmtPort ?? 15672) + offset,
    getMesh('connect-mongo', m).port + offset,
  );

  const seen = new Set<number>();
  for (const p of ports) {
    if (seen.has(p)) {
      throw new Error(
        `deriveInstance(slot=${slot}): resolved port ${p} collides — the service + mesh ` +
          `port set is not disjoint under offset ${offset}. A base port must sit a multiple ` +
          `of the ${SLOT_PORT_STRIDE} stride from another; re-band the offending service.`,
      );
    }
    seen.add(p);
  }
}

/**
 * Map a numeric slot to its complete `InstanceProfile`. Pure (bar `os.homedir()`
 * for the snapshot root). Slot 0 returns today's constants verbatim; slot N ≥ 1
 * offsets everything into the `soa-s<N>` namespace. Throws on a negative slot or
 * a port-set collision.
 */
export function deriveInstance(
  { slot }: { slot: number },
  m: Manifest = defaultManifest,
): InstanceProfile {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`deriveInstance: slot must be a non-negative integer, got ${slot}`);
  }

  const offset = slot * SLOT_PORT_STRIDE;

  // Generic port-override map: every manifest service, offset applied. At slot 0
  // (offset 0) this is the base-port map, so `defaultLaunchContext` resolves the
  // same ports it would with no overrides — the byte-identical guard.
  const portOverrides: Partial<Record<ServiceId, number>> = {};
  for (const id of Object.keys(m.services) as ServiceId[]) {
    portOverrides[id] = m.services[id].port + offset;
  }

  assertPortsDisjoint(slot, offset, m);

  return {
    slot,
    offset,
    project: slot === 0 ? 'soa' : `soa-s${slot}`,
    stateDir: slot === 0 ? '/tmp/sds-synthetic' : `/tmp/sds-synthetic-s${slot}`,
    snapshotsDir: slot === 0 ? undefined : `${homedir()}/.saga-mesh/snapshots-s${slot}`,
    containerEnv: containerEnvFor(slot),
    seedProfile: 'empty',
    portOverrides,
    meshOffset: offset,
  };
}
