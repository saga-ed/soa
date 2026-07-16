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
  /** sessions-api port (3007) — ads-adm-api's SESSIONS_API_CLIENT_BASEURL (was a
   *  literal `:3007` in up.sh; tokenized for M13 ads-adm slottability). */
  SESSIONS_PORT: string;
  /** programs-api port (3006) — ads-adm-api's PROGRAMS_API_CLIENT_BASEURL. ads-adm
   *  resolves program display names from programs-api (`programs.get`), because
   *  sessions-api projects no display strings, so the occurrence wire's programName
   *  is only the programId echo (sds#275). Without this token a slot > 0 ads-adm-api
   *  would dial slot 0's programs-api. */
  PROGRAMS_PORT: string;
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
  /**
   * redis mesh port — base 6379, offset in lockstep with the mesh's published
   * port (M7 slots). iam-api reads `REDIS_HOST`+`REDIS_PORT`; without this it
   * falls back to its own hardcoded localhost:6379 default and dials slot 0's
   * redis (ECONNREFUSED alone, or split-brain onto slot 0). Base 6379 at slot 0
   * is byte-identical to that default; :7379 at slot 1 targets the slot's redis.
   */
  REDIS_PORT: string;
  /** authz-sync port — opt-in service (`--with authz`), no up.sh precedent (new). */
  AUTHZ_SYNC_PORT: string;

  // ── lane base URLs (local/stack lane: http://localhost:<port>) ──
  /** up.sh `IAM_URL`. */
  IAM_URL: string;
  /** up.sh `DASH_URL` (saga-dash, :8900). */
  DASH_URL: string;
  /** up.sh `CONNECT_WEB_URL`. */
  CONNECT_WEB_URL: string;
  /** coach-web (:8800) — its own origin, and the iam URL its browser calls. */
  COACH_WEB_URL: string;
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
  /**
   * The `iss` claim: stamped INTO iam's tokens (JWT_ISSUER) and validated by
   * every JWT-verifying consumer — coach-api (AUTH_ISSUER) plus programs-api,
   * scheduling-api, sessions-api, content-api, ads-adm-api, and connect-api
   * (JWT_ISSUER). One token feeds all ends so they cannot drift — this was
   * `https://iam.saga.org` (prod) while the local iam-api stamped
   * `https://iam.wootdev.com` (its .env default), so coach-api 401'd every
   * locally-minted session; 58d58e4 aligned coach but left the other
   * validators on the prod literal (or the verifier's prod default).
   */
  IAM_ISSUER: string;

  // ── mesh broker + DB / mongo connection strings ──
  /** up.sh `MESH_MQ` — `amqp://rabbitmq_admin:password123@localhost:5672`. */
  MESH_MQ: string;
  /** up.sh `CONNECT_MONGO_URI` — `mongodb://localhost:27037/connectv3`. */
  CONNECT_MONGO_URI: string;
  /** iam-api runtime DB URL — `postgresql://iam:iam@localhost:<pg>/iam_local`.
   *  up.sh relied on `$ROSTERING/.env` carrying a literal `:5432` URL, and the
   *  native launch env silently inherited that fallback: at slot N the iam-api
   *  SERVER dialed slot 0's postgres while its migrations/seeds (slot-correct
   *  seedEnv) went to the slot mesh — a split-brain masked by the deterministic
   *  seed UUIDs. Tokenized so the launch env pins the same slot-offset URL the
   *  seed layer derives (they share pgUrl, so they can never drift). */
  IAM_DB_URL: string;
  /** iam-api PII DB URL — `postgresql://iam_pii:iam_pii@localhost:<pg>/iam_pii_local` (see IAM_DB_URL). */
  IAM_PII_DB_URL: string;
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
  /** ads-adm DB URL — `postgresql://ads_adm:ads_adm@localhost:<pg>/ads_adm_local`
   *  (was a LITERAL `@localhost:5432` in up.sh/the manifest; tokenized for M13
   *  ads-adm slottability so the pg port offsets in lockstep with the slot mesh). */
  ADS_ADM_DB_URL: string;
  /** authz-sync dedup-table DB URL — `postgresql://authz_sync:authz_sync@localhost:<pg>/authz_sync_local`. */
  AUTHZ_SYNC_DB_URL: string;

  // ── misc scalars ──
  /** up.sh `RECORDING_TOKEN` — shared fleek bearer (`local-dev-token`). */
  RECORDING_TOKEN: string;
  /** up.sh `DEV_USER_UUID` — the iam seed dev-user uuid (`f0000004-…beef`). */
  DEV_USER_UUID: string;
  /** The CLI's VENDORED-scripts dir — holds `rtsm-fleet-local.json` (rtsm's non-tunnel
   *  `FLEET_CONFIG_PATH`). Replaces up.sh's `$SCRIPT_DIR`/synthetic-dev tool dir. */
  VENDOR_DIR: string;
  /** rtsm-api `FLEET_CONFIG_PATH` — the fleet file whose `nodes.local.endpoint` the
   *  browser discovers. The vendored `${VENDOR_DIR}/rtsm-fleet-local.json` (endpoint
   *  :6110) at slot 0; a GENERATED per-slot file (endpoint `localhost:<6110+offset>`)
   *  at slot > 0 so a slot's realtime/CRDT socket reaches the SLOT's rtsm (soa#271). */
  RTSM_FLEET_PATH: string;

  // ── OpenFGA authz (opt-in — `--with authz`; new, no up.sh precedent) ──
  /**
   * iam-api's `FGA_ENABLED` — `'true'` only when the `authz` bundle was
   * selected (`effectiveWithAuthz`), else `'false'`. Keeps the OpenFGA footprint
   * off every default `stack up` (opt-in design decision).
   */
  FGA_ENABLED: string;
  /** OpenFGA HTTP API — `http://localhost:8080` (single-slot only; no meshOffset
   *  port-shifting support for openfga in this pass). Feeds both iam-api's
   *  `FGA_API_URL` and authz-sync's `OPENFGA_API_URL`. */
  OPENFGA_API_URL: string;
  /**
   * The bootstrapped OpenFGA store id, or `''` before the `fga-bootstrap` seed
   * step has ever run on this machine (cold start — see base-command.ts's
   * store-id file read). An empty value makes iam-api's `FgaClientService`
   * constructor guard treat FGA as disabled (fail closed, not a crash); NOT a
   * missing-token error like other tokens, since '' is expected on run 1.
   */
  OPENFGA_STORE_ID: string;

  // ── global launch env (up.sh services_up `export`s these ONCE, ~1384-1385, so
  //    every `pnpm dev` child inherits them; soa-logger/soa-config validate them
  //    at startup with NO defaults, so they are required for any node service to
  //    boot). Merged under every service's launch env by `resolveLaunchEnv`. ──
  /** up.sh `PINO_LOGGER_LEVEL` (`${PINO_LOGGER_LEVEL:-info}`). */
  PINO_LOGGER_LEVEL: string;
  /** up.sh `PINO_LOGGER_ISEXPRESSCONTEXT` (`${PINO_LOGGER_ISEXPRESSCONTEXT:-true}`). */
  PINO_LOGGER_ISEXPRESSCONTEXT: string;

  // ── lane-template tokens (sandbox/tunnel lanes only; absent ⇒ stack lane) ──
  /** up.sh `SANDBOX_NAME` — only set under `--sandbox` (sandbox lane URLs + `sandbox_env` gate). */
  SANDBOX_NAME?: string;
  /** up.sh `SANDBOX_BASE` — dev-fleet base domain (sandbox lane URLs + `sandbox_env` iam host). */
  SANDBOX_BASE?: string;
  /** up.sh `TUNNEL_DOMAIN` — `<moniker>.$VMS_BASE`, only set under `--tunnel` (`tunnel_env` gate). */
  TUNNEL_DOMAIN?: string;
  /**
   * up.sh `$STATE/rtsm-fleet-tunnel.json` — the tunnel-flavoured rtsm fleet file the
   * `--tunnel` block generates (endpoint swapped to `rtsm.<domain>`). Only set under
   * `--tunnel`; drives rtsm-api's `tunnel_env` FLEET_CONFIG_PATH override.
   */
  TUNNEL_RTSM_FLEET_PATH?: string;
  /**
   * up.sh `$TUNNEL_LK_KEY` / `$TUNNEL_LK_SECRET` — the fleek dev-cluster LiveKit creds
   * (`qboard/fleek/livekit-creds`) up.sh best-effort-fetches from Secrets Manager under
   * `--tunnel`. Only present when the runtime resolved them; absent ⇒ up.sh's no-creds
   * branch (connect-api signs with the dev key; cluster rejects → AV fails, CRDT works).
   */
  TUNNEL_LK_KEY?: string;
  TUNNEL_LK_SECRET?: string;
}

