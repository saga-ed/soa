/**
 * launch-plan — the PURE native-launch planner + the FAITHFUL env wall (plan
 * §6.3 / §7.2 "M4 — Native partial-stack").
 *
 * The native partial-stack path (`stack up --only <svc,…>` without falling back
 * to up.sh) needs, for each service in the computed closure, the EXACT command +
 * working dir + environment + health endpoint that up.sh's `services_up`
 * (~lines 1373-1553) would hand that service's `launch_if` line. This module is
 * that planner. It is PURE: it performs ZERO IO — every value that depends on
 * the host (resolved ports, repo checkout paths, the synthetic-dev tool dir,
 * mesh creds, env overrides like SAGA_API_TARGET) is an INPUT, carried in a
 * `LaunchContext` the runtime builds and passes in. Spawning, health polling and
 * mesh bring-up live in `src/runtime/**`; this file only computes the plan.
 *
 * Two entry points:
 *  - `resolveLaunchEnv(service, lane, ctx)` — expand one service's manifest
 *    `launch.env` token templates (`${IAM_URL}`, `${MESH_MQ}`, …) into concrete
 *    strings. The manifest env is authored faithful + complete to up.sh; this
 *    only substitutes tokens. A token with no value in `ctx` THROWS (a missing
 *    token is drift, never a silent literal).
 *  - `launchPlan(manifest, closureServices, lane, ctx)` — order the closure by
 *    `launchOrder` (topo waves, flattened) and emit one `LaunchSpec` per service.
 *
 * FIDELITY CONTRACT: the audit diffs each `resolveLaunchEnv` result against the
 * matching up.sh `launch_if` line. The base launch env is LANE-INDEPENDENT in
 * up.sh (the launch line sets the same vars regardless of lane; `--sandbox`
 * /`--tunnel` splat OVERRIDES via `sandbox_env`/`tunnel_env`). M4's native path
 * drives the local `stack` lane only; the sandbox/tunnel env overlays remain on
 * the up.sh wrapper path (see `laneOverlay`'s TODO). `lane` is still threaded
 * through so the health URL is taken from the right lane.
 */

import { launchOrder } from './launch-order.js';
import { getDb, getMesh, getService, manifest } from './manifest/index.js';
import type { Lane, Manifest, RepoKey, ServiceId } from './manifest/index.js';

// ── token / context contract ────────────────────────────────────────────────

/**
 * The up.sh scalar variables (`up.sh` ~lines 182-299), resolved to final
 * strings. These are the ONLY tokens the manifest `launch.env` templates
 * reference; `resolveLaunchEnv` substitutes `${NAME}` → `LaunchTokens[NAME]`.
 *
 * Keep this in lock-step with up.sh's variable block — adding a manifest token
 * means adding the field here AND populating it in the context builder. The
 * runtime context builder is the one place these become host-specific.
 */
export interface LaunchTokens {
  // ── ports, string form (used as `${…}` inside launch env) ──
  /** iam-api port — up.sh `IAM_PORT` (3010). */
  IAM_PORT: string;
  /** sis-api port — up.sh `SIS_PORT` (3100). */
  SIS_PORT: string;
  /** content-api port — up.sh `CONTENT_PORT` (3009; default :3010 collides with iam). */
  CONTENT_PORT: string;
  /** connect-api port — up.sh `CONNECT_API_PORT` (6106). */
  CONNECT_API_PORT: string;
  /** rtsm-api port — up.sh `RTSM_PORT` (6110). */
  RTSM_PORT: string;
  /** fleek-recorder control port — up.sh `RECORDER_CONTROL_PORT` (7890; --record). */
  RECORDER_CONTROL_PORT: string;
  /** fleek-recordings-api port — up.sh `RECORDINGS_API_PORT` (8444; --record playback). */
  RECORDINGS_API_PORT: string;
  /** coach-api port — up.sh `COACH_API_PORT` (6105). */
  COACH_API_PORT: string;
  /** coach-web port — up.sh `COACH_WEB_PORT` (8800). */
  COACH_WEB_PORT: string;
  /** connect-mongo mesh port — up.sh `CONNECT_MONGO_PORT` (27037; coach-api's MONGO_PORT). */
  CONNECT_MONGO_PORT: string;

