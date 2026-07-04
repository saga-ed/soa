/**
 * The 16 ServiceDefs — verified against up.sh (ports `182-299`, the `services_up`
 * launch wall `1373-1584`) and verify.sh (health endpoints `52-76`).
 *
 * All review corrections + user decisions applied:
 *  - saga-dash.dependsOn includes sis-api (roster CSV page) AND content-api (picker).
 *  - sessions-api deps iam-api (url) + programs-api/scheduling-api (event).
 *  - connect-api deps content-api (so any connect closure pulls content + its DB).
 *  - connect-web deps connect-api + rtsm-api + iam-api (browser).
 *  - tunnelSlug carries the PUBLIC host slug (tunnel.sh exposes abbreviated names).
 *  - iam-api gates redis (mesh[] + REDIS_HOST/REDIS_PORT launch.env) — it is the
 *    only redis consumer in the manifest; every other service leaves redis OFF.
 *    (Supersedes the v1 "redis OFF per service" decision 3, 2026-06-29, which
 *    left iam-api dialing a hardcoded :6379 and split-braining across slots.)
 *  - saga-dash carries prelaunchHook: 'sync-dash-local-defaults'.
 *
 * launch.env values are FAITHFUL, COMPLETE templates (M4): each service's env
 * map reproduces EVERY var its up.sh `services_up` launch_if line sets (and only
 * those — no invented vars), with `${TOKEN}` placeholders (e.g. `${IAM_URL}`,
 * `${MESH_MQ}`, `${PROGRAMS_DB_URL}`) for the up.sh scalar variables. The pure
 * `resolveLaunchEnv()` in `core/launch-plan.ts` expands those tokens against a
 * `LaunchContext` the runtime supplies; the resolved strings are what the native
 * partial-stack launcher hands each child. Audit target: diff each resolved env
 * against the matching up.sh launch_if line.
 */

import type { LaneTemplates, ServiceDef, ServiceId } from './types.js';

/**
 * Build the three lane URL templates from a port + tunnel slug.
 *  - stack:   local mesh address.
 *  - sandbox: dev-fleet host, preview-header routed (up.sh sandbox_env).
 *  - tunnel:  public vms rendezvous host (tunnel.sh — rendered from the slug, never the id).
 */
function lanes(port: number, slug: string): LaneTemplates {
  return {
    stack: `http://localhost:${port}`,
    sandbox: `https://${slug}.${'${SANDBOX_NAME}'}.${'${SANDBOX_BASE}'}`,
    tunnel: `https://${slug}.${'${TUNNEL_DOMAIN}'}`,
  };
}

