/**
 * Shared `/health` + `/health/details` routes for Saga Node services.
 *
 * Mounted BEFORE any auth perimeter so ALB / load-balancer probes are never
 * gated. `/health` is a liveness ping; `/health/details` adds a timed
 * dependency readiness probe (typically Postgres) and answers 503 when
 * unhealthy. Typed structurally (no
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

import type { EnvIdentity } from '@saga-ed/soa-env';

export interface HealthResponse {
  status(code: number): { json(body: unknown): unknown };
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
  /** When true, `/health` answers 503 `draining` so the ALB deregisters the task. `/health/details` is unaffected. */
  isDraining?: () => boolean;
  /** soa-env's resolved identity; adds profile, lane, telemetryEnv and accountKind to the build identity. */
  identity?: EnvIdentity;
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
  /** @deprecated Raw EXEC_ENV; use `profile`. */
  environment?: string;
  /** Behaviour profile from soa-env. Present only when an identity is passed. */
  profile?: EnvIdentity['profile'];
  lane?: EnvIdentity['lane'];
  telemetryEnv?: EnvIdentity['telemetryEnv'];
  accountKind?: EnvIdentity['account']['kind'];
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
export function buildIdentity(env: EnvLike = ambientEnv(), identity?: EnvIdentity): BuildIdentity {
  const out: BuildIdentity = {};
  const colour = readColour(env);
  if (colour) out.colour = colour;
  // DD_VERSION is the image tag, which CI sets to the git SHA.
  if (env.DD_VERSION) out.version = env.DD_VERSION;
  // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- deprecated alias of profile; remove once consumers pass identity (soa#515)
  if (env.EXEC_ENV) out.environment = env.EXEC_ENV;
  if (env.DEPLOYMENT_DATETIME) out.deployedAt = env.DEPLOYMENT_DATETIME;
  if (identity) {
    out.profile = identity.profile;
    out.lane = identity.lane;
    out.telemetryEnv = identity.telemetryEnv;
    out.accountKind = identity.account.kind;
  }
  return out;
}

export function mountHealthRoutes(app: HealthRouter, opts: MountHealthOptions): void {
  app.get('/health', (_req, res) => {
    if (opts.isDraining?.()) {
      res.status(503).json({ status: 'draining', ...buildIdentity(undefined, opts.identity) });
      return;
    }
    res.json({ status: 'ok', service: opts.serviceName, ...buildIdentity(undefined, opts.identity) });
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
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'unhealthy',
      service: opts.serviceName,
      ...buildIdentity(undefined, opts.identity),
      timestamp: new Date().toISOString(),
      dependencies,
    });
  });
}
