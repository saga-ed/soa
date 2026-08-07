/**
 * Shared `/health` + `/health/details` routes for Saga Node services.
 *
 * Mounted BEFORE any auth perimeter so ALB / load-balancer probes are never
 * gated. `/health` is a liveness ping; `/health/details` adds a timed
 * dependency readiness probe (typically Postgres). Typed structurally (no
 * express import) so the helper has no framework dependency — any object with
 * `get(path, handler)` works.
 *
 * Both routes also report the running task's build identity (colour, git SHA,
 * environment, deploy time) when the environment supplies it. Without that a
 * response cannot say WHICH build or blue/green colour answered, so a
 * header-pinned smoke test against a non-serving colour cannot prove it reached
 * that colour: an unmatched preview header falls through to the live rule and
 * returns an equally healthy 200.
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

/**
 * Environment bag, typed structurally so this package keeps its zero-dependency
 * shape (no `@types/node` at the type level, matching the framework-free router
 * typing above).
 */
export type EnvLike = Record<string, string | undefined>;

/** Build/deploy identity of the running task, as far as the environment reveals it. */
export interface BuildIdentity {
  /** Blue/green colour slot (`blue` | `green` | `main`), or undefined outside a deployed task. */
  colour?: string;
  /** Git SHA of the running image. */
  version?: string;
  /** Deployment environment, e.g. `dev` | `prod`. */
  environment?: string;
  /** ISO timestamp stamped at deploy time. */
  deployedAt?: string;
}

/**
 * Read the colour slot out of `OTEL_RESOURCE_ATTRIBUTES`.
 *
 * The colour is NOT its own env var — infra threads the CFN `Identifier`
 * parameter into the comma-joined OTEL attribute string as
 * `deployment.identifier=<colour>`. Parsing it here means every already-deployed
 * task reports its colour with no task-definition change; a dedicated
 * `DEPLOY_COLOR` var would require redeploying every service first.
 */
function readColour(env: EnvLike): string | undefined {
  for (const pair of env.OTEL_RESOURCE_ATTRIBUTES?.split(',') ?? []) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== 'deployment.identifier') continue;
    const value = pair.slice(eq + 1).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The ambient process environment, resolved without a static `process`
 * reference so the package stays runtime-agnostic (and importable somewhere
 * `process` is absent). Returns an empty bag when there is none.
 */
function ambientEnv(): EnvLike {
  const proc = (globalThis as { process?: { env?: EnvLike } }).process;
  return proc?.env ?? {};
}

/**
 * Build identity from the ambient environment. Every field is optional: locally
 * and in tests none of these are set, and `/health` must never fail because a
 * deploy-time variable is missing. Absent fields are omitted from the response
 * rather than emitted as `undefined`/`"unknown"`, so a caller can distinguish
 * "not reported" from a real value.
 */
export function buildIdentity(env: EnvLike = ambientEnv()): BuildIdentity {
  const identity: BuildIdentity = {};
  const colour = readColour(env);
  if (colour) identity.colour = colour;
  // DD_VERSION is the image tag, which CI sets to the git SHA.
  if (env.DD_VERSION) identity.version = env.DD_VERSION;
  if (env.EXEC_ENV) identity.environment = env.EXEC_ENV;
  if (env.DEPLOYMENT_DATETIME) identity.deployedAt = env.DEPLOYMENT_DATETIME;
  return identity;
}

export function mountHealthRoutes(app: HealthRouter, opts: MountHealthOptions): void {
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: opts.serviceName, ...buildIdentity() });
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
      ...buildIdentity(),
      timestamp: new Date().toISOString(),
      dependencies,
    });
  });
}
