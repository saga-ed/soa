/**
 * Deployed-service health model for `ss env verify` (soa#355) — PURE.
 *
 * The deployed-env analogue of `core/probe-plan.ts` (which `stack verify` uses
 * for the LOCAL mesh). Two things make a deployed env different, both learned
 * empirically against dev + training on 2026-07-21:
 *
 * 1. **HTTP 200 IS NOT A HEALTH SIGNAL HERE.** `*.wootdev.com` (and
 *    `*.saga-training.org`) are wildcard DNS onto the shared ALB, whose default
 *    action answers **200 with the body `dev-account-alb`** for ANY unmatched
 *    hostname. A status-code-only probe therefore reports every service — even
 *    ones that do not exist — as healthy. Health MUST be judged from the BODY
 *    (`classifyProbeBody`): an API answers `{"status":"ok"|"healthy","service":…}`,
 *    a frontend answers an HTML document.
 * 2. **The deployed hostname is NOT the manifest `tunnelSlug`.** It varies per
 *    service: `iam`/`sis` are short, the rest are the full service id
 *    (`programs-api`, `sessions-api`, …), `coach` is the coach WEB frontend
 *    (the API is `coach-api`), connect-api answers on `connectv3-api`, and
 *    rtsm/fleek are SHARED fleets pinned to `*.wootdev.com` for every env
 *    (`fqdn`), not per-env hosts.
 *    The map is taken from the ALB host-header rules + a live body check, not
 *    derived — a guessed host silently reads as an ALB "down".
 *
 * A service with no `host` cannot be verified over HTTP — it is reported as
 * such (never silently green) and covered by the `--ecs` platform check where
 * an ECS service exists. Today that is only `connect-web` (Amplify-hosted).
 */

/**
 * How a healthy response is recognised.
 *  - `api`      JSON body with an allowlisted `status` (the shared-ALB fleet + rtsm).
 *  - `frontend` an HTML document (Amplify SPAs).
 *  - `plain`    a 2xx is sufficient — the body may be empty or plain text.
 *               ONLY for hosts that are NOT behind the shared ALB (fleek's own
 *               Caddy cluster), where a 200 genuinely means "this host served
 *               it" rather than "the wildcard default answered".
 */
export type ServiceKind = 'api' | 'frontend' | 'plain';

export interface DeployedServiceDef {
  /** Manifest service id (kept aligned with core/manifest for cross-reference). */
  id: string;
  /** Subdomain under the env's domain, or undefined when there is no public route. */
  host?: string;
  /**
   * ABSOLUTE hostname, used INSTEAD of `<host>.<domain>` for infrastructure that
   * is SHARED across environments rather than deployed per-env (rtsm, fleek —
   * both envs' services point at the same `*.wootdev.com` fleet; see the
   * `RECORDER_URL_TEMPLATE` / `RTSM_API_URL` env on the connectv3-api task
   * definitions, where the TRAINING service names `.wootdev.com` hosts).
   */
  fqdn?: string;
  /**
   * Per-ENV absolute hostname, keyed by env name — for services deployed per
   * env but NOT under the env's domain. connect-web (connectv3) is a Vite SPA
   * on Amplify with no custom domain, so it lives at
   * `<branch>.<amplify-app-id>.amplifyapp.com` (qboard/CLAUDE.md "Web main").
   */
  fqdnByEnv?: Record<string, string>;
  /** Path probed for health (APIs `/health`; frontends `/`). */
  healthPath: string;
  kind: ServiceKind;
  /** A down/unroutable OPTIONAL service does not fail the gate. */
  optional?: boolean;
  /**
   * ECS service-name prefix in the shared cluster (`<ecsService>-<identifier>`)
   * for the platform check. Undefined where the name is not yet confirmed —
   * that check is then skipped with a note rather than guessed.
   */
  ecsService?: string;
  note?: string;
}