/**
 * Everything the pure planner needs from the host, supplied by the runtime.
 * No field is read from `process.env` here — the runtime resolves them (ports
 * via `check_ports`, paths via `runtime/scripts`, scalars via up.sh's defaults)
 * and hands them in. `defaultLaunchContext` builds the up.sh defaults so the
 * runtime usually only supplies `repoRoots` + `vendorDir`.
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
 * The fleek dev-cluster AV topology up.sh's `--tunnel` block hardcodes for
 * connect-api (up.sh ~2205-2206). LiveKit media is UDP and can't ride the HTTP
 * tunnels, so tunnel mode ALWAYS points connect-api's AV at the public cluster.
 * `TUNNEL_FLEEK_DEFAULT_URL` MUST match `TUNNEL_FLEEK_TOPOLOGY`'s `_default`.
 */
const TUNNEL_FLEEK_DEFAULT_URL = 'wss://chi-1.fleek.wootdev.com';
const TUNNEL_FLEEK_TOPOLOGY =
  '{"domain":"fleek.wootdev.com","cityMap":{"phx":"wss://phx-1.fleek.wootdev.com","chi":"wss://chi-1.fleek.wootdev.com","nyc":"wss://nyc-1.fleek.wootdev.com","_default":"wss://chi-1.fleek.wootdev.com"}}';

