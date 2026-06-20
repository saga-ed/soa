import { describe, it, expect, vi } from 'vitest';
import {
  mountReadinessRoutes,
  type ReadinessRouter,
  type ProbeResult,
} from '../readiness.js';

/**
 * Captures the route handlers a service would register and invokes them with a
 * fake `res` that records both the JSON body and the HTTP status code (default
 * 200 until `status()` is called), so we can assert the 200/503 contract
 * without a real HTTP server. `status(c)` returns the same fake so `.json()`
 * chains, mirroring Express's `res.status(c).json(b)`.
 */
function fakeApp() {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  const app: ReadinessRouter = {
    get(path, handler) {
      routes.set(path, handler as (req: unknown, res: unknown) => void);
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
    // The /health/ready handler is async at runtime though typed `=> void`;
    // await it so all probes settle before we read code/body.
    await (handler({}, res) as unknown as Promise<void> | void);
    return { code, body };
  }
  return { app, call, paths: () => Array.from(routes.keys()) };
}

const ok = (detail = 'connected'): ProbeResult => ({ ready: true, detail });
const down = (detail = 'error'): ProbeResult => ({ ready: false, detail });

describe('mountReadinessRoutes', () => {
  it('registers exactly /health/live and /health/ready', () => {
    const { app, paths } = fakeApp();
    mountReadinessRoutes(app, { probes: {} });
    expect(paths().sort()).toEqual(['/health/live', '/health/ready']);
  });

  it('/health/live is a 200 liveness ping', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, { probes: {} });
    const { code, body } = await call('/health/live');
    expect(code).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('/health/ready returns 200 + ready when every probe is ready', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, {
      probes: { iamDb: async () => ok(), redis: async () => ok('PONG') },
    });
    const { code, body } = await call('/health/ready');
    expect(code).toBe(200);
    expect(body).toEqual({
      status: 'ready',
      checks: { iamDb: ok(), redis: ok('PONG') },
    });
  });

  it('/health/ready returns 503 + not ready when one probe is not ready', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, {
      probes: { iamDb: async () => ok(), piiDb: async () => down('disconnected') },
    });
    const { code, body } = await call('/health/ready') as {
      code: number;
      body: { status: string; checks: Record<string, ProbeResult> };
    };
    expect(code).toBe(503);
    expect(body.status).toBe('not ready');
    expect(body.checks.piiDb).toEqual(down('disconnected'));
  });

  it('treats a disabled-but-optional dependency as ready (200)', async () => {
    const { app, call } = fakeApp();
    // redis disabled (operator chose to run without it) must NOT block readiness.
    mountReadinessRoutes(app, {
      probes: { iamDb: async () => ok(), redis: async () => ok('disabled') },
    });
    const { code, body } = await call('/health/ready') as {
      code: number;
      body: { status: string; checks: Record<string, ProbeResult> };
    };
    expect(code).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks.redis).toEqual({ ready: true, detail: 'disabled' });
  });

  it('a hung probe times out and is counted not-ready (503)', async () => {
    vi.useFakeTimers();
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, {
      timeoutMs: 2000,
      probes: {
        iamDb: async () => ok(),
        // never settles — must be killed by the timeout, not hang the response.
        redis: () => new Promise<ProbeResult>(() => {}),
      },
    });
    const promise = call('/health/ready');
    await vi.advanceTimersByTimeAsync(2000);
    const { code, body } = (await promise) as {
      code: number;
      body: { status: string; checks: Record<string, ProbeResult> };
    };
    expect(code).toBe(503);
    expect(body.status).toBe('not ready');
    expect(body.checks.redis).toEqual({ ready: false, detail: 'timeout' });
    vi.useRealTimers();
  });

  it('a throwing probe is counted not-ready (caught, not propagated)', async () => {
    const { app, call } = fakeApp();
    mountReadinessRoutes(app, {
      probes: {
        iamDb: async () => ok(),
        kms: async () => {
          throw new Error('jwks fetch failed');
        },
      },
    });
    const { code, body } = await call('/health/ready') as {
      code: number;
      body: { status: string; checks: Record<string, ProbeResult> };
    };
    expect(code).toBe(503);
    expect(body.status).toBe('not ready');
    // a throw lands as not-ready with detail 'error' (distinct from 'timeout')
    expect(body.checks.kms).toEqual({ ready: false, detail: 'error' });
  });
});