/**
 * The deployed service set, verified by response body against BOTH dev and
 * training (identical map on both) on 2026-07-21. Growing/altering it is a
 * reviewed change — a wrong host silently becomes an ALB-default "down".
 */
export const DEPLOYED_SERVICES: DeployedServiceDef[] = [
  { id: 'iam-api', host: 'iam', healthPath: '/health', kind: 'api', ecsService: 'rostering-iam-api' },
  { id: 'sis-api', host: 'sis', healthPath: '/health', kind: 'api', ecsService: 'rostering-sis-api' },
  { id: 'programs-api', host: 'programs-api', healthPath: '/health', kind: 'api', ecsService: 'program-hub-programs-api' },
  { id: 'scheduling-api', host: 'scheduling-api', healthPath: '/health', kind: 'api', ecsService: 'program-hub-scheduling-api' },
  { id: 'sessions-api', host: 'sessions-api', healthPath: '/health', kind: 'api', ecsService: 'program-hub-sessions-api' },
  { id: 'content-api', host: 'content-api', healthPath: '/health', kind: 'api', ecsService: 'program-hub-content-api' },
  {
    id: 'ads-adm-api',
    host: 'ads-adm-api',
    healthPath: '/health',
    kind: 'api',
    ecsService: 'sds-ads-adm-api',
    note: 'also answers on ads-adm.<domain> (sds#288 multi-host ALB rule)',
  },
  { id: 'coach-api', host: 'coach-api', healthPath: '/health', kind: 'api', ecsService: 'coach-coach-api' },
  { id: 'saga-dash', host: 'dash', healthPath: '/', kind: 'frontend', note: 'Amplify-hosted SPA (not an ECS service)' },
  { id: 'coach-web', host: 'coach', healthPath: '/', kind: 'frontend', note: 'Amplify-hosted SPA, not ECS (the API is coach-api)' },
  {
    // Host is connectv3-api.<domain> (NOT connect-api/connect) — confirmed from
    // the ALB host-header rules and live on both envs. Its body carries no
    // `service` key: {"status":"ok","mongo":"ok"}.
    id: 'connect-api',
    host: 'connectv3-api',
    healthPath: '/connectv3/v1/health',
    kind: 'api',
    ecsService: 'qboard-connectv3-api',
  },
  { id: 'transcripts-api', host: 'transcripts-api', healthPath: '/health', kind: 'api', optional: true, ecsService: 'sds-transcripts-api' },
  {
    // fleek is the recording fleet — its OWN Caddy cluster (`*.fleek.<domain>`,
    // nodes chi-1/nyc-1/phx-1/vet-1 + recorder-*/recordings-* aliases), not the
    // shared ALB. `/health` answers 200 with an EMPTY body (`/` answers "OK"),
    // hence kind 'plain' — fleek/OPS.md:145 confirms "HTTP 200 on {node}/health"
    // IS the Caddy signal. fleek/OPS.md:92-93 defines health as BOTH this and
    // the livekit recorder endpoint (next entry). Probed via chi-1; nyc-1 was
    // unreachable on 2026-07-22 (both fleek and rtsm).
    // Operator (SSH) access to these nodes needs a short-lived cert:
    //   saws.js cert -n fleek -n rtsm -p dev_admin
    // — that is for ssh -p 727, NOT for this HTTP probe, which needs no cert.
    id: 'fleek',
    fqdn: 'chi-1.fleek.wootdev.com',
    healthPath: '/health',
    kind: 'plain',
    note: 'shared Caddy recording fleet (*.fleek.wootdev.com) — BOTH envs use it',
  },
  {
    // The second half of fleek health per fleek/OPS.md:93 — the livekit
    // recorder, which a deploy polls alongside the node's Caddy /health.
    // Answers {"ok":true} (no `status` key), so 'plain' rather than 'api'.
    id: 'fleek-recorder',
    fqdn: 'recorder-chi-1.fleek.wootdev.com',
    healthPath: '/v1/health',
    kind: 'plain',
    note: 'livekit recorder (fleek/OPS.md:93); shared fleet — BOTH envs use it',
  },
  {
    // The connectv3 SPA is on Amplify with NO custom domain (unlike dash/coach),
    // which is why connect.<domain> hits the shared-ALB default. Its real home is
    // <branch>.<app-id>.amplifyapp.com — app `connectv3` = d2ezd4i8b4uexc, with a
    // branch per env (qboard/CLAUDE.md documents the shape).
    id: 'connect-web',
    fqdnByEnv: {
      dev: 'dev.d2ezd4i8b4uexc.amplifyapp.com',
      training: 'training.d2ezd4i8b4uexc.amplifyapp.com',
    },
    healthPath: '/',
    kind: 'frontend',
    note: 'Amplify app connectv3 (d2ezd4i8b4uexc), branch per env; no custom domain',
  },
  {
    // RTSM runs on its OWN geo-distributed cluster, not the shared ECS/ALB:
    // `*.rtsm.wootdev.com` on non-AWS IPs (core, core-a/b, chi-1, nyc-1, par-1,
    // phx-1). `chi-1` is the canonical health route (per Jeff); rtsm/README.md
    // documents /health (detailed) plus /health/live and /health/ready. NOTE the
    // bare `core` alias fails the TLS handshake from outside, as do nyc-1/par-1.
    // Optional because the fleet lives only under wootdev.com — there are no
    // rtsm records in the saga-training.org zone.
    id: 'rtsm-api',
    fqdn: 'chi-1.rtsm.wootdev.com',
    healthPath: '/health',
    kind: 'api',
    note: 'shared geo cluster (*.rtsm.wootdev.com) — BOTH envs use it; not shared ECS/ALB',
  },
];