/**
 * `sandbox_env` (up.sh ~1216-1260) as pure data — the per-service env that
 * repoints a locally-run service's iam-api DEP at a cloud sandbox and originates
 * the `x-saga-preview-iam-api: sandbox-<name>` routing header. Gated on
 * `SANDBOX_NAME` being present (up.sh's `IAM_SANDBOX` scalar); returns `{}` in
 * pure-local mode. FAITHFUL: only iam-api is wired as a dep today; sis-api and
 * programs-api ALSO originate the preview header (they parse PREVIEW_ORIGINATE_MAP).
 */
function sandboxOverlay(service: ServiceId, tokens: LaunchTokens): Record<string, string> {
  const name = tokens.SANDBOX_NAME;
  if (name === undefined) return {};
  const iamHost = `https://iam.${tokens.SANDBOX_BASE ?? 'wootdev.com'}`;
  const originate = `x-saga-preview-iam-api=sandbox-${name}`;
  switch (service) {
    case 'sis-api':
      return {
        IAM_BASEURL: `${iamHost}/trpc`,
        IAM_TOKENURL: `${iamHost}/v1/oauth/token`,
        PREVIEW_ORIGINATE_MAP: originate,
      };
    case 'programs-api':
      return { IAM_API_URL: iamHost, PREVIEW_ORIGINATE_MAP: originate };
    case 'scheduling-api':
    case 'sessions-api':
      // URL flip only (no outbound iam S2S client to originate for — up.sh note).
      return { IAM_API_URL: iamHost };
    default:
      return {}; // iam-api itself / saga-dash / ads-adm / rtsm / connect: no dep repoint wired
  }
}

/**
 * `tunnel_env` (up.sh ~1292-1366) as pure data — the browser-plane env that
 * flips CORS origins, the iam session-cookie domain, and the VITE_* dependency
 * URLs to the public tunnel hosts. Gated on `TUNNEL_DOMAIN`; returns `{}` when
 * the tunnel is not requested. Splatted AFTER `sandbox_env` (env last-wins),
 * matching up.sh's trailing `$(sandbox_env x) $(tunnel_env x)` order.
 */
