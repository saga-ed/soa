/**
 * launch-plan × M7 slot tests (plan §5 — the split-brain guard).
 *
 * `defaultLaunchContext`'s `meshOffset` input must offset the mesh connection
 * strings (`MESH_MQ` / `CONNECT_MONGO_URI` / `CONNECT_MONGO_PORT` / every
 * `*_DB_URL`) in lockstep with the mesh's published ports — else a slot's
 * services would publish on offset ports but dial the base mesh (split brain).
 * Slot 0 (offset 0, via `deriveInstance(0)`'s profile) must be byte-identical to
 * the pre-M7 no-offset context — the regression guard. Pure: fake repo roots.
 */

import { describe, expect, it } from 'vitest';
import { deriveInstance } from '../derive-instance.js';
import { defaultLaunchContext } from '../launch-plan.js';
import { getMesh, manifest } from '../manifest/index.js';
import type { RepoKey } from '../manifest/index.js';

const REPO_ROOTS: Record<RepoKey, string> = {
  SOA: '/w/soa',
  ROSTERING: '/w/rostering',
  PROGRAM_HUB: '/w/program-hub',
  SAGA_DASH: '/w/saga-dash',
  COACH: '/w/coach',
  SDS: '/w/student-data-system',
  QBOARD: '/w/qboard',
  RTSM: '/w/rtsm',
  FLEEK: '/w/fleek',
};

const baseInputs = { repoRoots: REPO_ROOTS, vendorDir: '/w/vendor' };

/** Extract the `host:port` from a URL-ish token for a robust port assertion. */
const portOf = (s: string): number => Number(new URL(s).port);

describe('defaultLaunchContext meshOffset — mesh connection strings offset in lockstep', () => {
  const offset = 1000;
  const ctx = defaultLaunchContext({ ...baseInputs, meshOffset: offset });

  const pgBase = getMesh('postgres').port;
  const mqBase = getMesh('rabbitmq').port;
  const mongoBase = getMesh('connect-mongo').port;

  it('offsets MESH_MQ (rabbitmq port)', () => {
    expect(portOf(ctx.tokens.MESH_MQ)).toBe(mqBase + offset);
  });

  it('offsets CONNECT_MONGO_URI + CONNECT_MONGO_PORT (mongo port)', () => {
    expect(portOf(ctx.tokens.CONNECT_MONGO_URI)).toBe(mongoBase + offset);
    expect(ctx.tokens.CONNECT_MONGO_PORT).toBe(String(mongoBase + offset));
  });

  it('offsets REDIS_PORT (redis port) — iam-api dials its slot, not slot 0', () => {
    const redisBase = getMesh('redis').port;
    expect(ctx.tokens.REDIS_PORT).toBe(String(redisBase + offset)); // 7379 at slot 1
    // slot 0 (no offset) stays at the 6379 default services already assumed.
    expect(defaultLaunchContext(baseInputs).tokens.REDIS_PORT).toBe(String(redisBase));
  });

  it('offsets every *_DB_URL (postgres port)', () => {
    for (const url of [
      ctx.tokens.SIS_DB_URL,
      ctx.tokens.PROGRAMS_DB_URL,
      ctx.tokens.SCHEDULING_DB_URL,
      ctx.tokens.SESSIONS_DB_URL,
      ctx.tokens.CONTENT_DB_URL,
      ctx.tokens.COACH_DB_URL,
    ]) {
      expect(portOf(url)).toBe(pgBase + offset);
    }
  });
});

describe('slot 0 launch context is byte-identical to the pre-M7 no-offset build', () => {
  it('deriveInstance(0) profile fed through defaultLaunchContext == no overrides', () => {
    const profile = deriveInstance({ slot: 0 });
    const slot0 = defaultLaunchContext({
      ...baseInputs,
      portOverrides: profile.portOverrides,
      meshOffset: profile.meshOffset,
    });
    const legacy = defaultLaunchContext(baseInputs);
    expect(slot0).toEqual(legacy);
  });

  it('slot 1 ports differ from slot 0 (sanity: the offset actually moves things)', () => {
    const p1 = deriveInstance({ slot: 1 });
    const ctx1 = defaultLaunchContext({
      ...baseInputs,
      portOverrides: p1.portOverrides,
      meshOffset: p1.meshOffset,
    });
    const legacy = defaultLaunchContext(baseInputs);
    expect(ctx1.ports['iam-api']).toBe((legacy.ports['iam-api'] ?? 0) + 1000);
    expect(ctx1.tokens.MESH_MQ).not.toBe(legacy.tokens.MESH_MQ);
    // manifest is untouched (deriveInstance is pure).
    expect(manifest.services['iam-api'].port).toBe(legacy.ports['iam-api']);
  });
});
