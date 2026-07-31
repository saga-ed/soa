import { describe, it, expect, vi } from 'vitest';
import { mountHealthRoutes, buildIdentity, type HealthRouter } from '../health.js';

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

  // Superset guard, updated for build identity. The original form asserted an
  // EXACT top-level key set so a repin was a byte-identical no-op. Build
  // identity intentionally adds keys, so the invariant is now narrower but still
  // load-bearing: with NO deploy env set (local, tests, any undeployed run) the
  // body must be byte-identical to the pre-identity contract. Consumers pinned
  // to an older version therefore see no change until they actually deploy.
  it('superset: with no deploy env, the output is unchanged from the pre-identity contract', async () => {
    const { app, call, paths } = fakeApp();
    mountHealthRoutes(app, { serviceName: 'Programs API', pingDb: async () => undefined });
    expect(paths().sort()).toEqual(['/health', '/health/details']);

    expect(await call('/health')).toEqual({ status: 'ok', service: 'Programs API' });

    const details = (await call('/health/details')) as Record<string, unknown>;
    expect(details.status).toBe('healthy');
    expect(details.service).toBe('Programs API');
    expect(typeof details.timestamp).toBe('string');
    expect((details.dependencies as { postgres: { status: string } }).postgres.status).toBe('healthy');
    expect(Object.keys(details).sort()).toEqual(['dependencies', 'service', 'status', 'timestamp']);
  });
});

describe('buildIdentity', () => {
  it('parses the colour out of the comma-joined OTEL attribute string', () => {
    expect(
      buildIdentity({
        OTEL_RESOURCE_ATTRIBUTES:
          'deployment.environment=prod,deployment.environment.name=prod,deployment.identifier=blue',
      }).colour,
    ).toBe('blue');
  });

  it('reads version, environment and deploy time from their own vars', () => {
    expect(
      buildIdentity({
        DD_VERSION: '3b436235b8ecd8eb395396e938690985b48ef554',
        EXEC_ENV: 'prod',
        DEPLOYMENT_DATETIME: '2026-07-31T01:08:45Z',
      }),
    ).toEqual({
      version: '3b436235b8ecd8eb395396e938690985b48ef554',
      environment: 'prod',
      deployedAt: '2026-07-31T01:08:45Z',
    });
  });

  // The whole point of D10: blue and green must be distinguishable. Same image,
  // same env — only the colour differs, which is exactly the live prod shape.
  it('distinguishes two colours running the identical image', () => {
    const base = { DD_VERSION: 'abc123', EXEC_ENV: 'prod' };
    const blue = buildIdentity({
      ...base,
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,deployment.identifier=blue',
    });
    const green = buildIdentity({
      ...base,
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,deployment.identifier=green',
    });
    expect(blue.colour).toBe('blue');
    expect(green.colour).toBe('green');
    expect(blue).not.toEqual(green);
  });

  it('omits absent fields rather than emitting undefined or a placeholder', () => {
    expect(buildIdentity({})).toEqual({});
    expect(Object.keys(buildIdentity({ DD_VERSION: 'abc' }))).toEqual(['version']);
  });

  it('tolerates a malformed or identifier-free OTEL string', () => {
    expect(buildIdentity({ OTEL_RESOURCE_ATTRIBUTES: '' }).colour).toBeUndefined();
    expect(buildIdentity({ OTEL_RESOURCE_ATTRIBUTES: 'novalue' }).colour).toBeUndefined();
    expect(buildIdentity({ OTEL_RESOURCE_ATTRIBUTES: 'deployment.identifier=' }).colour).toBeUndefined();
    expect(
      buildIdentity({ OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod' }).colour,
    ).toBeUndefined();
  });

  // deployment.environment.name CONTAINS "deployment.environment" as a prefix;
  // a substring match would return the wrong value for the wrong key.
  it('matches the identifier key exactly, not by prefix', () => {
    expect(
      buildIdentity({
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.identifier.suffix=wrong,deployment.identifier=right',
      }).colour,
    ).toBe('right');
  });

  it('surfaces identity on both routes when the deploy env is present', async () => {
    const { app, call } = fakeApp();
    const env = {
      DD_VERSION: 'abc123',
      EXEC_ENV: 'prod',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.identifier=green',
    };
    vi.stubGlobal('process', { env });
    try {
      mountHealthRoutes(app, { serviceName: 'Programs API', pingDb: async () => undefined });
      expect(await call('/health')).toEqual({
        status: 'ok',
        service: 'Programs API',
        colour: 'green',
        version: 'abc123',
        environment: 'prod',
      });
      const details = (await call('/health/details')) as Record<string, unknown>;
      expect(details.colour).toBe('green');
      expect(details.version).toBe('abc123');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