function tunnelOverlay(service: ServiceId, tokens: LaunchTokens): Record<string, string> {
  const td = tokens.TUNNEL_DOMAIN;
  if (td === undefined) return {};
  const dash = tokens.DASH_URL;
  const connectWeb = tokens.CONNECT_WEB_URL;
  switch (service) {
    case 'iam-api':
      return {
        AUTH_SESSIONCOOKIEDOMAIN: `.${td}`,
        CORS_ORIGIN: `${dash},${connectWeb},https://dash.${td},https://connect.${td}`,
        MAIL_FRONTEND_BASE_URL: `https://iam.${td}/demo`,
      };
    case 'sis-api':
      return {
        CORS_ORIGIN: `${dash},http://localhost:${tokens.IAM_PORT},https://dash.${td},https://iam.${td}`,
      };
    case 'programs-api':
    case 'scheduling-api':
    case 'sessions-api':
    case 'ads-adm-api':
      return {
        CORS_ORIGIN: `${dash},https://dash.${td}`,
        JANUS_LOGIN_HOST: `iam.${td}/demo`,
      };
    case 'connect-api': {
      const env: Record<string, string> = {
        ALLOWED_ORIGINS: `${connectWeb},https://connect.${td}`,
        PUBLIC_API_URL: `https://connect-api.${td}`,
        JANUS_LOGIN_HOST: `iam.${td}/demo`,
        // AV → the fleek dev cluster (ALWAYS in tunnel mode; local LiveKit is UDP).
        FLEEK_TOPOLOGY_JSON: TUNNEL_FLEEK_TOPOLOGY,
        LIVEKIT_URL: TUNNEL_FLEEK_DEFAULT_URL,
      };
      // Real cluster creds overlay ONLY when the runtime resolved them (up.sh's
      // best-effort Secrets Manager fetch); absent ⇒ signs with the dev key.
      if (tokens.TUNNEL_LK_KEY && tokens.TUNNEL_LK_SECRET) {
        env.LIVEKIT_API_KEY = tokens.TUNNEL_LK_KEY;
        env.LIVEKIT_API_SECRET = tokens.TUNNEL_LK_SECRET;
      }
      return env;
    }
    case 'connect-web':
      return {
        VITE_CONNECTV3_API_URL: `https://connect-api.${td}`,
        VITE_IAM_API_URL: `https://iam.${td}`,
        VITE_RTSM_BOOTSTRAP_URL: `https://rtsm.${td}`,
        VITE_JANUS_LOGIN_HOST: `https://iam.${td}/demo`,
        VITE_DASHBOARD_URL: `https://dash.${td}`,
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `connect.${td}`,
      };
    case 'rtsm-api':
      // Advertise the tunnel host as the node endpoint (the generated fleet file);
      // absent path ⇒ keep the base local fleet (remote discovery falls back).
      return tokens.TUNNEL_RTSM_FLEET_PATH
        ? { FLEET_CONFIG_PATH: tokens.TUNNEL_RTSM_FLEET_PATH }
        : {};
    case 'saga-dash':
      return { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `dash.${td}` };
    case 'coach-api':
      // EXPRESS_SERVER_CORSALLOWEDDOMAINS is coach's hostname allow-list (comma-
      // split; api-core matches origin.hostname === d || endsWith(".d")), so the
      // BARE tunnel domain admits coach.${td} — and any other tunnel label —
      // without enumerating them. Keep COACH_WEB_HOST (localhost) so a local
      // browser still works alongside remote ones. Splatted after the launch
      // env's CORS value, so this wins (env last-wins).
      return {
        EXPRESS_SERVER_CORSALLOWEDDOMAINS: `${tokens.COACH_WEB_HOST},${td}`,
      };
    case 'coach-web':
      // coach-web's PUBLIC_* vars are BROWSER-side (SvelteKit `$env/static/public`,
      // inlined at vite-dev start), so EVERY host a remote coworker's browser dials
      // must be a public tunnel name — localhost is unreachable from their machine.
      //
      // These belong in the LAUNCH ENV (here) rather than coach-web's `.env.local`:
      // for a PUBLIC_ var, `process.env` WINS over `.env.local`/`.env`, so the launch
      // env is the only override that reliably reaches the browser. (Live-proved over
      // a real tunnel: with both set and disagreeing, the bundle carried the launch
      // env's value; vars ABSENT here fell through to `.env.local`.)
      return {
        PUBLIC_COACH_API_URL: `https://coach-api.${td}`,
        // iam MUST flip too — the browser fetches whoami DIRECT from iam, NOT through
        // coach-api (coach-web `src/lib/api/session.ts`:
        // `const WHOAMI_URL = \`${'$'}{PUBLIC_IAM_API_URL}/trpc/auth.whoami\``). The base
        // manifest pins this to `${'$'}{IAM_URL}` (localhost:3010) for the local mesh, and
        // that would otherwise reach the remote browser verbatim → whoami fails →
        // coach-web renders the soa#300 503 "Unable to reach the sign-in service".
        PUBLIC_IAM_API_URL: `https://iam.${td}`,
        // Logout target and the "open dashboard" link. Not boot-critical (unlike the two
        // above), but their `.env` defaults are the SHARED remote hosts
        // (login./dash.wootdev.com) — a tunnel session must stay inside its own mesh.
        // No `login` host exists in tunnel.sh SERVICES, so login points at iam (which
        // serves the /demo challenge), matching the local lane.
        PUBLIC_LOGIN_URL: `https://iam.${td}`,
        PUBLIC_DASHBOARD_URL: `https://dash.${td}`,
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `coach.${td}`,
      };
    default:
      return {}; // everything else: dev CORS wildcard already admits *.wootdev.com
  }
}

