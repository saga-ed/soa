/**
 * Shared CORS primitives for Saga backends.
 *
 * Two things every browser-facing Saga API needs and currently re-implements:
 *
 *  1. {@link DATADOG_RUM_TRACING_HEADERS} — the distributed-tracing headers
 *     Datadog browser RUM injects on cross-origin fetches once a frontend
 *     enables RUM. Every backend a RUM frontend calls must allow ALL of them
 *     in its CORS `allowedHeaders`; the browser fails the preflight if any one
 *     is missing (it only ever names one in the error). See hipponot/iac#358.
 *
 *  2. {@link buildSagaOriginAllowlist} / {@link originAllowed} — an
 *     environment-isolated origin allowlist: prod (`NODE_ENV=production`)
 *     trusts only `https://*.saga.org`, dev/preview only `https://*.wootdev.com`.
 *     Sharing it keeps layer-7 CORS and any Origin/Referer CSRF gate in lockstep
 *     and prevents dev/prod origin leakage.
 */

/**
 * Distributed-tracing headers emitted by `@datadog/browser-rum` (v6, default
 * `datadog` + `tracecontext` propagators). Spread into a CORS `allowedHeaders`
 * list. `as const` so callers get a readonly tuple; spread into a mutable array
 * (`[...DATADOG_RUM_TRACING_HEADERS]`) where a mutable list is required.
 */
export const DATADOG_RUM_TRACING_HEADERS = [
  'traceparent',
  'tracestate',
  'x-datadog-trace-id',
  'x-datadog-parent-id',
  'x-datadog-origin',
  'x-datadog-sampling-priority',
  'x-datadog-tags',
] as const;

// Anchored + https-only so a suffix attack (`wootdev.com.attacker.org`) can't
// match. Allows any multi-level subdomain (previews, stable.dash, …) + an
// optional port.
const SAGA_DEV_ORIGIN_REGEX = /^https:\/\/([a-z0-9-]+\.)+wootdev\.com(:\d+)?$/;
const SAGA_PROD_ORIGIN_REGEX = /^https:\/\/([a-z0-9-]+\.)+saga\.org(:\d+)?$/;

export interface SagaOriginAllowlistOptions {
  /**
   * Legacy env source (used only when `corsOrigins` is absent). `NODE_ENV`
   * selects the prod-vs-dev wildcard; `CORS_ORIGIN` (comma-separated) adds
   * explicit origins. Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Complete allowlist from the env capability. When provided it is returned
   * as-is (copied): no `CORS_ORIGIN`, `devOrigins` or wildcard is appended.
   */
  corsOrigins?: readonly (string | RegExp)[];
  /**
   * Extra explicit origins allowed in NON-production only — e.g. local dev
   * servers (`http://localhost:5173`). Omitted in prod so localhost can never
   * be trusted by a production deploy.
   */
  devOrigins?: readonly string[];
}

let warnedCorsFallback = false;

/** Test-only: re-arm the once-per-process fallback warning. */
export function resetCorsFallbackWarning(): void {
  warnedCorsFallback = false;
}

/**
 * Build an environment-isolated CORS / CSRF origin allowlist.
 *
 * - **`corsOrigins` provided**: it is the complete allowlist; nothing is added.
 * - Otherwise (deprecated, warns once; pass `corsOrigins`):
 *
 * - **prod** (`NODE_ENV==='production'`): explicit `CORS_ORIGIN` entries + the
 *   `https://*.saga.org` wildcard. No dev origins, no `*.wootdev.com`.
 * - **dev / preview**: explicit `CORS_ORIGIN` entries + `devOrigins` + the
 *   `https://*.wootdev.com` wildcard. No `*.saga.org`.
 *
 * Pass the result to the `cors` middleware's `origin` and/or to
 * {@link originAllowed} for an Origin/Referer CSRF check (one source of truth).
 */
export function buildSagaOriginAllowlist(
  opts: SagaOriginAllowlistOptions = {},
): (string | RegExp)[] {
  if (opts.corsOrigins) return [...opts.corsOrigins];
  if (!warnedCorsFallback) {
    warnedCorsFallback = true;
    process.emitWarning(
      'buildSagaOriginAllowlist: pass `corsOrigins` from the env capability; NODE_ENV/CORS_ORIGIN fallback is deprecated (soa#515)',
      { type: 'DeprecationWarning', code: 'SOA_ENV_FALLBACK_CORS' },
    );
  }
  const env = opts.env ?? process.env;
  // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- deprecated fallback; remove once all consumers pass corsOrigins (soa#515)
  const isProd = env.NODE_ENV === 'production';
  const list: (string | RegExp)[] = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (!isProd && opts.devOrigins) list.push(...opts.devOrigins);
  list.push(isProd ? SAGA_PROD_ORIGIN_REGEX : SAGA_DEV_ORIGIN_REGEX);
  return list;
}

/**
 * Match an `Origin` (or `Referer`-derived origin) against an allowlist built by
 * {@link buildSagaOriginAllowlist}. A missing origin is rejected — browsers
 * send `Origin` on cross-origin (and most same-origin) state-changing requests,
 * so absence is suspicious.
 */
export function originAllowed(
  allowlist: readonly (string | RegExp)[],
  origin: string | undefined,
): boolean {
  if (!origin) return false;
  return allowlist.some((entry) =>
    typeof entry === 'string' ? entry === origin : entry.test(origin),
  );
}
