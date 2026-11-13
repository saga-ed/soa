import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeepReadiness, declareDependencies, rabbitDependency } from '../index.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const BUDGET = 15 * 60_000;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function setup(opts: { consuming?: boolean } = {}) {
  const T0 = Date.now();
  const broker = {
    connected: true,
    since: undefined as number | undefined,
    gaveUp: false,
    consuming: opts.consuming ?? true,
  };
  const conn = {
    isConnected: () => broker.connected,
    disconnectedSince: () => (broker.connected ? undefined : broker.since),
    reconnectGaveUp: () => broker.gaveUp,
    reconnectBudgetMs: () => BUDGET,
  };
  const dr = createDeepReadiness({
    manifest: declareDependencies({
      service: 'svc',
      dependencies: rabbitDependency({
        connection: () => conn,
        isConsuming: () => broker.consuming,
        now: () => Date.now(),
      }),
    }),
    intervalMs: 1000,
    minProbeGapMs: 0,
    staleAfterMs: 10 * 60 * 60_000,
    bootRetryDelayMs: 500,
    bootTimeoutMs: 3000,
    bootMode: 'block',
  });
  const drop = () => {
    broker.connected = false;
    broker.since = Date.now();
  };
  return { T0, broker, dr, drop };
}

async function up(s: ReturnType<typeof setup>) {
  await s.dr.boot();
  s.dr.start();
}

describe('rabbitDependency', () => {
  it('connected and consuming is ready', async () => {
    const s = setup();
    await up(s);
    expect(s.dr.report().verdict).toBe('ready');
    expect(s.dr.report().httpStatus).toBe(200);
  });

  it('broker down within budget is degraded (200)', async () => {
    const s = setup();
    await up(s);
    s.drop();
    await tick(5 * 60_000);
    const r = s.dr.report();
    expect(r.verdict).toBe('degraded');
    expect(r.httpStatus).toBe(200);
  });

  it('broker down past the budget is not_ready (503)', async () => {
    const s = setup();
    await up(s);
    s.drop();
    await tick(BUDGET + 5_000);
    const r = s.dr.report();
    expect(r.verdict).toBe('not_ready');
    expect(r.httpStatus).toBe(503);
  });

  it('reconnect gave up within budget is not_ready (503)', async () => {
    const s = setup();
    await up(s);
    s.drop();
    s.broker.gaveUp = true;
    await tick(5_000);
    expect(s.dr.report().httpStatus).toBe(503);
  });

  it('connected but not consuming is not_ready (503)', async () => {
    const s = setup();
    await up(s);
    s.broker.consuming = false;
    await tick(5_000);
    const r = s.dr.report();
    expect(r.verdict).toBe('not_ready');
    expect(r.httpStatus).toBe(503);
  });

  it('recovers to ready when the broker returns inside the budget', async () => {
    const s = setup();
    await up(s);
    s.drop();
    await tick(8 * 60_000);
    expect(s.dr.report().verdict).toBe('degraded');
    s.broker.connected = true;
    await tick(5_000);
    expect(s.dr.report().verdict).toBe('ready');
  });

  it('without isConsuming, connected is ready (publisher-only service)', async () => {
    const dr = createDeepReadiness({
      manifest: declareDependencies({
        service: 'svc',
        dependencies: rabbitDependency({
          connection: () => ({
            isConnected: () => true,
            disconnectedSince: () => undefined,
            reconnectGaveUp: () => false,
          }),
        }),
      }),
      bootMode: 'block',
      bootRetryDelayMs: 500,
      bootTimeoutMs: 3000,
    });
    await dr.boot();
    expect(dr.report().verdict).toBe('ready');
  });
});
