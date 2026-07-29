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
 * such (never silently green). Where an ECS service exists, the `--ecs`
 * platform check is the substitute signal. Where NO signal exists at all,
 * there is nothing to check, so the service is reported unverifiable and
 * declared `optionalEnvs` for that env: a gate that can never go green is a
 * gate that gets ignored.
 *
 * As of 2026-07-29 NO service is in either bucket on prod. `coach-api`,
 * `connect-api` and `connect-web` were all recorded here as unrouted in prod
 * (I#375); all three are in fact routed and healthy — coach-api.saga.org,
 * connectv3-api.saga.org and connectv3.saga.org — so the entire prod fleet is
 * HTTP-verifiable. That is the standing hazard of this file: a host that gains
 * (or loses) a public route turns the gate into a lie in one direction or the
 * other, and a stale "no public route" reads as a hard FAIL on a healthy
 * fleet. Entries are confirmed live, never inferred from an older run.
 *
 * The list is ONE global fleet, so the set differs per env in three declared
 * ways (I#375): `envs` scopes a service OUT of an env it is not deployed to at
 * all, `optionalEnvs` un-gates (but still reports) a service that has NO
 * verification signal in an env, and `ecsServiceByEnv` overrides the
 * `<ecsService>-<identifier>` name for the one prod service that does not
 * follow its env's suffix convention.
 *
 * NOTE `ALB_DEFAULT_MARKER` below is DEV-specific. Prod has no wildcard DNS —
 * an unrouted prod host NXDOMAINs rather than answering a 200 — so there is no
 * confirmed prod analogue and none should be assumed.
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
  /**
   * The envs this service is DEPLOYED TO. ABSENT means every env (the common
   * case). Present means the service does not exist elsewhere and must be
   * SKIPPED there — not probed and not gated. `optional` is the wrong tool for
   * that: it would weaken the gate in the envs where the service DOES run.
   *
   * Only for services genuinely ABSENT from an env (confirmed by BOTH an ECS
   * miss and NXDOMAIN). A service that is deployed but unrouted belongs in
   * `noPublicRouteEnvs` instead — dropping it would hide a real outage.
   */
  envs?: readonly string[];
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
  /**
   * Envs where this service IS deployed but has NO public DNS record, so HTTP
   * cannot verify it there. It is reported as "no public route" (never green
   * on its own) and judged by the `--ecs` pass — exactly connect-web's case.
   * Distinct from `envs`: scoping a running service OUT would hide an outage.
   */
  noPublicRouteEnvs?: readonly string[];
  /** Path probed for health (APIs `/health`; frontends `/`). */
  healthPath: string;
  kind: ServiceKind;
  /** A down/unroutable OPTIONAL service does not fail the gate. */
  optional?: boolean;
  /**
   * Envs where this service does not fail the gate — the PER-ENV analogue of
   * `optional`, so un-gating it in one env cannot weaken the others.
   *
   * ONLY for a service that has NO verification signal in that env: no HTTP
   * route AND no ECS service to fall back on (an Amplify SPA whose branch for
   * that env is not established — `connect-web` on prod). It is still probed,
   * still listed, and still reported as unverifiable; it just cannot turn a
   * healthy fleet red. NOT a way to silence a service that CAN be checked —
   * a real signal that is failing must fail the gate.
   */
  optionalEnvs?: readonly string[];
  /**
   * ECS service-name prefix in the shared cluster (`<ecsService>-<identifier>`)
   * for the platform check. Undefined where the name is not yet confirmed —
   * that check is then skipped with a note rather than guessed.
   */
  ecsService?: string;
  /**
   * Per-ENV ABSOLUTE ECS service name, keyed by env name — used INSTEAD of
   * `<ecsService>-<identifier>` (the ECS-side mirror of `fqdnByEnv`), for a
   * service that does not follow its env's suffix convention. Overriding per
   * service rather than per env is deliberate: prod's shared-mesh services all
   * use `-main`, so a global suffix override would break them.
   *
   * Currently unused — every known service follows the convention. Verify an
   * override against `aws ecs list-services` before adding one; a stale pin
   * here turns a healthy service into a hard FAIL, which is what happened to
   * coach-api on prod.
   */
  ecsServiceByEnv?: Record<string, string>;
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
  {
    // Absent from prod: no `program-hub-content-api-*` on prod-shared AND
    // content-api.saga.org NXDOMAINs (live 2026-07-28) — not deployed there.
    id: 'content-api',
    envs: ['dev', 'training'],
    host: 'content-api',
    healthPath: '/health',
    kind: 'api',
    ecsService: 'program-hub-content-api',
  },
  {
    // Absent from prod (no ECS service on prod-shared + NXDOMAIN).
    id: 'ads-adm-api',
    envs: ['dev', 'training'],
    host: 'ads-adm-api',
    healthPath: '/health',
    kind: 'api',
    ecsService: 'sds-ads-adm-api',
    note: 'also answers on ads-adm.<domain> (sds#288 multi-host ALB rule)',
  },
  {
    // Routed in EVERY env, prod included: coach-api.saga.org/health answers
    // {"status":"healthy","service":"Coach API"} (live 2026-07-29). The earlier
    // `noPublicRouteEnvs: ['prod']` recorded an NXDOMAIN that is no longer true
    // — prod now publishes real A records — and it made the gate report a
    // healthy service as unverifiable. `/coach/v1/*` is the AUTHENTICATED API
    // surface (401 {"realms":["iam"]} unauthenticated); `/health` is the
    // unauthenticated probe and the only path this gate may use.
    id: 'coach-api',
    host: 'coach-api',
    healthPath: '/health',
    kind: 'api',
    // No `ecsServiceByEnv` override: prod's coach-api follows the standard
    // `<ecsService>-<ledgerIdentifier>` convention like every other shared-mesh
    // service. It was previously pinned to `coach-coach-api-canary`, which was
    // true when the canary was the only coach service on `prod-shared` and it
    // was INACTIVE. `aws ecs list-services --cluster prod-shared` now lists
    // `coach-coach-api-main` and no canary at all, so the override made
    // `env verify --env prod --ecs` report a healthy service as a hard FAIL.
    ecsService: 'coach-coach-api',
  },
  { id: 'saga-dash', host: 'dash', healthPath: '/', kind: 'frontend', note: 'Amplify-hosted SPA (not an ECS service)' },
  { id: 'coach-web', host: 'coach', healthPath: '/', kind: 'frontend', note: 'Amplify-hosted SPA, not ECS (the API is coach-api)' },
  {
    // Host is connectv3-api.<domain> (NOT connect-api/connect) — confirmed from
    // the ALB host-header rules and live on EVERY env, prod included: the prod
    // host resolves and /connectv3/v1/health answers {"status":"ok","mongo":"ok"}
    // (live 2026-07-29). Its body carries no `service` key.
    // The former `noPublicRouteEnvs: ['prod']` recorded a stale NXDOMAIN.
    // NOTE health lives UNDER the /connectv3/v1 prefix — bare /health is the
    // authenticated app surface (401 NEEDS_IAM), not a probe.
    id: 'connect-api',
    host: 'connectv3-api',
    healthPath: '/connectv3/v1/health',
    kind: 'api',
    ecsService: 'qboard-connectv3-api',
  },
  {
    // Absent from prod (no ECS service on prod-shared + NXDOMAIN).
    id: 'transcripts-api',
    envs: ['dev', 'training'],
    host: 'transcripts-api',
    healthPath: '/health',
    kind: 'api',
    optional: true,
    ecsService: 'sds-transcripts-api',
  },
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
    // dev+training ONLY. `fqdn` pins this to the *.wootdev.com fleet, which is a
    // DEV-account fleet — prod runs its own recording clusters
    // (`recorder_cluster_prod`, `av-recorder-cluster-prod-v3`, live 2026-07-28).
    // Probing the dev host during a prod run is a FALSE SIGNAL in both
    // directions: green while prod's recorder is down, red while dev's is down
    // and prod is fine. Scoped out until prod's recorder hostnames are
    // established; adding them is follow-on work, not a guess.
    envs: ['dev', 'training'],
    note: 'shared Caddy recording fleet (*.fleek.wootdev.com) — dev+training only; prod has its own fleet',
  },
  {
    // The second half of fleek health per fleek/OPS.md:93 — the livekit
    // recorder, which a deploy polls alongside the node's Caddy /health.
    // Answers {"ok":true} (no `status` key), so 'plain' rather than 'api'.
    id: 'fleek-recorder',
    fqdn: 'recorder-chi-1.fleek.wootdev.com',
    healthPath: '/v1/health',
    kind: 'plain',
    // dev+training ONLY, for the same reason as `fleek` above — this is the
    // wootdev.com fleet. Scoping it out supersedes the earlier
    // `optionalEnvs: ['prod']`, which still probed the dev host and merely
    // declined to gate on the result: a reported-but-wrong signal, not a fix.
    envs: ['dev', 'training'],
    note: 'livekit recorder (fleek/OPS.md:93); shared fleet — dev+training only; prod has its own fleet',
  },
  {
    // The connectv3 SPA is on Amplify. On dev/training it has NO custom domain
    // (which is why connect.<domain> hits the shared-ALB default) and lives at
    // <branch>.<app-id>.amplifyapp.com — app `connectv3` = d2ezd4i8b4uexc, with
    // a branch per env (qboard/CLAUDE.md documents the shape).
    //
    // PROD DOES have a custom domain: connectv3.saga.org (CloudFront, serving
    // the "Saga Connect" document — live 2026-07-29). Note it is connectv3.,
    // NOT connect. — connect.saga.org NXDOMAINs. That domain is the prod signal
    // this entry previously lacked, so the `optionalEnvs: ['prod']` un-gate is
    // gone: prod is now checkable and therefore gated like every other env.
    // Per-env hosts stay in `fqdnByEnv` because the three envs genuinely differ
    // (a custom domain here, Amplify branch URLs there) — an env with no entry
    // still resolves to null rather than a guessed host.
    id: 'connect-web',
    fqdnByEnv: {
      dev: 'dev.d2ezd4i8b4uexc.amplifyapp.com',
      training: 'training.d2ezd4i8b4uexc.amplifyapp.com',
      prod: 'connectv3.saga.org',
    },
    healthPath: '/',
    kind: 'frontend',
    note: 'Amplify app connectv3 (d2ezd4i8b4uexc); prod on the connectv3.saga.org custom domain, dev/training on per-branch Amplify URLs',
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
    // dev+training ONLY — same wootdev.com-pinned reasoning as the fleek pair.
    envs: ['dev', 'training'],
    note: 'shared geo cluster (*.rtsm.wootdev.com) — dev+training only; not shared ECS/ALB',
  },
];

