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
 * SLOT > 0 IS A BACKEND + saga-dash/coach FRONTEND SUB-STACK (connect excluded
 * pending tokenization). Slot > 0 brings up the backend mesh + services —
 * `iam/programs/scheduling/sessions/content/sis/rtsm/coach-api` + the mesh — PLUS
 * the `saga-dash` and `coach-web` frontends, which now listen on their OFFSET port
 * (the launch seam appends `--port <base+offset>` to their `pnpm dev`; vite honours
 * the last `--port`, overriding the port baked into the repo dev script / vite
 * config). The literal-port backends stay EXCLUDED (`SLOT_EXCLUDED_SERVICES`):
 * `connect-api` carries literal cross-slot ports (`:3007` sessions, `ws://…:7880`
 * livekit) that bypass the offset and would split-brain onto slot 0's stateful
 * services, so `connect-web` (which depends on it) is excluded too until connect
 * is tokenized (the remaining fast-follow). saga-dash/coach frontend→backend edges
 * are `browser` and don't pull the excluded literal-port services, so their
 * backend closures are fully slottable today.
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
 * Services EXCLUDED from a slot > 0 bring-up (plan §6 collision matrix). All
 * would CLOBBER or SPLIT-BRAIN onto slot 0:
 *
 *   LITERAL-PORT backends — carry LITERAL ports in their launch env that bypass
 *   the generic `${…_PORT}` / mesh-offset token machinery, so at an offset slot
 *   they would still dial slot 0's ports (postgres :5432, sessions :3007, iam
 *   :3010, dash CORS :8900, EXPRESS_SERVER_PORT 6301-6303, livekit ws :7880) and
 *   silently corrupt / collide with the default stack:
 *     - `ads-adm-api`    — literal `@localhost:5432`, `:3007`, `:3010`, CORS `:8900`.
 *     - `connect-api`    — literal `SESSIONS_API_BASE_URL :3007` + livekit `ws :7880`;
 *                          would read/write slot 0's stateful sessions-api.
 *     - the playback trio — literal `POSTGRES_PORT '5432'` + `EXPRESS_SERVER_PORT`.
 *
 *   `connect-web` FRONTEND — depends on `connect-api` (a browser edge), which is
 *   excluded above for its un-tokenized literal ports. connect-web itself now has
 *   a listen-port seam (the launch layer appends `--port` for any `isFrontend`
 *   service at an offset slot), so it is excluded ONLY because its backend isn't
 *   slottable yet. FAST-FOLLOW: tokenize connect-api's `:3007`/`ws://…:7880`
 *   literals, then drop both `connect-api` and `connect-web` from this list.
 *
 * The OTHER two frontends — `saga-dash` and `coach-web` — are NO LONGER excluded:
 * they listen on their offset port via the launch-seam `--port` append, and their
 * backend deps (iam/programs/scheduling/sessions/content/sis, coach-api) all run at
 * slot > 0. Their frontend→backend edges are `browser`, so they don't pull the
 * excluded literal-port services.
 *
 * Consequence: slot > 0 is a backend + saga-dash/coach frontend sub-stack (see the
 * file header). Services are excluded EXPLICITLY (not via transitive drop, which
 * would orphan a dependent). At slot 0 nothing is excluded (the set is empty), so
 * slot 0 is unaffected.
 */
export const SLOT_EXCLUDED_SERVICES: readonly ServiceId[] = [
  // literal-port backends (bypass the offset)
  'ads-adm-api',
  'connect-api',
  'transcripts-api',
  'insights-api',
  'chat-api',
  // connect-web frontend — excluded pending connect-api port tokenization (fast-follow)
  'connect-web',
];

/**
 * The services excluded from a bring-up at `slot`: `[]` at slot 0 (byte-identical
 * regression guard), `SLOT_EXCLUDED_SERVICES` for N ≥ 1. Pure.
 */
export function slotExcludedServices(slot: number): ServiceId[] {
  return slot === 0 ? [] : [...SLOT_EXCLUDED_SERVICES];
}

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
  /**
   * Services excluded from THIS slot's bring-up closure (literal-port services
   * that bypass the offset — see `SLOT_EXCLUDED_SERVICES`). Empty at slot 0.
   */
  excludedServices: ServiceId[];
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
    excludedServices: slotExcludedServices(slot),
  };
}