/** One planned deployed health probe. */
export interface EnvHealthProbe {
  id: string;
  kind: ServiceKind;
  optional: boolean;
  /** Absolute URL, or null when the service has no public route. */
  url: string | null;
  ecsService?: string;
  note?: string;
}

/**
 * Build the probe list for an env (pure). Host resolution, in precedence order:
 *   `fqdnByEnv[envName]`  per-env absolute host (Amplify apps with no custom domain)
 *   `fqdn`                shared infra, same host for every env (rtsm/fleek)
 *   `<host>.<domain>`     the normal per-env case
 */
export function buildEnvHealthProbes(
  domain: string,
  envName = '',
  services: readonly DeployedServiceDef[] = DEPLOYED_SERVICES,
): EnvHealthProbe[] {
  return services.map((s) => ({
    id: s.id,
    kind: s.kind,
    optional: s.optional === true,
    url: resolveProbeUrl(s, domain, envName),
    ecsService: s.ecsService,
    note: s.note,
  }));
}

/** Resolve a service's probe URL for one env (null when it has no HTTP route there). */
function resolveProbeUrl(s: DeployedServiceDef, domain: string, envName: string): string | null {
  const perEnv = s.fqdnByEnv?.[envName];
  if (perEnv !== undefined) return `https://${perEnv}${s.healthPath}`;
  if (s.fqdnByEnv !== undefined) return null; // per-env service with no host for THIS env
  if (s.fqdn !== undefined) return `https://${s.fqdn}${s.healthPath}`;
  if (s.host === undefined) return null;
  return `https://${s.host}.${domain}${s.healthPath}`;
}

/** The verdict a probe body earns. */
export type BodyVerdict = 'healthy' | 'alb-default' | 'unexpected' | 'empty';

/** The shared-ALB default-action body — a 200 that means "nothing is routed here". */
const ALB_DEFAULT_MARKER = 'dev-account-alb';

/**
 * Healthy `status` values, surveyed live across every deployed API on dev
 * (2026-07-21) — each service picks its own word:
 *   `ok`      iam, programs, scheduling, sessions, content
 *   `running` sis, ads-adm
 *   `healthy` coach
 * Deliberately an ALLOWLIST, not "anything that isn't an error": a service
 * reporting `degraded`/`down` must fail the gate, not pass it by omission.
 */
