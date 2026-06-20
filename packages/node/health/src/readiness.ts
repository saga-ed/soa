/**
 * Shared `/health/live` + `/health/ready` routes for Saga Node services that
 * have a richer readiness posture than the single-Postgres `mountHealthRoutes`
 * liveness/details pair.
 *
 * Mounted BEFORE any auth perimeter so ALB / load-balancer probes (which carry
 * no session cookie) reach them. `/health/live` is a pure process-liveness ping
 * (always 200). `/health/ready` runs every configured probe and returns **200
 * when all probes are ready, 503 otherwise** — the status code is the contract
 * an ALB target-group health check (matcher 200-299) keys on, so a not-ready
 * service is pulled from the load balancer.
 *
 * Each probe is `name -> () => Promise<ProbeResult>`. A probe reports a
 * tri-state (`{ ready, detail }`) rather than throw/resolve, because a
 * dependency can be deliberately *disabled* (still ready) vs *erroring* (not
 * ready) — and the "disabled is ready" decision belongs in the closure that
 * owns the domain knowledge, not in a central predicate. Readiness is simply
 * "every probe resolved `{ ready: true }`".
 *
 * Each probe is wrapped in a hard timeout (default 2s) so a hung dependency
 * (e.g. an unreachable Redis or KMS) cannot block the probe past the load
 * balancer's health-check window — a timed-out probe counts as not-ready.
 *
 * Typed structurally (no express import) so the helper has no framework
 * dependency — any object with `get(path, handler)` works, and the readiness
 * handler's `res` only needs `status(code).json(body)` (which Express's
 * response satisfies: `res.status(code)` returns the response, which has
 * `.json()`).
 */

/** A single dependency probe's outcome. Only `ready` drives the 200/503. */
export interface ProbeResult {
  /** Whether this dependency is ready (a disabled-but-optional dep is ready). */
  ready: boolean;
  /** Human/operator-facing state, surfaced in the body, e.g. 'connected' | 'disabled' | 'error' | 'timeout'. */
  detail: string;
}

/**
 * Express's `res` exposes `status(code)` returning the response (so `.json()`
 * chains) and a bare `json(body)`. We model only what the handlers use.
 */
export interface ReadinessResponse {
  status(code: number): { json(body: unknown): unknown };
  json(body: unknown): unknown;
}

export interface ReadinessRouter {
  get(path: string, handler: (req: unknown, res: ReadinessResponse) => void): unknown;
}

export interface MountReadinessOptions {
  /**
   * Named dependency probes. Readiness = EVERY probe resolves `{ ready: true }`.
   * A probe that throws or exceeds `timeoutMs` counts as `{ ready: false }`.
   */
  probes: Record<string, () => Promise<ProbeResult>>;
  /**
   * Per-probe hard timeout in milliseconds (default 2000). A probe that does
   * not settle within the window is treated as `{ ready: false, detail: 'timeout' }`
   * so a hung dependency cannot block the probe past the load-balancer window.
   */
  timeoutMs?: number;
}

/** A sentinel the timeout rejects with, so we can tell timeout from a probe throw. */
const TIMEOUT = Symbol('readiness-probe-timeout');

/** Reject with TIMEOUT after `ms` so a hung probe cannot stall the response. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT), ms);
  });
  // Clear the pending timer once the probe settles so a fast probe doesn't
  // leave a dangling 2s timer (harmless but tidy under high request rates).
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function mountReadinessRoutes(app: ReadinessRouter, opts: MountReadinessOptions): void {
  const timeoutMs = opts.timeoutMs ?? 2000;

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    const entries = await Promise.all(
      Object.entries(opts.probes).map(async ([name, probe]) => {
        // A probe that hangs is killed by the timeout (detail 'timeout'); a
        // probe that throws is reported separately (detail 'error'). Either
        // way it counts as not-ready.
        const result: ProbeResult = await withTimeout(probe(), timeoutMs).catch((err) => ({
          ready: false,
          detail: err === TIMEOUT ? 'timeout' : 'error',
        }));
        return [name, result] as const;
      }),
    );
    const checks: Record<string, ProbeResult> = Object.fromEntries(entries);
    const ready = entries.every(([, r]) => r.ready);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', checks });
  });
}