  // ── lane base URLs (local/stack lane: http://localhost:<port>) ──
  /** up.sh `IAM_URL`. */
  IAM_URL: string;
  /** up.sh `DASH_URL` (saga-dash, :8900). */
  DASH_URL: string;
  /** up.sh `CONNECT_WEB_URL`. */
  CONNECT_WEB_URL: string;
  /** up.sh `CONNECT_API_URL`. */
  CONNECT_API_URL: string;
  /** up.sh `CONTENT_API_URL`. */
  CONTENT_API_URL: string;
  /** up.sh `RTSM_URL`. */
  RTSM_URL: string;
  /** up.sh `SAGA_API_TARGET` — legacy poll-content source (env-overridable; default https://wootmath.com). */
  SAGA_API_TARGET: string;
  /** up.sh `COACH_API_URL` — `http://localhost:$COACH_API_PORT` (coach-web PUBLIC_COACH_API_URL). */
  COACH_API_URL: string;
  /** up.sh `COACH_WEB_HOST` — bare hostname for coach-api's CORS allow-list (`localhost`). */
  COACH_WEB_HOST: string;
  /** up.sh `SAGA_API_TARGET_COACH` — coach's frontend upstream-saga config (default https://staging.wootmath.com). */
  SAGA_API_TARGET_COACH: string;
  /** up.sh `IAM_ISSUER` — the `iss` claim coach-api/ads-adm-api validate (`https://iam.saga.org`). */
  IAM_ISSUER: string;

  // ── mesh broker + DB / mongo connection strings ──
  /** up.sh `MESH_MQ` — `amqp://rabbitmq_admin:password123@localhost:5672`. */
  MESH_MQ: string;
  /** up.sh `CONNECT_MONGO_URI` — `mongodb://localhost:27037/connectv3`. */
  CONNECT_MONGO_URI: string;
  /** up.sh `SIS_DB_URL`. */
  SIS_DB_URL: string;
  /** up.sh `PROGRAMS_DB_URL`. */
  PROGRAMS_DB_URL: string;
  /** up.sh `SCHEDULING_DB_URL`. */
  SCHEDULING_DB_URL: string;
  /** up.sh `SESSIONS_DB_URL`. */
  SESSIONS_DB_URL: string;
  /** up.sh `CONTENT_DB_URL`. */
  CONTENT_DB_URL: string;
  /** up.sh `COACH_DB_URL` — `postgresql://coach_api_app:dev-password-coach-api-app@localhost:5432/coach_api`. */
  COACH_DB_URL: string;

  // ── misc scalars ──
  /** up.sh `RECORDING_TOKEN` — shared fleek bearer (`local-dev-token`). */
  RECORDING_TOKEN: string;
  /** up.sh `DEV_USER_UUID` — the iam seed dev-user uuid (`f0000004-…beef`). */
  DEV_USER_UUID: string;
  /** up.sh `$SCRIPT_DIR` — the synthetic-dev tool dir (rtsm `FLEET_CONFIG_PATH`). */
  SYNTHETIC_DEV_DIR: string;

  // ── global launch env (up.sh services_up `export`s these ONCE, ~1384-1385, so
  //    every `pnpm dev` child inherits them; soa-logger/soa-config validate them
  //    at startup with NO defaults, so they are required for any node service to
  //    boot). Merged under every service's launch env by `resolveLaunchEnv`. ──
  /** up.sh `PINO_LOGGER_LEVEL` (`${PINO_LOGGER_LEVEL:-info}`). */
  PINO_LOGGER_LEVEL: string;
  /** up.sh `PINO_LOGGER_ISEXPRESSCONTEXT` (`${PINO_LOGGER_ISEXPRESSCONTEXT:-true}`). */
  PINO_LOGGER_ISEXPRESSCONTEXT: string;

  // ── lane-template tokens (sandbox/tunnel lanes only; absent ⇒ stack lane) ──
  /** up.sh `SANDBOX_NAME` — only set under `--sandbox` (sandbox lane URLs). */
  SANDBOX_NAME?: string;
  /** up.sh `SANDBOX_BASE` — dev-fleet base domain (sandbox lane URLs). */
  SANDBOX_BASE?: string;
  /** up.sh `TUNNEL_DOMAIN` — `<moniker>.$VMS_BASE`, only set under `--tunnel`. */
  TUNNEL_DOMAIN?: string;
}

/**
 * Everything the pure planner needs from the host, supplied by the runtime.
 * No field is read from `process.env` here — the runtime resolves them (ports
 * via `check_ports`, paths via `runtime/scripts`, scalars via up.sh's defaults)
 * and hands them in. `defaultLaunchContext` builds the up.sh defaults so the
 * runtime usually only supplies `repoRoots` + `syntheticDevDir`.
 */