export const SERVICES: Readonly<Record<ServiceId, ServiceDef>> = {
  'iam-api': {
    id: 'iam-api',
    repo: 'ROSTERING',
    subpath: 'apps/node/iam-api',
    port: 3010,
    portEnvVar: 'PORT',
    healthPath: '/health',
    databases: ['iam_local', 'iam_pii_local'],
    dependsOn: [],
    depKinds: {},
    // iam-api genuinely needs redis (lockout / rate-limit / JWT+refresh stores).
    // In mesh[] so a partial `--only iam-api` closure brings redis up; the
    // launch.env below points it at the slot's redis (base 6379 at slot 0).
    mesh: ['postgres', 'redis'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        PORT: '${IAM_PORT}',
        AUTH_DEVUSERID: '${DEV_USER_UUID}',
        CORS_ORIGIN: '${DASH_URL},${CONNECT_WEB_URL}',
        MAIL_FRONTEND_BASE_URL: 'http://localhost:${IAM_PORT}/demo',
        // iam-api assembles its redis URL from REDIS_HOST+REDIS_PORT (localhost ⇒
        // non-TLS redis://). Slot-offset-aware: :6379 at slot 0, :7379 at slot 1.
        // Without these it falls back to a hardcoded localhost:6379 and dials
        // slot 0's redis (ECONNREFUSED alone, or split-brain onto slot 0).
        REDIS_HOST: 'localhost',
        REDIS_PORT: '${REDIS_PORT}',
        // On a fresh clone iam-api/.env doesn't exist, so JANUS_REQUIRED fail-safes
        // to `required` → iam 401s every local S2S call + devLogin ({"realms":["janus"]}).
        // main's up.sh sets it (services_up ~1467, added after gh_214 branched); the CLI
        // must too — same class as the VITE_SESSION_MEASURED miss.
        JANUS_REQUIRED: 'false',
        // apply_fixes parity (up.sh ~457-467): lift the login rate-limit and the
        // access-token TTL far above prod caps so a long local dev / e2e session is
        // never rate-limited (prod caps requests) or forced to re-auth every 15m (prod
        // JWT TTL is 900s). Native injects these on the LAUNCH env rather than mutating
        // iam-api/.env (the dotfile writes are superseded — plan §2.4).
        SECURITY_RATELIMITMAXREQUESTS: '1000000',
        JWT_ACCESSTOKENTTLSECONDS: '28800',
      },
    },
    seed: ['iam-dev-user', 'iam'],
    lane: lanes(3010, 'iam'),
    tunnelSlug: 'iam',
    isFrontend: false,
    optional: false,
  },
  'sis-api': {
    id: 'sis-api',
    repo: 'ROSTERING',
    subpath: 'apps/node/sis-api',
    port: 3100,
    portEnvVar: 'PORT',
    healthPath: '/health',
    databases: ['sis_db'],
    dependsOn: ['iam-api'],
    depKinds: { 'iam-api': 's2s' },
    mesh: ['postgres'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        PORT: '${SIS_PORT}',
        SIS_DATABASE_URL: '${SIS_DB_URL}',
        CORS_ORIGIN: '${DASH_URL}',
        IAM_BASEURL: '${IAM_URL}/trpc',
        IAM_TOKENURL: '${IAM_URL}/v1/oauth/token',
      },
    },
    seed: [],
    lane: lanes(3100, 'sis'),
    tunnelSlug: 'sis',
    isFrontend: false,
    optional: false,
  },
  'programs-api': {
    id: 'programs-api',
    repo: 'PROGRAM_HUB',
    subpath: 'apps/node/programs-api',
    port: 3006,
    portEnvVar: null,
    healthPath: '/health',
    databases: ['programs'],
    dependsOn: ['iam-api'],
    depKinds: { 'iam-api': 'url' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '${PROGRAMS_DB_URL}',
        IAM_API_URL: '${IAM_URL}',
        RABBITMQ_URL: '${MESH_MQ}',
        JANUS_REQUIRED: 'false',
        CORS_ORIGIN: '${DASH_URL}',
        JANUS_LOGIN_HOST: 'localhost:${IAM_PORT}/demo',
      },
    },
    seed: ['programs'],
    lane: lanes(3006, 'programs'),
    tunnelSlug: 'programs',
    isFrontend: false,
    optional: false,
  },
  'scheduling-api': {
    id: 'scheduling-api',
    repo: 'PROGRAM_HUB',
    subpath: 'apps/node/scheduling-api',
    port: 3008,
    portEnvVar: null,
    healthPath: '/health',
    databases: ['scheduling'],
    dependsOn: ['iam-api'],
    depKinds: { 'iam-api': 'url' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '${SCHEDULING_DB_URL}',
        IAM_API_URL: '${IAM_URL}',
        RABBITMQ_URL: '${MESH_MQ}',
        JANUS_REQUIRED: 'false',
        CORS_ORIGIN: '${DASH_URL}',
        JANUS_LOGIN_HOST: 'localhost:${IAM_PORT}/demo',
      },
    },
    seed: [],
    lane: lanes(3008, 'scheduling'),
    tunnelSlug: 'scheduling',
    isFrontend: false,
    optional: false,
  },
  'sessions-api': {
    id: 'sessions-api',
    repo: 'PROGRAM_HUB',
    subpath: 'apps/node/sessions-api',
    port: 3007,
    portEnvVar: null,
    healthPath: '/health',
    databases: ['sessions'],
    dependsOn: ['iam-api', 'programs-api', 'scheduling-api'],
    // iam-api is a required url dep; programs/scheduling are event (projections converge async).
    depKinds: { 'iam-api': 'url', 'programs-api': 'event', 'scheduling-api': 'event' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '${SESSIONS_DB_URL}',
        IAM_API_URL: '${IAM_URL}',
        RABBITMQ_URL: '${MESH_MQ}',
        CORS_ORIGIN: '${DASH_URL}',
      },
    },
    // qtf-demo runs `db:seed:qtf-demo` against the sessions DB (up.sh seed_qtf_demo); add-on, online.
    seed: ['sessions', 'qtf-demo'],
    lane: lanes(3007, 'sessions'),
    tunnelSlug: 'sessions',
    isFrontend: false,
    optional: false,
  },
  'content-api': {
    id: 'content-api',
    repo: 'PROGRAM_HUB',
    subpath: 'apps/node/content-api',
    port: 3009, // app default :3010 collides with iam — run on :3009
    portEnvVar: 'PORT',
    healthPath: '/health',
    databases: ['content'],
    dependsOn: ['iam-api'],
    depKinds: { 'iam-api': 'url' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        PORT: '${CONTENT_PORT}',
        DATABASE_URL: '${CONTENT_DB_URL}',
        IAM_API_URL: '${IAM_URL}',
        RABBITMQ_URL: '${MESH_MQ}',
        CORS_ORIGIN: '${DASH_URL}',
      },
    },
    seed: ['content'],
    lane: lanes(3009, 'content'),
    tunnelSlug: 'content',
    isFrontend: false,
    optional: false,
  },
  'ads-adm-api': {
    id: 'ads-adm-api',
    repo: 'SDS',
    subpath: 'apps/node/ads-adm-api',
    port: 5005,
    portEnvVar: null,
    healthPath: '/health',
    databases: ['ads_adm_local', 'ledger_local'],
    dependsOn: ['iam-api', 'sessions-api'],
    depKinds: { 'iam-api': 'url', 'sessions-api': 's2s' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        ADS_ADM_SCHEDULE_PROVIDER: 'program-hub',
        SESSIONS_API_CLIENT_BASEURL: 'http://localhost:3007',
        IAM_API_CLIENT_BASEURL: 'http://localhost:3010/trpc',
        IAM_API_URL: '${IAM_URL}',
        JWT_ISSUER: 'https://iam.saga.org',
        SERVICE_TOKEN_SERVICESLUG: 'ads-adm-api',
        ADS_ADM_DATABASE_URL: 'postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local',
        DATABASE_URL: 'postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local',
        CORS_ORIGIN: 'http://localhost:8900',
        RABBITMQ_URL: '${MESH_MQ}',
      },
    },
    seed: [],
    lane: lanes(5005, 'ads-adm'),
    tunnelSlug: 'ads-adm',
    isFrontend: false,
    optional: false,
  },
  'saga-dash': {
    id: 'saga-dash',
    repo: 'SAGA_DASH',
    subpath: 'apps/web/dash',
    port: 8900,
    portEnvVar: null,
    healthPath: '/',
    databases: [],
    // Review majors: sis-api (roster CSV page calls sis from the browser) + content-api (picker).
    dependsOn: [
      'iam-api',
      'sis-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
      'content-api',
      'ads-adm-api',
    ],
    depKinds: {
      'iam-api': 'browser',
      'sis-api': 'browser',
      'programs-api': 'browser',
      'scheduling-api': 'browser',
      'sessions-api': 'browser',
      'content-api': 'browser',
      'ads-adm-api': 'browser',
    },
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        VITE_ADS_ADM_REAL: 'true',
        // #280 SESSION measured-time overlay (SessionAttendanceFeed): landed on
        // main's up.sh (services_up:1577); the journey stage-8 spec asserts the
        // session-student-row / session-attendance-summary UI it gates. (Removed
        // in M4 as a presumed rogue edit before #280 merged — re-added once the
        // baseline confirmed main requires it.)
        VITE_SESSION_MEASURED: 'true',
      },
    },
    seed: [],
    lane: lanes(8900, 'dash'),
    tunnelSlug: 'dash',
    isFrontend: true,
    optional: false,
    prelaunchHook: 'sync-dash-local-defaults',
  },
  'connect-api': {
    id: 'connect-api',
    repo: 'QBOARD',
    subpath: 'apps/node/connectv3-api',
    port: 6106,
    portEnvVar: 'PORT',
    healthPath: '/connectv3/v1/health',
    databases: ['connectv3'],
    // §2.3 fix: connect-api → content-api (url), so any connect closure pulls content + its DB.
    dependsOn: ['iam-api', 'sessions-api', 'content-api'],
    depKinds: { 'iam-api': 'url', 'sessions-api': 'url', 'content-api': 'url' },
    mesh: ['connect-mongo', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        PORT: '${CONNECT_API_PORT}',
        MONGO_URI: '${CONNECT_MONGO_URI}',
        // main up.sh:1614 added RABBITMQ_URL to connect-api after gh_214 branched;
        // without it connect-api's publish/consume/outbox get an unset broker URL.
        RABBITMQ_URL: '${MESH_MQ}',
        AUTH_ENABLED: 'true',
        JANUS_REQUIRED: 'false',
        IAM_API_URL: '${IAM_URL}',
        JWT_ISSUER: 'https://iam.saga.org',
        ALLOWED_ORIGINS: '${CONNECT_WEB_URL}',
        SESSIONS_API_BASE_URL: 'http://localhost:3007',
        SAGA_API_TARGET: '${SAGA_API_TARGET}',
        CONTENT_API_URL: '${CONTENT_API_URL}',
        PUBLIC_API_URL: '${CONNECT_API_URL}',
        LIVEKIT_URL: 'ws://localhost:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'devsecret',
        RECORDING_SERVICE_TOKEN: '${RECORDING_TOKEN}',
        RECORDER_URL_TEMPLATE: 'http://127.0.0.1:${RECORDER_CONTROL_PORT}',
        FLEEK_TOPOLOGY_JSON:
          '{"cityMap":{"_default":"ws://localhost:7880"},"nodes":{"local":{"url":"ws://localhost:7880"}}}',
      },
    },
    seed: [],
    lane: lanes(6106, 'connect-api'),
    tunnelSlug: 'connect-api',
    isFrontend: false,
    optional: false,
  },
  'connect-web': {
    id: 'connect-web',
    repo: 'QBOARD',
    subpath: 'apps/web/connectv3',
    port: 6210,
    portEnvVar: null,
    healthPath: '/',
    databases: [],
    dependsOn: ['connect-api', 'rtsm-api', 'iam-api'],
    depKinds: { 'connect-api': 'browser', 'rtsm-api': 'browser', 'iam-api': 'browser' },
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        VITE_CONNECTV3_API_URL: '${CONNECT_API_URL}',
        VITE_IAM_API_URL: '${IAM_URL}',
        VITE_SAGA_API_TARGET: '${SAGA_API_TARGET}',
        VITE_RTSM_BOOTSTRAP_URL: '${RTSM_URL}',
        VITE_DASHBOARD_URL: '${DASH_URL}',
        VITE_JANUS_LOGIN_HOST: '${IAM_URL}/demo',
        VITE_PLAYBACK_ASSET_BASE_OVERRIDE: 'http://localhost:${RECORDINGS_API_PORT}',
      },
    },
    seed: [],
    lane: lanes(6210, 'connect'),
    tunnelSlug: 'connect',
    isFrontend: true,
    optional: false,
  },
  'rtsm-api': {
    id: 'rtsm-api',
    repo: 'RTSM',
    subpath: 'apps/node/rtsm-api',
    port: 6110,
    portEnvVar: 'EXPRESS_SERVER_PORT',
    healthPath: '/health',
    databases: [],
    dependsOn: [],
    depKinds: {},
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        EXPRESS_SERVER_PORT: '${RTSM_PORT}',
        // Non-tunnel FLEET_CONFIG_PATH → the CLI's VENDORED single-node fleet
        // (`vendor/rtsm-fleet-local.json`), resolved via the `VENDOR_DIR` launch token
        // (Phase-2 DECOUPLING) — NOT a soa checkout's `tools/synthetic-dev`. The
        // `--tunnel` case overrides this with the generated rtsm-fleet-tunnel.json.
        FLEET_CONFIG_PATH: '${VENDOR_DIR}/rtsm-fleet-local.json',
        FLEET_NODE_NAME: 'local',
      },
    },
    seed: [],
    lane: lanes(6110, 'rtsm'),
    tunnelSlug: 'rtsm',
    isFrontend: false,
    optional: false,
  },
  'coach-api': {
    id: 'coach-api',
    repo: 'COACH',
    subpath: 'apps/node/coach-api',
    port: 6105,
    portEnvVar: 'EXPRESS_SERVER_PORT',
    // coach-api mounts /health at the app ROOT (not under its /coach/v1 basepath).
    healthPath: '/health',
    databases: ['coach_api'],
    dependsOn: ['iam-api'],
    depKinds: { 'iam-api': 'url' },
    // DUAL-STORE: coach_api pg (via `databases`) + the mesh mongo (curriculum read
    // path). RABBITMQ_ENABLED=false, so rabbitmq is intentionally NOT gated on.
    mesh: ['connect-mongo'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        EXPRESS_SERVER_PORT: '${COACH_API_PORT}',
        DATABASE_URL: '${COACH_DB_URL}',
        MONGO_HOST: 'localhost',
        MONGO_PORT: '${CONNECT_MONGO_PORT}',
        MONGO_DATABASE: 'saga_local',
        CONTENT_DATABASE: 'wmlms_local',
        AUTH_AUTHENABLED: 'true',
        IAM_API_TARGET: '${IAM_URL}',
        AUTH_JWKSURL: '${IAM_URL}/.well-known/jwks.json',
        AUTH_ISSUER: '${IAM_ISSUER}',
        RABBITMQ_ENABLED: 'false',
        RABBITMQ_URL: '${MESH_MQ}',
        EXPRESS_SERVER_CORSALLOWEDDOMAINS: '${COACH_WEB_HOST}',
        SAGA_API_TARGET: '${SAGA_API_TARGET_COACH}',
      },
    },
    seed: [],
    lane: lanes(6105, 'coach'),
    tunnelSlug: 'coach',
    isFrontend: false,
    optional: false,
  },
  'coach-web': {
    id: 'coach-web',
    repo: 'COACH',
    subpath: 'apps/web/coach-web',
    port: 8800,
    portEnvVar: null,
    // SvelteKit SPA — probed on the root path like saga-dash / connect-web.
    healthPath: '/',
    databases: [],
    // Reaches iam server-side THROUGH coach-api, so it only needs the coach-api URL.
    dependsOn: ['coach-api'],
    depKinds: { 'coach-api': 'browser' },
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        PUBLIC_COACH_API_URL: '${COACH_API_URL}',
      },
    },
    seed: [],
    lane: lanes(8800, 'coach-web'),
    tunnelSlug: 'coach-web',
    isFrontend: true,
    optional: false,
  },
  'transcripts-api': {
    id: 'transcripts-api',
    repo: 'SDS',
    subpath: 'apps/node/transcripts-api',
    port: 6302,
    portEnvVar: 'EXPRESS_SERVER_PORT',
    healthPath: '/health',
    databases: ['transcripts_local'],
    dependsOn: [],
    depKinds: {},
    mesh: ['postgres'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: '5432',
        POSTGRES_DATABASE: 'transcripts_local',
        POSTGRES_USERNAME: 'transcripts_app',
        POSTGRES_PASSWORD: 'transcripts_app_local_pw',
        POSTGRES_INSTANCENAME: 'TranscriptsDB',
        EXPRESS_SERVER_PORT: '6302',
        RABBITMQ_URL: '${MESH_MQ}',
        AUTH_AUTHENABLED: 'false',
        JANUS_REQUIRED: 'false',
      },
    },
    seed: ['transcripts'],
    lane: lanes(6302, 'transcripts'),
    tunnelSlug: 'transcripts',
    isFrontend: false,
    optional: true,
  },
  'insights-api': {
    id: 'insights-api',
    repo: 'SDS',
    subpath: 'apps/node/insights-api',
    port: 6301,
    portEnvVar: 'EXPRESS_SERVER_PORT',
    healthPath: '/health',
    databases: ['insights_local'],
    dependsOn: [],
    depKinds: {},
    mesh: ['postgres'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: '5432',
        POSTGRES_DATABASE: 'insights_local',
        POSTGRES_USERNAME: 'insights_app',
        POSTGRES_PASSWORD: 'insights_app_local_pw',
        POSTGRES_INSTANCENAME: 'InsightsDB',
        EXPRESS_SERVER_PORT: '6301',
        RABBITMQ_URL: '${MESH_MQ}',
        AUTH_AUTHENABLED: 'false',
        JANUS_REQUIRED: 'false',
      },
    },
    seed: ['insights'],
    lane: lanes(6301, 'insights'),
    tunnelSlug: 'insights',
    isFrontend: false,
    optional: true,
  },
  'chat-api': {
    id: 'chat-api',
    repo: 'SDS',
    subpath: 'apps/node/chat-api',
    port: 6303,
    portEnvVar: 'EXPRESS_SERVER_PORT',
    healthPath: '/health',
    databases: ['chat_local'],
    dependsOn: [],
    depKinds: {},
    mesh: ['postgres'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: '5432',
        POSTGRES_DATABASE: 'chat_local',
        POSTGRES_USERNAME: 'chat_app',
        POSTGRES_PASSWORD: 'chat_app_local_pw',
        POSTGRES_INSTANCENAME: 'ChatDB',
        EXPRESS_SERVER_PORT: '6303',
        RABBITMQ_URL: '${MESH_MQ}',
        AUTH_AUTHENABLED: 'false',
        JANUS_REQUIRED: 'false',
      },
    },
    seed: ['chat'],
    lane: lanes(6303, 'chat'),
    tunnelSlug: 'chat',
    isFrontend: false,
    optional: true,
  },
};
