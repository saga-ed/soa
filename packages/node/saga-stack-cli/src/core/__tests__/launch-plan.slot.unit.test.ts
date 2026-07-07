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
import { defaultLaunchContext, resolveLaunchEnv } from '../launch-plan.js';
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
      // IAM_DB_URL / IAM_PII_DB_URL: the iam-api SERVER's runtime URLs (gh_214
      // acceptance find — without launch-env injection iam-api inherited
      // $ROSTERING/.env's :5432 and dialed slot 0's postgres at slot > 0).
      ctx.tokens.IAM_DB_URL,
      ctx.tokens.IAM_PII_DB_URL,
      ctx.tokens.SIS_DB_URL,
      ctx.tokens.PROGRAMS_DB_URL,
      ctx.tokens.SCHEDULING_DB_URL,
      ctx.tokens.SESSIONS_DB_URL,
      ctx.tokens.CONTENT_DB_URL,
      ctx.tokens.COACH_DB_URL,
      ctx.tokens.ADS_ADM_DB_URL,
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

describe('M13 listen-port fix — portEnvVar services are TOLD their offset port', () => {
  it('slot 1: programs/scheduling/sessions launch env carries PORT=<base+1000>', () => {
    const p1 = deriveInstance({ slot: 1 });
    const ctx1 = defaultLaunchContext({
      ...baseInputs,
      portOverrides: p1.portOverrides,
      meshOffset: p1.meshOffset,
    });
    for (const id of ['programs-api', 'scheduling-api', 'sessions-api'] as const) {
      const env = resolveLaunchEnv(id, 'stack', ctx1);
      expect(env.PORT).toBe(String(manifest.services[id].port + 1000));
    }
  });

  it('slot 0: no PORT injected (byte-identical no-offset env)', () => {
    const ctx0 = defaultLaunchContext(baseInputs);
    for (const id of ['programs-api', 'scheduling-api', 'sessions-api'] as const) {
      const env = resolveLaunchEnv(id, 'stack', ctx0);
      expect(env.PORT).toBeUndefined();
    }
  });

  it('an explicit launch.env template for the same var still wins (iam-api)', () => {
    // iam-api's template already sets PORT via ${IAM_PORT}; the injection must
    // not clobber it (they agree numerically, but the template is authoritative).
    const p1 = deriveInstance({ slot: 1 });
    const ctx1 = defaultLaunchContext({
      ...baseInputs,
      portOverrides: p1.portOverrides,
      meshOffset: p1.meshOffset,
    });
    const env = resolveLaunchEnv('iam-api', 'stack', ctx1);
    expect(env.PORT).toBe(String(manifest.services['iam-api'].port + 1000));
  });
});

describe('ads-adm-api slottability — tokenized env + EXPRESS_SERVER_PORT injection', () => {
  const slotCtx = (slot: number) => {
    const p = deriveInstance({ slot });
    return defaultLaunchContext({
      ...baseInputs,
      portOverrides: p.portOverrides,
      meshOffset: p.meshOffset,
    });
  };

  it('slot 1: launch env carries EXPRESS_SERVER_PORT=<5005+1000> (listen-port seam)', () => {
    const env = resolveLaunchEnv('ads-adm-api', 'stack', slotCtx(1));
    expect(env.EXPRESS_SERVER_PORT).toBe(String(manifest.services['ads-adm-api'].port + 1000));
  });

  it('slot 2: every cross-service/mesh URL dials the SLOT (+2000), never slot 0', () => {
    const env = resolveLaunchEnv('ads-adm-api', 'stack', slotCtx(2));
    expect(env.EXPRESS_SERVER_PORT).toBe('7005'); // 5005 + 2000
    expect(env.SESSIONS_API_CLIENT_BASEURL).toBe('http://localhost:5007'); // 3007 + 2000
    expect(env.IAM_API_CLIENT_BASEURL).toBe('http://localhost:5010/trpc'); // 3010 + 2000
    expect(env.IAM_API_URL).toBe('http://localhost:5010');
    expect(env.CORS_ORIGIN).toBe('http://localhost:10900'); // dash 8900 + 2000
    expect(portOf(env.DATABASE_URL)).toBe(getMesh('postgres').port + 2000);
    expect(portOf(env.ADS_ADM_DATABASE_URL)).toBe(getMesh('postgres').port + 2000);
    expect(portOf(env.RABBITMQ_URL)).toBe(getMesh('rabbitmq').port + 2000);
    // no base-port literal survives anywhere in the resolved env.
    for (const v of Object.values(env)) {
      expect(v).not.toMatch(/localhost:(3007|3010|5432|5672|8900)\b/);
    }
  });

  it('slot 0: byte-identical to the pre-tokenization literals (no injection)', () => {
    const env = resolveLaunchEnv('ads-adm-api', 'stack', slotCtx(0));
    expect(env.EXPRESS_SERVER_PORT).toBeUndefined(); // no offset ⇒ no injection
    expect(env.SESSIONS_API_CLIENT_BASEURL).toBe('http://localhost:3007');
    expect(env.IAM_API_CLIENT_BASEURL).toBe('http://localhost:3010/trpc');
    expect(env.ADS_ADM_DATABASE_URL).toBe('postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local');
    expect(env.DATABASE_URL).toBe('postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local');
    expect(env.CORS_ORIGIN).toBe('http://localhost:8900');
  });
});
