import type { ReadinessRouter } from '../readiness.js';
import { buildIdentity } from '../health.js';
import type { DeepReadiness, DetailLevel } from './types.js';

/**
 * Mounts /health/live (always 200), /health/ready (TG, cache only) and /health/deep (smoke, probes).
 * Framework-free: any router with `get(path, handler)` and a `res.status(n).json(b)` response works
 * (Express, and the other shapes mountReadinessRoutes accepts). Mount BEFORE any auth perimeter.
 */
export function mountDeepReadiness(app: ReadinessRouter, dr: DeepReadiness): void {
  const levelOf = async (req: unknown): Promise<DetailLevel> =>
    (await Promise.resolve(dr.authorizeInternal(req)).catch(() => false)) ? 'internal' : 'public';

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', ...buildIdentity() });
  });

  app.get('/health/ready', async (req, res) => {
    try {
      const r = dr.report(await levelOf(req));
      res.status(r.httpStatus).json(r);
    } catch {
      res.status(503).json({ schema: 'saga.readiness/v1', verdict: 'not_ready', httpStatus: 503 });
    }
  });

  app.get('/health/deep', async (req, res) => {
    try {
      const r = await dr.deepReport(await levelOf(req));
      res.status(r.httpStatus).json(r);
    } catch {
      res.status(503).json({ schema: 'saga.readiness/v1', verdict: 'not_ready', httpStatus: 503 });
    }
  });
}