/** One planned deployed health probe. */
export interface EnvHealthProbe {
  id: string;
  kind: ServiceKind;
  optional: boolean;
  /** Absolute URL, or null when the service has no public route. */
  url: string | null;
  /** ECS service-name PREFIX — composed with the env's ledger identifier. */
  ecsService?: string;
  /**
   * Fully-resolved ECS service name for this env (from `ecsServiceByEnv`),
   * which takes precedence over `<ecsService>-<identifier>` when set.
   */
  ecsServiceName?: string;
  note?: string;
}

/**
 * Build the probe list for an env (pure). Services out of the env's scope
 * (`envs`) are OMITTED entirely — they are not deployed there, so probing or
 * gating them would report a service that was never meant to exist.
 *
 * Host resolution, in precedence order:
 *   `noPublicRouteEnvs`   deployed here but unrouted ⇒ null (ECS-only)
 *   `fqdnByEnv[envName]`  per-env absolute host (Amplify apps with no custom domain)
 *   `fqdn`                shared infra, same host for every env (rtsm/fleek)
 *   `<host>.<domain>`     the normal per-env case
 */
export function buildEnvHealthProbes(
  domain: string,
  envName = '',
  services: readonly DeployedServiceDef[] = DEPLOYED_SERVICES,
): EnvHealthProbe[] {
  return services.filter((s) => isInEnvScope(s, envName)).map((s) => ({
    id: s.id,
    kind: s.kind,
    optional: s.optional === true || s.optionalEnvs?.includes(envName) === true,
    url: resolveProbeUrl(s, domain, envName),
    ecsService: s.ecsService,
    ecsServiceName: s.ecsServiceByEnv?.[envName],
    note: s.note,
  }));
}

/** Is this service deployed to `envName`? (`envs` absent = every env.) */
export function isInEnvScope(s: DeployedServiceDef, envName: string): boolean {
  return s.envs === undefined || s.envs.includes(envName);
}

/** Resolve a service's probe URL for one env (null when it has no HTTP route there). */
function resolveProbeUrl(s: DeployedServiceDef, domain: string, envName: string): string | null {
  if (s.noPublicRouteEnvs?.includes(envName) === true) return null;
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