const HEALTHY_STATUSES = new Set(['ok', 'healthy', 'running', 'up']);

/**
 * Judge a probe response by its BODY, not its status (see the file header).
 * An API must answer JSON carrying a non-error `status` and a `service`; a
 * frontend must answer an HTML document. Anything matching the ALB default is
 * `alb-default` — the service is NOT routed, which is a failure, never health.
 */
export function classifyProbeBody(body: string | undefined, kind: ServiceKind): BodyVerdict {
  const text = (body ?? '').trim();
  if (text.includes(ALB_DEFAULT_MARKER)) return 'alb-default';
  // `plain` hosts are not behind the shared ALB, so the 2xx the caller already
  // checked IS the signal — an empty body (fleek's /health) is healthy.
  if (kind === 'plain') return 'healthy';
  if (text === '') return 'empty';
  if (kind === 'frontend') return /^<!doctype html|^<html/i.test(text) ? 'healthy' : 'unexpected';
  try {
    const parsed = JSON.parse(text) as { status?: unknown };
    const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    // `service` is NOT universal — connect-api answers {"status":"ok","mongo":"ok"} —
    // so an allowlisted `status` is the signal. (The ALB default is not JSON at all.)
    return HEALTHY_STATUSES.has(status) ? 'healthy' : 'unexpected';
  } catch {
    return 'unexpected';
  }
}

/** The ECS platform facts `--ecs` reads back for a service (describe-services). */
export interface EcsServiceState {
  running?: number;
  desired?: number;
  /** ECS service status — ACTIVE for a live service. */
  status?: string;
  /** Primary deployment rollout state (COMPLETED / IN_PROGRESS / FAILED). */
  rollout?: string;
  taskDef?: string;
}

export interface EcsVerdict {
  healthy: boolean;
  /** One-line summary for the report (always populated). */
  summary: string;
}

/**
 * Judge a service's ECS state (PURE). Healthy = ACTIVE, desired > 0,
 * running >= desired, and no FAILED rollout. This is the platform truth HTTP
 * cannot see: a crash-looping/under-running service behind a stale healthy ALB
 * target. An IN_PROGRESS rollout at full task count is reported but NOT failed
 * — routine deploys must not turn the gate red.
 */
export function classifyEcsState(state: EcsServiceState | undefined): EcsVerdict {
  if (state === undefined) return { healthy: false, summary: 'no such ECS service in the shared clusters' };
  const { running = 0, desired = 0, status = '', rollout } = state;
  const counts = `${running}/${desired} task(s)`;
  if (status !== '' && status !== 'ACTIVE') return { healthy: false, summary: `${status} (${counts})` };
  if (desired === 0) return { healthy: false, summary: `scaled to zero (${counts})` };
  if (running < desired) return { healthy: false, summary: `under-running ${counts}${rollout ? ` — rollout ${rollout}` : ''}` };
  if (rollout === 'FAILED') return { healthy: false, summary: `${counts}, rollout FAILED` };
  // An IN_PROGRESS rollout at full task count is a routine deploy, not an
  // outage — the service is serving (its HTTP probe proves it). Note it, but
  // do not fail the gate or every deploy window turns red.
  if (rollout !== undefined && rollout !== 'COMPLETED') return { healthy: true, summary: `${counts} running, rollout ${rollout}` };
  return { healthy: true, summary: `${counts} running` };
}

/** Human explanation for a non-healthy verdict (kept next to the classifier). */
export function verdictReason(verdict: BodyVerdict): string {
  switch (verdict) {
    case 'alb-default':
      return 'not routed (shared-ALB default response — no listener rule for this host)';
    case 'empty':
      return 'empty response body';
    case 'unexpected':
      return 'unexpected body (not a healthy service response)';
    default:
      return '';
  }
}
