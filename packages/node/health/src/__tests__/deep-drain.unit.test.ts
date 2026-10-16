import { describe, it, expect } from 'vitest';
import { mountHealthRoutes, type HealthRouter } from '../health.js';
import { mountReadinessRoutes, type ReadinessRouter } from '../readiness.js';
import { createDrainSignal } from '../drain.js';

function fakeApp() {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const app: HealthRouter & ReadinessRouter = {
    get(path, handler) {
      routes.set(path, handler as (req: unknown, res: unknown) => unknown);
      return undefined;
    },
  };
  async function call(path: string): Promise<{ code: number; body: unknown }> {
    const handler = routes.get(path);
    if (!handler) throw new Error(`no handler for ${path}`);
    let code = 200;
    let body: unknown;
    const res = {
      status(c: number) {
        code = c;
        return { json: (b: unknown) => ((body = b), b) };
      },
      json: (b: unknown) => ((body = b), b),
    };
    await handler({}, res);
    return { code, body };
  }
  return { app, call, paths: () => Array.from(routes.keys()).sort() };
}

const ok = async () => ({ ready: true, detail: 'connected' });
const down = async () => ({ ready: false, detail: 'error' });

describe('/health/deep', () => {
  it('is not mounted without deepProbes', () => {
    const { app, paths } = fakeApp();
    mountReadinessRoutes(app, { probes: {} });
    expect(paths()).toEqual(['/health/live', '/health/ready']);
  });

  it('returns 200 when all deep probes are ready, with the ready body shape', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, { probes: {}, deepProbes: { db: ok } });
    expect(await call('/health/deep')).toEqual({
      code: 200,
      body: { status: 'ready', checks: { db: { ready: true, detail: 'connected' } } },
    });
  });

  it('returns 503 when a deep probe is not ready, throws, or times out', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, {
      probes: {},
      timeoutMs: 20,
      deepProbes: {
        a: down,
        b: async () => {
          throw new Error('x');
        },
        c: () => new Promise(() => {}),
      },
    });
    const { code, body } = (await call('/health/deep')) as {
      code: number;
      body: { status: string; checks: Record<string, { detail: string }> };
    };
    expect(code).toBe(503);
    expect(body.status).toBe('not ready');
    expect(body.checks.b?.detail).toBe('error');
    expect(body.checks.c?.detail).toBe('timeout');
  });

  it('does not run deep probes on /health/ready', async () => {
    const { app, call } = fakeApp();
    let deepRan = false;
    mountReadinessRoutes(app, {
      probes: { db: ok },
      deepProbes: {
        db: async () => {
          deepRan = true;
          return { ready: true, detail: 'connected' };
        },
      },
    });
    await call('/health/ready');
    expect(deepRan).toBe(false);
  });
});

describe('/health/details status code', () => {
  it('is 200 when healthy and 503 when unhealthy', async () => {
    const healthy = fakeApp();
    mountHealthRoutes(healthy.app, { serviceName: 'S', pingDb: async () => undefined });
    expect((await healthy.call('/health/details')).code).toBe(200);

    const sick = fakeApp();
    mountHealthRoutes(sick.app, {
      serviceName: 'S',
      pingDb: async () => {
        throw new Error('down');
      },
    });
    const { code, body } = await sick.call('/health/details');
    expect(code).toBe(503);
    expect(body).toMatchObject({ status: 'unhealthy' });
  });
});

describe('draining', () => {
  it('createDrainSignal flips once started', () => {
    const d = createDrainSignal();
    expect(d.isDraining()).toBe(false);
    d.startDraining();
    expect(d.isDraining()).toBe(true);
  });

  it('/health and /health/ready return 503 draining without running probes; /health/live stays 200', async () => {
    const drain = createDrainSignal();
    const { app, call } = fakeApp();
    let probeRuns = 0;
    const counting = async () => {
      probeRuns++;
      return { ready: true, detail: 'connected' };
    };
    mountHealthRoutes(app, { serviceName: 'S', pingDb: async () => undefined, isDraining: drain.isDraining });
    mountReadinessRoutes(app, { probes: { db: counting }, isDraining: drain.isDraining });

    expect((await call('/health')).code).toBe(200);
    expect((await call('/health/ready')).code).toBe(200);
    expect(probeRuns).toBe(1);

    drain.startDraining();
    expect(await call('/health')).toEqual({ code: 503, body: { status: 'draining' } });
    expect(await call('/health/ready')).toEqual({ code: 503, body: { status: 'draining' } });
    expect(probeRuns).toBe(1);
    expect(await call('/health/live')).toEqual({ code: 200, body: { status: 'ok' } });
  });
});
