import type { EnvIdentity } from '@saga-ed/soa-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertManifestComplete,
  clearClientRegistry,
  createDeepReadiness,
  declareDependencies,
  dep,
  registerClient,
  type BootMode,
  type ProbeOutcome,
  type ReadinessEvent,
} from '../index.js';

const ident = (kind: 'prod' | 'dev' | 'local'): EnvIdentity => ({
  profile: kind === 'prod' ? 'prod' : 'dev',
  lane: 'none',
  telemetryEnv: kind,
  account: kind === 'local' ? { kind } : { kind, id: '123456789012' },
  row: kind === 'local' ? 'R4-local' : kind === 'prod' ? 'R1-prod' : 'R3-dev-overlay',
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Ctl = { fail: boolean | ProbeOutcome | Error; calls: number; schemaFail: boolean };
const ctl = (): Ctl => ({ fail: false, calls: 0, schemaFail: false });

function mk(
  opts: {
    scope?: 'task' | 'shared';
    optional?: boolean;
    bootMode?: BootMode;
    identity?: EnvIdentity;
    absent?: boolean;
    whenAbsent?: 'skipped' | 'fail';
    draining?: () => boolean;
    onEvent?: (e: ReadinessEvent) => void;
    schema?: boolean;
  } = {},
) {
  const c = ctl();
  const client = { id: 1 };
  const d = dep({
    name: 'db',
    kind: 'custom',
    ...(opts.optional ? { criticality: 'optional' as const } : { criticality: 'critical' as const, scope: opts.scope ?? 'shared' }),
    client: () => (opts.absent ? null : client),
    ...(opts.whenAbsent ? { whenAbsent: opts.whenAbsent } : {}),
    probe: async () => {
      c.calls++;
      if (c.fail instanceof Error) throw c.fail;
      if (c.fail === true) throw new Error('boom');
      if (c.fail) return c.fail;
    },
    ...(opts.schema
      ? {
          schemaProbe: async () => {
            if (c.schemaFail) throw Object.assign(new Error('no table'), { code: 'P2021' });
          },
        }
      : {}),
  });
  const dr = createDeepReadiness({
    manifest: declareDependencies({ service: 'svc', dependencies: [d] }),
    intervalMs: 1000,
    minProbeGapMs: 0,
    staleAfterMs: 10_000,
    bootRetryDelayMs: 500,
    bootTimeoutMs: 3000,
    bootMode: opts.bootMode ?? 'block',
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.draining ? { isDraining: opts.draining } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  return { c, dr };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('verdict transitions', () => {
  it('starting -> ready -> degraded (shared failure after first success) -> ready', async () => {
    const { c, dr } = mk();
    expect(dr.report().verdict).toBe('starting');
    expect(dr.report().httpStatus).toBe(503);
    dr.start();
    await tick(0);
    expect(dr.report().verdict).toBe('ready');
    expect(dr.report().httpStatus).toBe(200);

    c.fail = true;
    await tick(1300); // 1 failure < threshold 2
    expect(dr.report().verdict).toBe('ready');
    await tick(1300);
    const r = dr.report('internal');
    expect(r.verdict).toBe('degraded');
    expect(r.httpStatus).toBe(200);
    expect(r.dependencies?.[0]).toMatchObject({ state: 'failing', reason: 'error', criticality: 'critical', scope: 'shared' });

    c.fail = false;
    await tick(1300);
    expect(dr.report().verdict).toBe('ready');
    dr.stop();
  });

  it('never succeeded: stays starting (503) even when failing past threshold', async () => {
    const { c, dr } = mk();
    c.fail = true;
    dr.start();
    await tick(5000);
    expect(dr.report('internal').dependencies?.[0]?.state).toBe('failing');
    expect(dr.report().verdict).toBe('starting');
    dr.stop();
  });

  it('scope:task failure after first success => not_ready (503)', async () => {
    const { c, dr } = mk({ scope: 'task' });
    dr.start();
    await tick(0);
    c.fail = true;
    await tick(3000);
    expect(dr.report().verdict).toBe('not_ready');
    expect(dr.report().httpStatus).toBe(503);
    dr.stop();
  });

  it('auth/tls/dns failures after first success still degrade (shared by default)', async () => {
    for (const code of ['28P01', 'CERT_HAS_EXPIRED', 'ENOTFOUND']) {
      const { c, dr } = mk();
      dr.start();
      await tick(0);
      c.fail = Object.assign(new Error('x'), { code });
      await tick(3000);
      expect(dr.report().verdict).toBe('degraded');
      dr.stop();
    }
  });

  it('stale cache (blocked loop: probes stop refreshing) => not_ready even for shared', async () => {
    const { dr } = mk();
    dr.start();
    await tick(0);
    expect(dr.report().verdict).toBe('ready');
    vi.setSystemTime(Date.now() + 10_500); // wall clock moves, no timer callback ran = blocked loop
    expect(dr.report('internal').dependencies?.[0]?.state).toBe('stale');
    expect(dr.report().verdict).toBe('not_ready');
  });

  it('optional failure only degrades, including before first success', async () => {
    const { c, dr } = mk({ optional: true });
    dr.start();
    await tick(0);
    expect(dr.report().verdict).toBe('ready');
    c.fail = true;
    await tick(3000);
    expect(dr.report().verdict).toBe('degraded');
    dr.stop();
  });

  it('pool_exhausted is neutral: degraded, no failure count, never 503 even for scope:task', async () => {
    const { c, dr } = mk({ scope: 'task' });
    dr.start();
    await tick(0);
    c.fail = Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
    await tick(5000);
    const r = dr.report('internal');
    expect(r.verdict).toBe('degraded');
    expect(r.httpStatus).toBe(200);
    expect(r.dependencies?.[0]).toMatchObject({ state: 'degraded', reason: 'pool_exhausted', consecutiveFailures: 0 });
    c.fail = false;
    await tick(1300);
    expect(dr.report().verdict).toBe('ready');
    dr.stop();
  });

  it('draining wins and answers 503', async () => {
    let draining = false;
    const { dr } = mk({ draining: () => draining });
    dr.start();
    await tick(0);
    draining = true;
    expect(dr.report().verdict).toBe('draining');
    expect(dr.report().httpStatus).toBe(503);
    dr.stop();
  });

  it('emits verdict-change and probe_failure events with enum reasons only', async () => {
    const events: ReadinessEvent[] = [];
    const { c, dr } = mk({ onEvent: (e) => events.push(e) });
    dr.start();
    await tick(0);
    dr.report();
    c.fail = true;
    await tick(3000);
    dr.report();
    expect(events.filter((e) => e.type === 'verdict').map((e) => (e as { verdict: string }).verdict)).toEqual([
      'ready',
      'degraded',
    ]);
    expect(events.find((e) => e.type === 'probe_failure')).toEqual({ type: 'probe_failure', name: 'db', reason: 'error' });
    dr.stop();
  });
});

describe('observe()', () => {
  it('failures are metric-only: no state or verdict change', async () => {
    const events: ReadinessEvent[] = [];
    const { dr } = mk({ onEvent: (e) => events.push(e) });
    dr.start();
    await tick(0);
    for (let i = 0; i < 10; i++) dr.observe('db', 'failure', 'auth');
    const r = dr.report('internal');
    expect(r.verdict).toBe('ready');
    expect(r.dependencies?.[0]).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    expect(events.filter((e) => e.type === 'observed_failure')).toHaveLength(10);
    dr.observe('nope', 'failure');
    dr.stop();
  });

  it('traffic success suppresses the next active probe', async () => {
    const { c, dr } = mk();
    dr.start();
    await tick(0);
    const before = c.calls;
    for (let i = 0; i < 5; i++) {
      dr.observe('db', 'success');
      await tick(500);
    }
    expect(c.calls).toBe(before);
    dr.stop();
  });

  it('traffic success does not clear a failing state; only a probe does', async () => {
    const { c, dr } = mk();
    dr.start();
    await tick(0);
    c.fail = true;
    await tick(3000);
    dr.observe('db', 'success');
    expect(dr.report().verdict).toBe('degraded');
    dr.stop();
  });
});

describe('boot() and READINESS_BOOT', () => {
  it('block: resolves once the dependency succeeds (retrying)', async () => {
    const { c, dr } = mk();
    c.fail = true;
    const p = dr.boot();
    await tick(1200);
    c.fail = false;
    await tick(600);
    const r = await p;
    expect(r.verdict).toBe('ready');
    expect(r.bootMode).toBe('block');
  });

  it('block: rejects at the deadline naming the dependency and enum reason only', async () => {
    const { c, dr } = mk();
    c.fail = Object.assign(new Error('password=hunter2 host=10.0.0.5'), { code: '28P01' });
    const p = dr.boot().catch((e: Error) => e);
    await tick(4000);
    const err = (await p) as Error;
    expect(err.message).toContain('db(auth)');
    expect(err.message).not.toContain('hunter2');
    expect(err.message).not.toContain('10.0.0.5');
  });

  it('warn: boot resolves with a down dependency, /ready stays 503 starting', async () => {
    const { c, dr } = mk({ bootMode: 'warn' });
    c.fail = true;
    const r = await dr.boot();
    expect(r.bootMode).toBe('warn');
    expect(dr.report().verdict).toBe('starting');
    expect(dr.report().httpStatus).toBe(503);
  });

  it('open: task enters the TG degraded with a down dependency', async () => {
    const { c, dr } = mk({ bootMode: 'open' });
    c.fail = true;
    await dr.boot();
    const r = dr.report();
    expect(r.verdict).toBe('degraded');
    expect(r.httpStatus).toBe(200);
    expect(r.bootMode).toBe('open');
  });

  it('open never lifts the stale-cache 503', async () => {
    const { dr } = mk({ bootMode: 'open' });
    await dr.boot();
    dr.start();
    await tick(0);
    vi.setSystemTime(Date.now() + 10_500);
    expect(dr.report().verdict).toBe('not_ready');
    dr.stop();
  });

  it('per-dependency boot:skip/warn do not block', async () => {
    const c = ctl();
    c.fail = true;
    const dr = createDeepReadiness({
      manifest: declareDependencies({
        service: 's',
        dependencies: [
          dep({ name: 'a', kind: 'custom', criticality: 'critical', scope: 'shared', boot: 'warn', client: () => 1, probe: async () => { throw new Error('x'); } }),
          dep({ name: 'b', kind: 'custom', criticality: 'optional', client: () => 1, probe: async () => { throw new Error('x'); } }),
        ],
      }),
      bootMode: 'block',
    });
    await expect(dr.boot()).resolves.toBeDefined();
  });
});

describe('environment and absent clients (fail closed)', () => {
  it('local identity: absent client is skipped (ready)', async () => {
    const { dr } = mk({ absent: true, identity: ident('local') });
    dr.start();
    await tick(0);
    const r = dr.report('internal');
    expect(r.verdict).toBe('ready');
    expect(r.dependencies?.[0]?.state).toBe('skipped');
    dr.stop();
  });

  it.each([ident('prod'), ident('dev'), undefined])('identity %# : absent client fails closed', async (identity) => {
    const KEY = 'EXEC_ENV';
    const prev = process.env[KEY];
    process.env[KEY] = 'local';
    try {
      const { dr } = mk({ absent: true, ...(identity ? { identity } : {}) });
      dr.start();
      await tick(3000);
      expect(dr.report().verdict).toBe('starting');
      expect(dr.report('internal').dependencies?.[0]?.reason).toBe('not_ready');
      dr.stop();
    } finally {
      if (prev !== undefined) process.env[KEY] = prev;
      else delete process.env[KEY];
    }
  });

  it('explicit whenAbsent overrides the environment default', async () => {
    const { dr } = mk({ absent: true, identity: ident('prod'), whenAbsent: 'skipped' });
    dr.start();
    await tick(0);
    expect(dr.report().verdict).toBe('ready');
    dr.stop();
  });

  it('READINESS_BOOT parsing: unknown => block', async () => {
    const { parseBootMode } = await import('../index.js');
    expect(parseBootMode('warn')).toBe('warn');
    expect(parseBootMode('open')).toBe('open');
    expect(parseBootMode('skip')).toBe('block');
    expect(parseBootMode(undefined)).toBe('block');
  });
});

describe('identity on the report', () => {
  it('build carries the four identity fields and never account.id or row', async () => {
    const { dr } = mk({ identity: ident('dev') });
    const r = dr.report('internal');
    expect(r.build).toMatchObject({ profile: 'dev', lane: 'none', telemetryEnv: 'dev', accountKind: 'dev' });
    const text = JSON.stringify(r);
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('R3-dev-overlay');
    expect(dr.identity?.profile).toBe('dev');
  });

  it('no identity: build has no identity fields', () => {
    const { dr } = mk();
    expect(Object.keys(dr.report().build)).not.toContain('profile');
    expect(dr.identity).toBeUndefined();
  });
});

describe('deepReport()', () => {
  it('schemaProbe failure is deep-only: /ready stays ready, deep is not_ready for a critical dep', async () => {
    const { c, dr } = mk({ schema: true });
    dr.start();
    await tick(0);
    c.schemaFail = true;
    expect(dr.report().verdict).toBe('ready');
    const deep = await dr.deepReport('internal');
    expect(deep.verdict).toBe('not_ready');
    expect(deep.dependencies?.[0]).toMatchObject({ state: 'failing', reason: 'schema', level: 'deep' });
    expect(dr.report().verdict).toBe('ready');
    dr.stop();
  });

  it('caches and coalesces concurrent deep calls', async () => {
    const { c, dr } = mk();
    await dr.boot();
    const base = c.calls;
    await Promise.all([dr.deepReport(), dr.deepReport(), dr.deepReport()]);
    expect(c.calls).toBe(base + 1);
    await dr.deepReport();
    expect(c.calls).toBe(base + 1);
    await tick(6000);
    await dr.deepReport();
    expect(c.calls).toBe(base + 2);
  });

  it('minProbeGapMs: a deep flood cannot exceed one probe per gap', async () => {
    const c = ctl();
    const dr = createDeepReadiness({
      manifest: declareDependencies({
        service: 's',
        dependencies: [dep({ name: 'a', kind: 'custom', criticality: 'optional', client: () => 1, probe: async () => void c.calls++ })],
      }),
      deepCacheMs: 0,
      minProbeGapMs: 1000,
    });
    for (let i = 0; i < 10; i++) await dr.deepReport();
    expect(c.calls).toBe(1);
    await tick(1100);
    await dr.deepReport();
    expect(c.calls).toBe(2);
  });
});

describe('public vs internal detail and security', () => {
  it('public has counts only; internal adds dependencies and legacy checks; no secrets either way', async () => {
    const { c, dr } = mk();
    c.fail = Object.assign(new Error('postgres://u:pw@10.1.2.3/db'), { code: '28P01' });
    dr.start();
    await tick(3000);
    const pub = dr.report('public');
    expect(pub.dependencies).toBeUndefined();
    expect(pub.checks).toBeUndefined();
    expect(pub.summary.critical).toEqual({ ok: 0, failing: 1 });
    const internal = dr.report('internal');
    expect(internal.dependencies).toHaveLength(1);
    expect(internal.checks?.db).toEqual({ ready: false, detail: 'failing:auth' });
    const text = JSON.stringify([pub, internal]);
    expect(text).not.toContain('pw@');
    expect(text).not.toContain('10.1.2.3');
    dr.stop();
  });
});

describe('manifest guards', () => {
  it('declareDependencies rejects duplicates, custom/openfga/aws without probe, critical without scope', () => {
    const bad = (d: unknown) => d as ReturnType<typeof dep>;
    expect(() =>
      declareDependencies({ service: 's', dependencies: [dep({ name: 'x', kind: 'custom', criticality: 'optional', client: () => 1 }), dep({ name: 'x', kind: 'redis', criticality: 'optional', client: () => 1 })] }),
    ).toThrow(/duplicate.*no probe|no probe.*duplicate/);
    expect(() => declareDependencies({ service: 's', dependencies: [dep({ name: 'f', kind: 'openfga', criticality: 'optional', client: () => 1 })] })).toThrow(/no probe/);
    expect(() => declareDependencies({ service: 's', dependencies: [dep({ name: 'k', kind: 'aws-kms', criticality: 'optional', client: () => 1 })] })).toThrow(/no probe/);
    expect(() =>
      declareDependencies({ service: 's', dependencies: [bad({ name: 'r', kind: 'redis', criticality: 'critical', client: () => 1 })] }),
    ).toThrow(/no scope/);
  });

  it('assertManifestComplete: undeclared discovered client fails; registry diff works', () => {
    const m = declareDependencies({ service: 's', dependencies: [dep({ name: 'db', kind: 'redis', criticality: 'optional', client: () => 1 })] });
    expect(() => assertManifestComplete(m, { discover: ['db'] })).not.toThrow();
    expect(() => assertManifestComplete(m, { discover: ['db', 'rabbit'] })).toThrow(/"rabbit".*not declared/);
    clearClientRegistry();
    registerClient('db');
    registerClient('mongo');
    expect(() => assertManifestComplete(m, { useRegistry: true })).toThrow(/"mongo"/);
    clearClientRegistry();
  });
});

describe('freshProbe', () => {
  // Jitter factor 1.0: cadence assertions are exact.
  beforeEach(() => void vi.spyOn(Math, 'random').mockReturnValue(0.5));
  afterEach(() => vi.restoreAllMocks());

  const authErr = () => Object.assign(new Error('PAM authentication failed for user "app"'), { code: '28000' });

  function mkFresh(
    o: { scope?: 'task' | 'shared'; freshIntervalMs?: number; minProbeGapMs?: number; deepCacheMs?: number; bootMode?: BootMode } = {},
  ) {
    const c = { pooledFail: false, freshFail: false as boolean | Error, pooledCalls: 0, freshCalls: 0 };
    const d = dep({
      name: 'db',
      kind: 'custom',
      criticality: 'critical' as const,
      scope: o.scope ?? 'shared',
      client: () => ({}),
      probe: async () => {
        c.pooledCalls++;
        if (c.pooledFail) throw new Error('boom');
      },
      freshProbe: async () => {
        c.freshCalls++;
        if (c.freshFail instanceof Error) throw c.freshFail;
        if (c.freshFail) throw new Error('boom');
      },
      freshIntervalMs: o.freshIntervalMs ?? 10_000,
    });
    const dr = createDeepReadiness({
      manifest: declareDependencies({ service: 'svc', dependencies: [d] }),
      intervalMs: 1000,
      minProbeGapMs: o.minProbeGapMs ?? 0,
      ...(o.deepCacheMs !== undefined ? { deepCacheMs: o.deepCacheMs } : {}),
      staleAfterMs: 60_000,
      bootRetryDelayMs: 500,
      bootTimeoutMs: 3000,
      bootMode: o.bootMode ?? 'block',
    });
    return { c, dr };
  }

  it('fresh failure after first success degrades (shared) with reason auth; pooled stays healthy', async () => {
    const { c, dr } = mkFresh();
    await dr.boot();
    dr.start();
    expect(dr.report().verdict).toBe('ready');
    c.freshFail = authErr();
    await tick(10_500); // first failing fresh probe at 10s; retry at 11s
    expect(dr.report().verdict).toBe('ready'); // 1 < failureThreshold
    await tick(1000); // retries at the pooled cadence while failing
    const r = dr.report('internal');
    expect(r.verdict).toBe('degraded');
    expect(r.httpStatus).toBe(200);
    expect(r.dependencies?.[0]).toMatchObject({ state: 'failing', reason: 'auth', consecutiveFailures: 2 });
    dr.stop();
  });

  it('fresh failure after first success with scope:task => not_ready', async () => {
    const { c, dr } = mkFresh({ scope: 'task' });
    await dr.boot();
    dr.start();
    c.freshFail = authErr();
    await tick(15_000);
    expect(dr.report().verdict).toBe('not_ready');
    expect(dr.report().httpStatus).toBe(503);
    dr.stop();
  });

  it('pooled success and observe() success do not clear a fresh failure; next fresh success recovers', async () => {
    const { c, dr } = mkFresh();
    await dr.boot();
    dr.start();
    c.freshFail = authErr();
    await tick(15_000);
    expect(dr.report().verdict).toBe('degraded');
    const pooledBefore = c.pooledCalls;
    await tick(5000); // pooled probes keep succeeding
    expect(c.pooledCalls).toBeGreaterThan(pooledBefore);
    dr.observe('db', 'success');
    expect(dr.report().verdict).toBe('degraded');
    expect(dr.report('internal').dependencies?.[0]?.state).toBe('failing');

    c.freshFail = false;
    await tick(1500);
    expect(dr.report().verdict).toBe('ready');
    expect(dr.report('internal').dependencies?.[0]).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    dr.stop();
  });

  it('before first fresh success the dependency gates readiness even if pooled probe succeeds', async () => {
    const { c, dr } = mkFresh();
    c.freshFail = authErr();
    dr.start();
    await tick(5000);
    expect(dr.report('internal').dependencies?.[0]?.state).toBe('failing');
    expect(dr.report().verdict).toBe('starting');
    expect(dr.report().httpStatus).toBe(503);
    c.freshFail = false;
    await tick(1500);
    expect(dr.report().verdict).toBe('ready');
    dr.stop();
  });

  it('boot blocks until a fresh success, and rejects at the deadline without one', async () => {
    const a = mkFresh();
    a.c.freshFail = true;
    const p = a.dr.boot();
    await tick(1200);
    expect(a.c.freshCalls).toBeGreaterThan(1);
    let settled = false;
    void p.then(() => (settled = true));
    await tick(0);
    expect(settled).toBe(false);
    a.c.freshFail = false;
    await tick(600);
    expect((await p).verdict).toBe('ready');

    const b = mkFresh();
    b.c.freshFail = authErr();
    const q = b.dr.boot();
    const assertion = expect(q).rejects.toThrow(/db\(auth\)/);
    await tick(4000);
    await assertion;
  });

  it('cadence: runs on freshIntervalMs (+-20%), independent of the pooled interval', async () => {
    const { c, dr } = mkFresh({ freshIntervalMs: 10_000 });
    await dr.boot();
    dr.start();
    expect(c.freshCalls).toBe(1);
    await tick(7000);
    expect(c.freshCalls).toBe(1);
    expect(c.pooledCalls).toBeGreaterThan(3);
    await tick(5500); // 12.5s since start: first scheduled run (10s) has fired, second (20s) has not
    expect(c.freshCalls).toBe(2);
    dr.stop();
  });

  it('one fresh probe in flight at a time', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const dr = createDeepReadiness({
      manifest: declareDependencies({
        service: 's',
        dependencies: [
          dep({
            name: 'a',
            kind: 'custom',
            criticality: 'optional',
            client: () => 1,
            probe: async () => undefined,
            freshProbe: () => {
              calls++;
              return new Promise<void>((r) => (release = r));
            },
            timeoutMs: 60_000,
          }),
        ],
      }),
      deepCacheMs: 0,
      minProbeGapMs: 0,
    });
    const first = dr.deepReport();
    void dr.deepReport();
    void dr.deepReport();
    await tick(0);
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('deep flood opens at most one fresh probe per minProbeGapMs', async () => {
    const { c, dr } = mkFresh({ minProbeGapMs: 1000, deepCacheMs: 0 });
    for (let i = 0; i < 10; i++) await dr.deepReport();
    expect(c.freshCalls).toBe(1);
    await tick(1100);
    await dr.deepReport();
    expect(c.freshCalls).toBe(2);
  });

  it('fresh timeout is a timeout failure through the same classifier', async () => {
    const events: ReadinessEvent[] = [];
    const dr = createDeepReadiness({
      manifest: declareDependencies({
        service: 's',
        dependencies: [
          dep({
            name: 'a',
            kind: 'custom',
            criticality: 'optional',
            client: () => 1,
            probe: async () => undefined,
            freshProbe: () => new Promise<void>(() => undefined),
            timeoutMs: 500,
          }),
        ],
      }),
      onEvent: (e) => events.push(e),
    });
    const p = dr.deepReport('internal');
    await tick(600);
    const r = await p;
    expect(events).toContainEqual({ type: 'probe_failure', name: 'a', reason: 'timeout' });
    expect(r.dependencies?.[0]?.reason).toBe('timeout');
  });
});