export interface LaunchContext {
  /**
   * Resolved host port per service. Defaults to the manifest `port`; the
   * `check_ports` preflight confirms each is free (up.sh does not remap, so this
   * normally equals the manifest default). Drives the health URL and, for
   * services whose launch env injects `${…_PORT}`, the env.
   */
  ports: Record<ServiceId, number>;
  /** Absolute repo checkout roots keyed by manifest `RepoKey` (from `runtime/scripts`). */
  repoRoots: Record<RepoKey, string>;
  /** The up.sh scalar variables, resolved to final strings. */
  tokens: LaunchTokens;
}

/** One fully-resolved native launch: ready for the runtime to spawn + health-poll. */
export interface LaunchSpec {
  /** The service id. */
  id: ServiceId;
  /** Absolute working dir the child runs in (`repoRoots[repo]/subpath`). */
  cwd: string;
  /** The launch command (e.g. `pnpm dev`) — `ServiceDef.launch.cmd`, verbatim. */
  command: string;
  /** The resolved launch env (token templates expanded; faithful to up.sh). */
  env: Record<string, string>;
  /** Full URL the runtime polls for readiness on the chosen lane (`base + healthPath`). */
  healthUrl: string;
  /** The health path alone (`/health` | `/` | `/connectv3/v1/health`). */
  healthPath: string;
}

// ── token substitution ───────────────────────────────────────────────────────

/** Matches a `${NAME}` token (uppercase / digits / underscore). */
const TOKEN_RE = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Expand every `${NAME}` in `template` from `tokens`. Throws (with the service +
 * key context) on the FIRST token with no value — a missing token is manifest
 * /context drift, never a silent passthrough. `where` is folded into the error
 * so the audit pinpoints which launch env var broke.
 */
function expand(template: string, tokens: Record<string, string | undefined>, where: string): string {
  return template.replace(TOKEN_RE, (_match, name: string) => {
    const value = tokens[name];
    if (value === undefined) {
      throw new Error(`launch-plan: ${where} references unset token \${${name}}`);
    }
    return value;
  });
}

/**
 * Lane-specific env OVERRIDES, splatted on top of the base launch env (up.sh's
 * `sandbox_env`/`tunnel_env`, ~lines 1166-1280). M4's native path drives the
 * local `stack` lane, for which there is NO overlay (returns `{}`). The
 * sandbox/tunnel overlays stay on the up.sh wrapper path for now.
 *
 * TODO(post-M4): port `sandbox_env` (iam-api dep URL flip + PREVIEW_ORIGINATE_MAP
 * for sis-api/programs-api/scheduling-api/sessions-api) and `tunnel_env`
 * (browser-plane CORS / cookie-domain / VITE_* flips) here when native hybrid
 * lanes land. Until then a non-`stack` lane resolves the base env only.
 */
