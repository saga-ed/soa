/**
 * Shared `/health` + `/health/details` routes for Saga Node services.
 *
 * Mounted BEFORE any auth perimeter so ALB / load-balancer probes are never
 * gated. `/health` is a liveness ping; `/health/details` adds a timed
 * dependency readiness probe (typically Postgres). Typed structurally (no
 * express import) so the helper has no framework dependency — any object with
 * `get(path, handler)` works.
 */

export interface HealthResponse {
  json(body: unknown): unknown;
}

export interface HealthRouter {
  get(path: string, handler: (req: unknown, res: HealthResponse) => void): unknown;
}

export interface MountHealthOptions {
  /** Display name in the response body, e.g. "Programs API". */
  serviceName: string;
  /**
   * Ping the database; must reject on failure. Typically
   * `() => container.get<PrismaClient>('PrismaClient').$queryRawUnsafe('SELECT 1')`.
   */
  pingDb: () => Promise<unknown>;
}

export function mountHealthRoutes(app: HealthRouter, opts: MountHealthOptions): void {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: opts.serviceName });
  });

  app.get('/health/details', async (_req, res) => {
    const dependencies: Record<string, { status: string; latencyMs?: number }> = {};
    try {
      const start = performance.now();
      await opts.pingDb();
      dependencies.postgres = { status: 'healthy', latencyMs: Math.round(performance.now() - start) };
    } catch {
      dependencies.postgres = { status: 'unhealthy' };
    }
    const allHealthy = Object.values(dependencies).every((d) => d.status === 'healthy');
    res.json({
      status: allHealthy ? 'healthy' : 'unhealthy',
      service: opts.serviceName,
      timestamp: new Date().toISOString(),
      dependencies,
    });
  });
}
