import { describe, it, expect, vi } from 'vitest';
import { mountHealthRoutes, type HealthRouter } from '../health.js';

/**
 * Captures the route handlers a service would register, so we can invoke them
 * with a fake res and assert the response bodies — without a real HTTP server.
 */
function fakeApp() {
  const routes = new Map<string, (req: unknown, res: { json(b: unknown): unknown }) => void>();
  const app: HealthRouter = {
    get(path, handler) {
      routes.set(path, handler);
      return undefined;
    },
  };
  async function call(path: string): Promise<unknown> {
    const handler = routes.get(path);
    if (!handler) throw new Error(`no handler for ${path}`);
    let body: unknown;
    const res = { json: (b: unknown) => ((body = b), b) };
    // The handler type is `=> void`, but the /health/details handler is async
    // and returns a promise at runtime; await it so the readiness probe
    // resolves before we read `body`.
    await (handler({}, res) as unknown as Promise<void> | void);
    return body;
  }
  return { app, call, paths: () => Array.from(routes.keys()) };
}

describe('mountHealthRoutes', () => {
  it('registers exactly /health and /health/details', () => {
    const { app, paths } = fakeApp();
    mountHealthRoutes(app, { serviceName: 'Programs API', pingDb: async () => undefined });
    expect(paths().sort()).toEqual(['/health', '/health/details']);
  });

  it('/health is a liveness ping that echoes the service name', async () => {
    const { app, call } = fakeApp();
    mountHealthRoutes(app, { serviceName: 'Programs API', pingDb: async () => undefined });
    expect(await call('/health')).toEqual({ status: 'ok', service: 'Programs API' });
  });

  it('/health/details reports healthy + a numeric latency when pingDb resolves', async () => {
    const { app, call } = fakeApp();
    const pingDb = vi.fn().mockResolvedValue(undefined);
    mountHealthRoutes(app, { serviceName: 'Sessions API', pingDb });
    const body = (await call('/health/details')) as {
      status: string;
      service: string;
      dependencies: { postgres: { status: string; latencyMs?: number } };
    };
    expect(pingDb).toHaveBeenCalledTimes(1);
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('Sessions API');
    expect(body.dependencies.postgres.status).toBe('healthy');
    expect(typeof body.dependencies.postgres.latencyMs).toBe('number');
  });

  it('/health/details reports unhealthy (no latency) when pingDb rejects', async () => {
    const { app, call } = fakeApp();
    mountHealthRoutes(app, {
      serviceName: 'Sessions API',
      pingDb: async () => {
        throw new Error('db down');
      },
    });
    const body = (await call('/health/details')) as {
      status: string;
      dependencies: { postgres: { status: string; latencyMs?: number } };
    };
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.postgres.status).toBe('unhealthy');
    expect(body.dependencies.postgres.latencyMs).toBeUndefined();
  });

  // dev.1 -> dev.2 superset guard: adding mountReadinessRoutes must NOT alter
  // the existing two-arg mountHealthRoutes contract. program-hub is exact-pinned
  // to dev.1 and must see byte-identical /health + /health/details output, so a
  // future repin to dev.2 is a no-op. (timestamp is the only non-deterministic
  // field; asserted by shape, the rest by exact value.)
  it('dev.1 superset: the two-arg mountHealthRoutes output is unchanged', async () => {
    const { app, call, paths } = fakeApp();
    mountHealthRoutes(app, { serviceName: 'Programs API', pingDb: async () => undefined });
    expect(paths().sort()).toEqual(['/health', '/health/details']);

    expect(await call('/health')).toEqual({ status: 'ok', service: 'Programs API' });

    const details = (await call('/health/details')) as Record<string, unknown>;
    expect(details.status).toBe('healthy');
    expect(details.service).toBe('Programs API');
    expect(typeof details.timestamp).toBe('string');
    expect((details.dependencies as { postgres: { status: string } }).postgres.status).toBe('healthy');
    // exact key set — no new top-level fields leaked into the dev.1 body
    expect(Object.keys(details).sort()).toEqual(['dependencies', 'service', 'status', 'timestamp']);
  });
});