function laneOverlay(_service: ServiceId, _lane: Lane, _ctx: LaunchContext): Record<string, string> {
  return {};
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Resolve one service's launch env for `lane`: expand the manifest
 * `launch.env` token templates against `ctx.tokens`, then splat any lane
 * overlay (`{}` for the `stack` lane). The base env is lane-independent in
 * up.sh — the result for the `stack` lane is exactly the KEY=VAL set up.sh's
 * `launch_if <svc>` line passes that service.
 */
export function resolveLaunchEnv(
  service: ServiceId,
  lane: Lane,
  ctx: LaunchContext,
  m: Manifest = manifest,
): Record<string, string> {
  const def = getService(service, m);
  const tokens = ctx.tokens as unknown as Record<string, string | undefined>;

  // Global env up.sh `export`s once in services_up (~1384-1385) so every child
  // inherits it — required for any soa node service to pass startup validation.
  // Laid down FIRST so a per-service launch.env key could override it (none do).
  const env: Record<string, string> = {
    PINO_LOGGER_LEVEL: ctx.tokens.PINO_LOGGER_LEVEL,
    PINO_LOGGER_ISEXPRESSCONTEXT: ctx.tokens.PINO_LOGGER_ISEXPRESSCONTEXT,
  };
  for (const [key, template] of Object.entries(def.launch.env)) {
    env[key] = expand(template, tokens, `${service}.launch.env.${key}`);
  }

  // Lane overrides win (env last-wins, matching up.sh's trailing splat).
  return { ...env, ...laneOverlay(service, lane, ctx) };
}

/** Join a repo root + repo-relative subpath without depending on node:path (pure). */
function joinPath(root: string, subpath: string): string {
  return `${root.replace(/\/+$/, '')}/${subpath.replace(/^\/+/, '')}`;
}

/**
 * The base URL a service is reachable on for `lane`:
 *  - `stack`   — `http://localhost:<resolved port>` (NOT the manifest lane
 *                template, so a `check_ports` remap is honoured).
 *  - sandbox/tunnel — the manifest `lane[lane]` template, tokens expanded
 *                (needs `SANDBOX_NAME`/`SANDBOX_BASE` or `TUNNEL_DOMAIN`).
 */
function laneBaseUrl(service: ServiceId, lane: Lane, ctx: LaunchContext, m: Manifest): string {
  const def = getService(service, m);
  if (lane === 'stack') {
    const port = ctx.ports[service] ?? def.port;
    return `http://localhost:${port}`;
  }
  const tokens = ctx.tokens as unknown as Record<string, string | undefined>;
  return expand(def.lane[lane], tokens, `${service}.lane.${lane}`);
}

/** Concatenate a lane base URL and a health path, collapsing the seam slash. */
function healthUrlFor(base: string, healthPath: string): string {
  return `${base.replace(/\/+$/, '')}/${healthPath.replace(/^\/+/, '')}`;
}

/**
 * Build the ordered native launch plan for `closureServices` (typically a
 * `computeClosure(...).services` set). Services are re-ordered by `launchOrder`
 * (topo waves, flattened, declaration-stable) so dependencies boot first, then
 * each is resolved to a `LaunchSpec`. PURE: the runtime consumes the specs to
 * spawn + health-poll each wave.
 */
export function launchPlan(
  m: Manifest,
  closureServices: ServiceId[],
  lane: Lane,
  ctx: LaunchContext,
): LaunchSpec[] {
  const ordered = launchOrder(closureServices, m).flat();

  return ordered.map((id) => {
    const def = getService(id, m);
    const base = laneBaseUrl(id, lane, ctx, m);
    return {
      id,
      cwd: joinPath(ctx.repoRoots[def.repo], def.subpath),
      command: def.launch.cmd,
      env: resolveLaunchEnv(id, lane, ctx, m),
      healthUrl: healthUrlFor(base, def.healthPath),
      healthPath: def.healthPath,
    };
  });
}

// ── default context builder (up.sh ~182-299, as pure data) ──────────────────

/** Host-derived inputs the pure default-context builder still needs from the runtime. */
export interface LaunchContextInputs {
  /** Absolute repo checkout roots keyed by manifest `RepoKey`. */
  repoRoots: Record<RepoKey, string>;
  /** up.sh's `$SCRIPT_DIR` — the synthetic-dev tool dir. */
  syntheticDevDir: string;
  /** `SAGA_API_TARGET` override (up.sh honours `$SAGA_API_TARGET`; default https://wootmath.com). */
  sagaApiTarget?: string;
  /** Per-service port overrides (e.g. a `check_ports` remap); defaults to the manifest port. */
  portOverrides?: Partial<Record<ServiceId, number>>;
  /** Fleek recorder control port (up.sh `RECORDER_CONTROL_PORT`; default 7890). */
  recorderControlPort?: number;
  /** Fleek recordings-api port (up.sh `RECORDINGS_API_PORT`; default 8444). */
  recordingsApiPort?: number;
  /** Sandbox lane inputs — set only under `--sandbox`. */
  sandbox?: { name: string; base?: string };
  /** Tunnel lane input — set only under `--tunnel`. */
  tunnel?: { domain: string };
  /** up.sh `${PINO_LOGGER_LEVEL:-info}` — ambient override, else `info`. */
  pinoLevel?: string;
  /** up.sh `${PINO_LOGGER_ISEXPRESSCONTEXT:-true}` — ambient override, else `true`. */
  pinoIsExpressContext?: string;
}

/** `postgresql://<owner>:<pw>@localhost:<meshPgPort>/<dbname>` — derived from the manifest DatabaseDef. */
function pgUrl(dbId: Parameters<typeof getDb>[0], pgPort: number, m: Manifest): string {
  const db = getDb(dbId, m);
  return `postgresql://${db.ownerRole}:${db.ownerPw}@localhost:${pgPort}/${db.name}`;
}

/**
 * Build the canonical `LaunchContext` from up.sh's variable block (~182-299),
 * as PURE data. The runtime supplies only the genuinely host-derived bits
 * (`repoRoots`, `syntheticDevDir`, optional port/sandbox/tunnel overrides); all
 * URLs / DB URLs / mesh creds are derived here from the manifest so there is a
 * single faithful source the audit can check against up.sh.
 *
 * Ports come from the manifest defaults (overlaid by `portOverrides`); DB URLs
 * from each `DatabaseDef`'s owner role/pw (the same derivation the seed layer
 * uses, so seed + launch connection strings can never drift); the rabbitmq /
 * mongo ports from the mesh defs. Creds up.sh hardcodes (rabbitmq_admin, the
 * recorder token, the dev-user uuid) are reproduced verbatim.
 */
export function defaultLaunchContext(inputs: LaunchContextInputs, m: Manifest = manifest): LaunchContext {
  const port = (id: ServiceId): number => inputs.portOverrides?.[id] ?? getService(id, m).port;

  // Resolve every service's port (manifest default unless overridden).
  const ports = {} as Record<ServiceId, number>;
  for (const id of Object.keys(m.services) as ServiceId[]) ports[id] = port(id);

  const pgPort = getMesh('postgres', m).port; // 5432 (mesh shared instance)
  const mqPort = getMesh('rabbitmq', m).port; // 5672
  const mongoPort = getMesh('connect-mongo', m).port; // 27037

  const recorderControlPort = inputs.recorderControlPort ?? 7890;
  const recordingsApiPort = inputs.recordingsApiPort ?? 8444;

  const tokens: LaunchTokens = {
    // ports (string form)
    IAM_PORT: String(ports['iam-api']),
    SIS_PORT: String(ports['sis-api']),
    CONTENT_PORT: String(ports['content-api']),
    CONNECT_API_PORT: String(ports['connect-api']),
    RTSM_PORT: String(ports['rtsm-api']),
    RECORDER_CONTROL_PORT: String(recorderControlPort),
    RECORDINGS_API_PORT: String(recordingsApiPort),
    COACH_API_PORT: String(ports['coach-api']),
    COACH_WEB_PORT: String(ports['coach-web']),
    CONNECT_MONGO_PORT: String(mongoPort),

    // lane base URLs (local/stack lane)
    IAM_URL: `http://localhost:${ports['iam-api']}`,
    DASH_URL: `http://localhost:${ports['saga-dash']}`,
    CONNECT_WEB_URL: `http://localhost:${ports['connect-web']}`,
    CONNECT_API_URL: `http://localhost:${ports['connect-api']}`,
    CONTENT_API_URL: `http://localhost:${ports['content-api']}`,
    RTSM_URL: `http://localhost:${ports['rtsm-api']}`,
    SAGA_API_TARGET: inputs.sagaApiTarget ?? 'https://wootmath.com',
    COACH_API_URL: `http://localhost:${ports['coach-api']}`,
    COACH_WEB_HOST: 'localhost',
    SAGA_API_TARGET_COACH: 'https://staging.wootmath.com',
    IAM_ISSUER: 'https://iam.saga.org',

    // mesh broker + connection strings
    MESH_MQ: `amqp://rabbitmq_admin:password123@localhost:${mqPort}`,
    CONNECT_MONGO_URI: `mongodb://localhost:${mongoPort}/connectv3`,
    SIS_DB_URL: pgUrl('sis_db', pgPort, m),
    PROGRAMS_DB_URL: pgUrl('programs', pgPort, m),
    SCHEDULING_DB_URL: pgUrl('scheduling', pgPort, m),
    SESSIONS_DB_URL: pgUrl('sessions', pgPort, m),
    CONTENT_DB_URL: pgUrl('content', pgPort, m),
    COACH_DB_URL: pgUrl('coach_api', pgPort, m),

    // misc scalars (up.sh hardcodes these verbatim)
    RECORDING_TOKEN: 'local-dev-token',
    DEV_USER_UUID: 'f0000004-0000-4000-8000-00000000beef',
    SYNTHETIC_DEV_DIR: inputs.syntheticDevDir,

    // global launch env (up.sh `:-` defaults; runtime may pass ambient overrides)
    PINO_LOGGER_LEVEL: inputs.pinoLevel ?? 'info',
    PINO_LOGGER_ISEXPRESSCONTEXT: inputs.pinoIsExpressContext ?? 'true',

    // lane-template tokens (only when the matching lane is requested)
    ...(inputs.sandbox
      ? { SANDBOX_NAME: inputs.sandbox.name, SANDBOX_BASE: inputs.sandbox.base ?? 'wootdev.com' }
      : {}),
    ...(inputs.tunnel ? { TUNNEL_DOMAIN: inputs.tunnel.domain } : {}),
  };

  return { ports, repoRoots: inputs.repoRoots, tokens };
}
