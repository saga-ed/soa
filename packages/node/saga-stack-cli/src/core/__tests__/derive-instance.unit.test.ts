/**
 * derive-instance unit tests (M7 Phase 1, plan §5).
 *
 * The bulk of Phase-1 confidence: `deriveInstance` is pure, so the slot → profile
 * contract, the byte-identical slot-0 regression guard, and the cross-slot
 * port-disjointness property are all fully asserted here with no docker/make/IO.
 * Paired with `launch-plan.slot.unit.test.ts` (the `meshOffset` split-brain guard)
 * and `base-command.slot.unit.test.ts` (the slot > 0 Phase-2 rejection).
 */

import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  SLOT_EXCLUDED_SERVICES,
  SLOT_PORT_STRIDE,
  deriveInstance,
  slotExcludedServices,
} from '../derive-instance.js';
import { getMesh, manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

/** The base-port override map (offset 0) — what slot 0 must produce verbatim. */
const basePortOverrides = (): Partial<Record<ServiceId, number>> => {
  const out: Partial<Record<ServiceId, number>> = {};
  for (const id of Object.keys(manifest.services) as ServiceId[]) {
    out[id] = manifest.services[id].port;
  }
  return out;
};

describe('deriveInstance(0) — the byte-identical regression guard', () => {
  const p = deriveInstance({ slot: 0 });

  it('returns today\'s constants verbatim', () => {
    expect(p.slot).toBe(0);
    expect(p.offset).toBe(0);
    expect(p.meshOffset).toBe(0);
    expect(p.project).toBe('soa');
    expect(p.stateDir).toBe('/tmp/sds-synthetic');
    expect(p.snapshotsDir).toBeUndefined();
    expect(p.containerEnv).toEqual({});
    expect(p.seedProfile).toBe('empty');
  });

  it('portOverrides is the base-port map (offset 0)', () => {
    expect(p.portOverrides).toEqual(basePortOverrides());
  });
});

describe('deriveInstance(N) for N ∈ {1,2,3}', () => {
  it.each([1, 2, 3])('offsets everything into the soa-s%i namespace', (slot) => {
    const p = deriveInstance({ slot });
    const offset = slot * SLOT_PORT_STRIDE;

    expect(p.slot).toBe(slot);
    expect(p.offset).toBe(offset);
    expect(p.meshOffset).toBe(offset);
    expect(p.project).toBe(`soa-s${slot}`);
    expect(p.stateDir).toBe(`/tmp/sds-synthetic-s${slot}`);
    expect(p.snapshotsDir).toBe(`${homedir()}/.saga-mesh/snapshots-s${slot}`);
    expect(p.seedProfile).toBe('empty');

    // container env — every mesh container repointed at soa-s<N>-<unit>-1; both
    // mongo reader names (mesh.ts `meshContainer` + snapshot-store `mongoContainer`).
    expect(p.containerEnv).toEqual({
      SAGA_MESH_POSTGRES_CONTAINER: `soa-s${slot}-postgres-1`,
      SAGA_MESH_REDIS_CONTAINER: `soa-s${slot}-redis-1`,
      SAGA_MESH_RABBITMQ_CONTAINER: `soa-s${slot}-rabbitmq-1`,
      SAGA_MESH_MONGO_CONTAINER: `soa-s${slot}-connect-mongo-1`,
      SAGA_MESH_CONNECT_MONGO_CONTAINER: `soa-s${slot}-connect-mongo-1`,
    });

    // every service port offset by exactly N*1000.
    for (const id of Object.keys(manifest.services) as ServiceId[]) {
      expect(p.portOverrides[id]).toBe(manifest.services[id].port + offset);
    }
  });
});

describe('no-collision property — union of ALL resolved ports is duplicate-free over slots 0..8', () => {
  it('has no port shared across any two slots', () => {
    const all: number[] = [];
    for (let slot = 0; slot <= 8; slot += 1) {
      const p = deriveInstance({ slot });
      const offset = slot * SLOT_PORT_STRIDE;
      // service ports
      for (const id of Object.keys(p.portOverrides) as ServiceId[]) {
        all.push(p.portOverrides[id] as number);
      }
      // mesh ports (postgres/redis/rabbitmq/rabbitmq-mgmt/connect-mongo)
      const rabbit = getMesh('rabbitmq');
      all.push(
        getMesh('postgres').port + offset,
        getMesh('redis').port + offset,
        rabbit.port + offset,
        (rabbit.mgmtPort ?? 15672) + offset,
        getMesh('connect-mongo').port + offset,
      );
    }
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('literal-port service exclusion (plan §6)', () => {
  it('slot 0 excludes nothing (byte-identical bring-up)', () => {
    expect(deriveInstance({ slot: 0 }).excludedServices).toEqual([]);
    expect(slotExcludedServices(0)).toEqual([]);
  });

  it('slot > 0 excludes ONLY the literal-port playback trio, NOT saga-dash/coach-web/ads-adm-api/connect-api/connect-web', () => {
    const excluded = deriveInstance({ slot: 1 }).excludedServices;
    expect(excluded).toEqual([...SLOT_EXCLUDED_SERVICES]);
    expect(new Set(excluded)).toEqual(
      new Set([
        // literal-port backends (bypass the offset) — the ONLY remaining exclusions
        'transcripts-api',
        'insights-api',
        'chat-api',
      ]),
    );
    // saga-dash & coach-web listen on their offset port now (launch-seam --port).
    expect(excluded).not.toContain('saga-dash');
    expect(excluded).not.toContain('coach-web');
    // ads-adm-api is slottable now: tokenized launch env + EXPRESS_SERVER_PORT
    // listen-port injection (M13 seam) — no longer excluded.
    expect(excluded).not.toContain('ads-adm-api');
    // connect-api is slottable now (soa#271): SESSIONS_API_BASE_URL tokenized to
    // ${SESSIONS_PORT}; its AV literals stay slot-0 but AV bring-up is slot-0-gated.
    expect(excluded).not.toContain('connect-api');
    // connect-web is slottable now too (soa#271): offset --port + browser-edge backends;
    // AV is SHARED (a slot>0 Connect session opens its own rooms on the one slot-0 livekit).
    expect(excluded).not.toContain('connect-web');
    expect(slotExcludedServices(3)).toEqual([...SLOT_EXCLUDED_SERVICES]);
  });
});

describe('two-slot (1 vs 2) — the full resolved port set is disjoint', () => {
  it('no service port and no mesh port is shared between slot 1 and slot 2', () => {
    const collect = (slot: number): number[] => {
      const p = deriveInstance({ slot });
      const offset = slot * SLOT_PORT_STRIDE;
      const rabbit = getMesh('rabbitmq');
      return [
        ...(Object.keys(p.portOverrides) as ServiceId[]).map((id) => p.portOverrides[id] as number),
        getMesh('postgres').port + offset,
        getMesh('redis').port + offset,
        rabbit.port + offset,
        (rabbit.mgmtPort ?? 15672) + offset,
        getMesh('connect-mongo').port + offset,
      ];
    };
    const s1 = collect(1);
    const s2 = collect(2);
    // no intersection, and the union is duplicate-free.
    const union = [...s1, ...s2];
    expect(new Set(union).size).toBe(union.length);
    expect(s1.some((p) => s2.includes(p))).toBe(false);
  });
});

describe('input validation', () => {
  it('rejects a negative slot', () => {
    expect(() => deriveInstance({ slot: -1 })).toThrow(/non-negative integer/);
  });

  it('rejects a non-integer slot', () => {
    expect(() => deriveInstance({ slot: 1.5 })).toThrow(/non-negative integer/);
  });
});