/**
 * Lane-specific env OVERRIDES, splatted on top of the base launch env — a
 * FAITHFUL port of up.sh's `sandbox_env` + `tunnel_env` (Phase 2, saga-ed/soa#214).
 * Both are gated on their token being present in `ctx` (not on `lane`): the
 * native hybrid/tunnel launch drives the local `stack` lane URLs but repoints the
 * relevant deps/browser env exactly as up.sh's trailing `$(sandbox_env x)
 * $(tunnel_env x)` splat did. Pure-local (`stack up`) ⇒ neither token set ⇒ `{}`.
 */
function laneOverlay(service: ServiceId, _lane: Lane, ctx: LaunchContext): Record<string, string> {
  return { ...sandboxOverlay(service, ctx.tokens), ...tunnelOverlay(service, ctx.tokens) };
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

  // M13 LISTEN-PORT FIX: a backend whose listen port is env-driven
  // (`portEnvVar` — programs/scheduling/sessions read `$PORT || <base>`) must
  // be TOLD its per-slot offset port, or at slot > 0 it binds its BASE port:
  // EADDRINUSE when slot 0 is live, or a silent wrong-port bind whose health
  // poll then times out on the offset port (the previously misdiagnosed
  // "slot>0 programs-api cold-start wedge"). Injected ONLY when the resolved
  // port differs from the manifest base, so slot-0 env stays byte-identical;
  // an explicit launch.env template entry for the same var still wins.
  const portEnvVar = def.portEnvVar;
  if (portEnvVar != null && ctx.ports[service] !== def.port && !(portEnvVar in env)) {
    env[portEnvVar] = String(ctx.ports[service]);
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
  /** The CLI's VENDORED-scripts dir (holds `rtsm-fleet-local.json`) — the runtime
   *  passes `dirname(resolveVendorScript('rtsm-fleet-local.json'))`. Replaces up.sh's
   *  `$SCRIPT_DIR`/synthetic-dev tool dir for rtsm's non-tunnel FLEET_CONFIG_PATH. */
  vendorDir: string;
  /** Absolute path to a GENERATED per-slot rtsm fleet file (endpoint swapped to the
   *  slot's rtsm port). Absent ⇒ `RTSM_FLEET_PATH` defaults to the vendored file
   *  (slot 0, byte-identical). Set by `up` at slot > 0 (soa#271). */
  rtsmFleetPath?: string;
  /** `SAGA_API_TARGET` override (up.sh honours `$SAGA_API_TARGET`; default https://wootmath.com). */
  sagaApiTarget?: string;
  /** Per-service port overrides (e.g. a `check_ports` remap); defaults to the manifest port. */
  portOverrides?: Partial<Record<ServiceId, number>>;
  /**
   * Offset added to the mesh ports (postgres/rabbitmq/connect-mongo) so
   * `MESH_MQ` / `CONNECT_MONGO_URI` / `*_DB_URL` (and `CONNECT_MONGO_PORT`)
   * point at a slot's offset mesh in lockstep with the mesh's published ports
   * (M7). Default 0 ⇒ today's base mesh ports (byte-identical to no offset).
   */
  meshOffset?: number;
  /** Fleek recorder control port (up.sh `RECORDER_CONTROL_PORT`; default 7890). */
  recorderControlPort?: number;
  /** Fleek recordings-api port (up.sh `RECORDINGS_API_PORT`; default 8444). */
  recordingsApiPort?: number;
  /** Sandbox lane inputs — set only under `--sandbox` (drives `sandbox_env`). */
  sandbox?: { name: string; base?: string };
  /**
   * Tunnel lane input — set only under `--tunnel` (drives `tunnel_env`). `domain`
   * is `<moniker>.<VMS_BASE>` (from the vendored `tunnel.sh moniker`); `rtsmFleetPath`
   * is the generated `rtsm-fleet-tunnel.json` (rtsm-api FLEET_CONFIG_PATH override);
   * `lkKey`/`lkSecret` are the best-effort fleek-cluster LiveKit creds.
   */
  tunnel?: { domain: string; rtsmFleetPath?: string; lkKey?: string; lkSecret?: string };
  /** up.sh `${PINO_LOGGER_LEVEL:-info}` — ambient override, else `info`. */
  pinoLevel?: string;
  /** up.sh `${PINO_LOGGER_ISEXPRESSCONTEXT:-true}` — ambient override, else `true`. */
  pinoIsExpressContext?: string;
  /**
   * Whether the `authz` bundle was selected (`effectiveWithAuthz(flags.with)`) —
   * drives `FGA_ENABLED`. Default `false` (opt-in design decision — every
   * default `stack up` keeps FGA off).
   */
  withAuthz?: boolean;
  /**
   * The bootstrapped OpenFGA store id, read synchronously from the fixed
   * store-id file (or `SAGA_STACK_OPENFGA_STORE_ID` env override) by the
   * runtime BEFORE calling `defaultLaunchContext` — same seam as `--tunnel`'s
   * `resolveOverlays()`. Absent/`''` ⇒ cold start (see `OPENFGA_STORE_ID`).
   */
  openfgaStoreId?: string;
}

/** `postgresql://<owner>:<pw>@localhost:<meshPgPort>/<dbname>` — derived from the manifest DatabaseDef. */
function pgUrl(dbId: Parameters<typeof getDb>[0], pgPort: number, m: Manifest): string {
  const db = getDb(dbId, m);
  return `postgresql://${db.ownerRole}:${db.ownerPw}@localhost:${pgPort}/${db.name}`;
}

/**
 * Build the canonical `LaunchContext` from up.sh's variable block (~182-299),
 * as PURE data. The runtime supplies only the genuinely host-derived bits
 * (`repoRoots`, `vendorDir`, optional port/sandbox/tunnel overrides); all
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

  // Mesh ports offset in lockstep with the mesh's published ports (M7 slots).
  // meshOffset 0 (the default) ⇒ today's base ports, byte-identical to no offset.
  const meshOffset = inputs.meshOffset ?? 0;
  const pgPort = getMesh('postgres', m).port + meshOffset; // 5432 (mesh shared instance)
  const mqPort = getMesh('rabbitmq', m).port + meshOffset; // 5672
  const mongoPort = getMesh('connect-mongo', m).port + meshOffset; // 27037
  const redisPort = getMesh('redis', m).port + meshOffset; // 6379

  const recorderControlPort = inputs.recorderControlPort ?? 7890;
  const recordingsApiPort = inputs.recordingsApiPort ?? 8444;

  const tokens: LaunchTokens = {
    // ports (string form)
    IAM_PORT: String(ports['iam-api']),
    SIS_PORT: String(ports['sis-api']),
    SESSIONS_PORT: String(ports['sessions-api']),
    PROGRAMS_PORT: String(ports['programs-api']),
    CONTENT_PORT: String(ports['content-api']),
    CONNECT_API_PORT: String(ports['connect-api']),
    RTSM_PORT: String(ports['rtsm-api']),
    RECORDER_CONTROL_PORT: String(recorderControlPort),
    RECORDINGS_API_PORT: String(recordingsApiPort),
    COACH_API_PORT: String(ports['coach-api']),
    COACH_WEB_PORT: String(ports['coach-web']),
    CONNECT_MONGO_PORT: String(mongoPort),
    REDIS_PORT: String(redisPort),
    AUTHZ_SYNC_PORT: String(ports['authz-sync']),

    // lane base URLs (local/stack lane)
    IAM_URL: `http://localhost:${ports['iam-api']}`,
    DASH_URL: `http://localhost:${ports['saga-dash']}`,
    CONNECT_WEB_URL: `http://localhost:${ports['connect-web']}`,
    COACH_WEB_URL: `http://localhost:${ports['coach-web']}`,
    CONNECT_API_URL: `http://localhost:${ports['connect-api']}`,
    CONTENT_API_URL: `http://localhost:${ports['content-api']}`,
    RTSM_URL: `http://localhost:${ports['rtsm-api']}`,
    SAGA_API_TARGET: inputs.sagaApiTarget ?? 'https://wootmath.com',
    COACH_API_URL: `http://localhost:${ports['coach-api']}`,
    COACH_WEB_HOST: 'localhost',
    SAGA_API_TARGET_COACH: 'https://staging.wootmath.com',
    IAM_ISSUER: 'https://iam.wootdev.com',

    // mesh broker + connection strings
    MESH_MQ: `amqp://rabbitmq_admin:password123@localhost:${mqPort}`,
    CONNECT_MONGO_URI: `mongodb://localhost:${mongoPort}/connectv3`,
    IAM_DB_URL: pgUrl('iam_local', pgPort, m),
    IAM_PII_DB_URL: pgUrl('iam_pii_local', pgPort, m),
    SIS_DB_URL: pgUrl('sis_db', pgPort, m),
    PROGRAMS_DB_URL: pgUrl('programs', pgPort, m),
    SCHEDULING_DB_URL: pgUrl('scheduling', pgPort, m),
    SESSIONS_DB_URL: pgUrl('sessions', pgPort, m),
    CONTENT_DB_URL: pgUrl('content', pgPort, m),
    COACH_DB_URL: pgUrl('coach_api', pgPort, m),
    ADS_ADM_DB_URL: pgUrl('ads_adm_local', pgPort, m),
    AUTHZ_SYNC_DB_URL: pgUrl('authz_sync_local', pgPort, m),

    // misc scalars (up.sh hardcodes these verbatim)
    RECORDING_TOKEN: 'local-dev-token',
    DEV_USER_UUID: 'f0000004-0000-4000-8000-00000000beef',
    VENDOR_DIR: inputs.vendorDir,
    RTSM_FLEET_PATH: inputs.rtsmFleetPath ?? `${inputs.vendorDir}/rtsm-fleet-local.json`,

    // OpenFGA authz (opt-in — see LaunchTokens' FGA_ENABLED/OPENFGA_* docs)
    FGA_ENABLED: inputs.withAuthz ? 'true' : 'false',
    OPENFGA_API_URL: 'http://localhost:8080',
    OPENFGA_STORE_ID: inputs.openfgaStoreId ?? '',

    // global launch env (up.sh `:-` defaults; runtime may pass ambient overrides)
    PINO_LOGGER_LEVEL: inputs.pinoLevel ?? 'info',
    PINO_LOGGER_ISEXPRESSCONTEXT: inputs.pinoIsExpressContext ?? 'true',

    // lane-template tokens (only when the matching lane is requested)
    ...(inputs.sandbox
      ? { SANDBOX_NAME: inputs.sandbox.name, SANDBOX_BASE: inputs.sandbox.base ?? 'wootdev.com' }
      : {}),
    ...(inputs.tunnel
      ? {
          TUNNEL_DOMAIN: inputs.tunnel.domain,
          ...(inputs.tunnel.rtsmFleetPath ? { TUNNEL_RTSM_FLEET_PATH: inputs.tunnel.rtsmFleetPath } : {}),
          ...(inputs.tunnel.lkKey ? { TUNNEL_LK_KEY: inputs.tunnel.lkKey } : {}),
          ...(inputs.tunnel.lkSecret ? { TUNNEL_LK_SECRET: inputs.tunnel.lkSecret } : {}),
        }
      : {}),
  };

  return { ports, repoRoots: inputs.repoRoots, tokens };
}
