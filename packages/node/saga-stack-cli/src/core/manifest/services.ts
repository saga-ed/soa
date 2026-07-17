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
        // Stamp the SAME issuer coach-api validates (its AUTH_ISSUER). Injected
        // rather than left to iam-api/.env so the two ends can never drift.
        JWT_ISSUER: '${IAM_ISSUER}',
        // coach-web is here because its browser calls iam's auth.whoami direct
        // (coach-web session.ts) — omit it and every coach page 503s on CORS.
        CORS_ORIGIN: '${DASH_URL},${CONNECT_WEB_URL},${COACH_WEB_URL}',
        MAIL_FRONTEND_BASE_URL: 'http://localhost:${IAM_PORT}/demo',
        // iam-api assembles its redis URL from REDIS_HOST+REDIS_PORT (localhost ⇒
        // non-TLS redis://). Slot-offset-aware: :6379 at slot 0, :7379 at slot 1.
        // Without these it falls back to a hardcoded localhost:6379 and dials
        // slot 0's redis (ECONNREFUSED alone, or split-brain onto slot 0).
        REDIS_HOST: 'localhost',
        REDIS_PORT: '${REDIS_PORT}',
        // iam-api's dotenv chain falls back to $ROSTERING/.env, which bakes
        // LITERAL :5432 DATABASE_URL/PII_DATABASE_URL — so at slot > 0 the
        // SERVER dialed slot 0's postgres while its migrate/seed steps (slot-
        // correct seedEnv) hit the slot mesh: a split-brain that deterministic
        // seed UUIDs masked (devLogin "worked" against slot 0's iam_local).
        // dotenv never overrides real env, so injecting here wins at every slot
        // and expands to the exact legacy literals at slot 0 (byte-identity).
        DATABASE_URL: '${IAM_DB_URL}',
        PII_DATABASE_URL: '${IAM_PII_DB_URL}',
        // Same class, third instance: iam-api's OutboxRelay reads RABBITMQ_URL
        // with a $ROSTERING/.env.local fallback baking LITERAL :5672 — so at
        // slot > 0 iam.* events published to slot 0's broker while the slot's
        // consumers (sessions-api iam-projection et al.) listen on the slot
        // mesh. MESH_MQ expands to the same rabbitmq_admin URL at the slot's
        // offset port (:5672 at slot 0 — byte-identity with .env.local holds).
        RABBITMQ_URL: '${MESH_MQ}',
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
        // OpenFGA authz — opt-in via `--with authz` (core/bundles.ts's `authz`
        // bundle). FGA_ENABLED resolves to 'false' when the bundle isn't selected
        // (launch-plan.ts), so this is a no-op on every default `stack up`. When
        // selected, FGA_STORE_ID resolves from the fga-bootstrap seed step's
        // out-file on run 2+ (see base-command.ts) — '' on a cold-start first run,
        // which FgaClientService's constructor guard treats as disabled (fail
        // closed, not a crash).
        FGA_ENABLED: '${FGA_ENABLED}',
        FGA_API_URL: '${OPENFGA_API_URL}',
        FGA_STORE_ID: '${OPENFGA_STORE_ID}',
      },
    },
    // 'fga-bootstrap' (ADDON_STEPS.authz, core/seed/profiles.ts) is NOT listed here —
    // this field only ever lists a service's PROFILE_STEPS-driven ids (mirrors how
    // transcripts-api's own `seed: ['transcripts']` omits its add-on
    // 'transcripts-provision' step too); add-on steps are selected via
    // ADDON_STEPS, not this field.
    seed: ['iam-dev-user', 'iam'],
    lane: lanes(3010, 'iam'),
    tunnelSlug: 'iam',
    isFrontend: false,
    optional: false,
    // iam MINTS the iss every JWT consumer validates (its JWT_ISSUER, stamped from
    // ${IAM_ISSUER}). An already-up iam launched by an older CLI without this stamp
    // falls back to iam-api's saga.org default and mints a token coach-api rejects
    // (invalid-issuer → 401) — so a drifted/adopted iam is worse than none. Guard
    // adoption on it (soa#305).
    //
    // soa#336: JWT_ISSUER alone can't tell a tunnel leftover from a plain run —
    // ${IAM_ISSUER} is lane-independent, so both modes stamp the SAME fingerprint
    // and a tunnel-env'd iam gets silently adopted by a plain `up`/`develop`.
    // What tunnelOverlay() actually rewrites on iam-api is the browser-plane trio
    // below, so fingerprint those too:
    //  - CORS_ORIGIN / MAIL_FRONTEND_BASE_URL: in the plain launch env AND
    //    value-flipped under --tunnel ⇒ the fingerprints differ in both directions.
    //  - AUTH_SESSIONCOOKIEDOMAIN: tunnel-ONLY (no plain-env entry). The
    //    fingerprint OMITS absent keys, so a plain stamp lacks it while a tunnel
    //    stamp carries it — present-vs-omitted still mismatches BOTH ways, which
    //    is exactly the refusal we want (the saga-dash DASH_CONFIG_LOCAL_JSON
    //    guard relies on the same asymmetry).
    // Same one-time "stop and re-run" cost as saga-dash for processes stamped by
    // a pre-#336 CLI (their recorded contract is the JWT_ISSUER-only shape).
    adoptEnv: ['JWT_ISSUER', 'CORS_ORIGIN', 'MAIL_FRONTEND_BASE_URL', 'AUTH_SESSIONCOOKIEDOMAIN'],
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
    portEnvVar: 'PORT',
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
        // Validate the SAME issuer iam-api stamps (its JWT_ISSUER). Without this
        // the rostering-client verifier falls back to the prod issuer and 401s
        // every locally-minted session on authenticated procedures.
        JWT_ISSUER: '${IAM_ISSUER}',
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
    portEnvVar: 'PORT',
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
        // Same iss iam-api stamps — see programs-api's JWT_ISSUER note.
        JWT_ISSUER: '${IAM_ISSUER}',
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
    portEnvVar: 'PORT',
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
        // Same iss iam-api stamps — see programs-api's JWT_ISSUER note.
        JWT_ISSUER: '${IAM_ISSUER}',
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
        // Same iss iam-api stamps — see programs-api's JWT_ISSUER note.
        JWT_ISSUER: '${IAM_ISSUER}',
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
    // ads-adm-api reads its listen port via DotenvConfigManager +
    // ExpressServerEnvSchema → EXPRESS_SERVER_* (verified in its
    // inversify.config.ts / config/schemas.ts; the repo .env bakes
    // EXPRESS_SERVER_PORT=5005 but dotenv never overrides real env, so the
    // M13 listen-port injection wins at slot > 0 and is absent at slot 0).
    portEnvVar: 'EXPRESS_SERVER_PORT',
    healthPath: '/health',
    databases: ['ads_adm_local', 'ledger_local'],
    // programs-api: ads-adm resolves program display NAMES from it (`programs.get`,
    // a publicProcedure → 'url', not 's2s' like sessions-api's service-gated reads).
    // sessions-api projects no display strings, so the occurrence wire's programName
    // is only the programId echo; ads-adm resolves names itself (sds#275).
    dependsOn: ['iam-api', 'sessions-api', 'programs-api'],
    depKinds: { 'iam-api': 'url', 'sessions-api': 's2s', 'programs-api': 'url' },
    mesh: ['postgres', 'rabbitmq'],
    launch: {
      cmd: 'pnpm dev',
      // Fully tokenized (ads-adm slottability): every cross-service/mesh URL
      // resolves through the launch context, so a slot > 0 ads-adm-api dials
      // ITS slot's sessions/iam/postgres/dash — never slot 0's. At slot 0
      // the tokens expand to exactly the old literals (byte-identity holds).
      env: {
        ADS_ADM_SCHEDULE_PROVIDER: 'program-hub',
        // Session layer resolves via program-hub's sessions-api (sds e693d82).
        // Without this the DI default falls back to the legacy program-hub
        // provider whose saga_api `ars` bridge is retired and never runs in
        // the synthetic mesh — the collator then never stamps the SLS linkage
        // (externalSourceType/Id) and every live SESSION row renders under
        // "Unscheduled" with no per-session grouping (saga-dash gh_560 manual
        // pass, 2026-07-17). Was previously a hand-exported demo var that
        // silently died on relaunch; baking it here makes grouping survive
        // cold-start. Prod is masked by design (never ss-launched).
        ADS_ADM_SESSION_DATA_PROVIDER: 'sessions-api',
        // Second half of the same gate (sds e693d82): the mock policy
        // provider defaults sessionDataEnabled=false per program, which makes
        // the collator IGNORE the session layer (ignoreSessionData) and clear
        // the SLS stamp even when the provider above is bound. Both vars are
        // required for grouped SESSION rows; both died together on relaunch.
        ADS_ADM_MOCK_SESSION_DATA_ENABLED: 'true',
        SESSIONS_API_CLIENT_BASEURL: 'http://localhost:${SESSIONS_PORT}',
        PROGRAMS_API_CLIENT_BASEURL: 'http://localhost:${PROGRAMS_PORT}',
        IAM_API_CLIENT_BASEURL: '${IAM_URL}/trpc',
        IAM_API_URL: '${IAM_URL}',
        // Same iss iam-api stamps — see programs-api's JWT_ISSUER note. Was the
        // prod literal, which 401'd once iam began minting ${IAM_ISSUER} (58d58e4).
        JWT_ISSUER: '${IAM_ISSUER}',
        SERVICE_TOKEN_SERVICESLUG: 'ads-adm-api',
        // NOT an up.sh literal — a deliberate post-up.sh addition, like
        // PROGRAMS_API_CLIENT_BASEURL above (soa#320 precedent). Opens ads-adm's
        // per-request rosterMode override gate so e2e probes (saga-dash#446 /
        // saga-dash#570 period-path) can hard-assert period-roster derivation in
        // CI. The DEFAULT mode is untouched (ADM_ROSTER_MODE deliberately not
        // set — occurrence stays the default); prod is masked by design since
        // prod is never ss-launched and its deployment omits this flag.
        ADM_ALLOW_ROSTER_MODE_OVERRIDE: 'true',
        ADS_ADM_DATABASE_URL: '${ADS_ADM_DB_URL}',
        DATABASE_URL: '${ADS_ADM_DB_URL}',
        CORS_ORIGIN: '${DASH_URL}',
        RABBITMQ_URL: '${MESH_MQ}',
      },
    },
    seed: [],
    lane: lanes(5005, 'ads-adm'),
    tunnelSlug: 'ads-adm',
    isFrontend: false,
    optional: false,
    // Adoption guard (soa#305 pattern): a process launched before this flag
    // existed carries no gate, and the launcher would happily adopt it — the
    // #446/#570 period-path probe then hard-fails with a confusing cause
    // ("ignoring client-supplied rosterMode"). Fingerprinting the key refuses
    // the stale process instead. One-time "stop and re-run" cost for
    // pre-existing processes, same as iam-api/saga-dash paid.
    // ADS_ADM_SESSION_DATA_PROVIDER joins the fingerprint so a pre-existing
    // process launched without it (legacy provider ⇒ no SESSION grouping) is
    // refused rather than silently adopted — same trap, same cure.
    adoptEnv: [
      'ADM_ALLOW_ROSTER_MODE_OVERRIDE',
      'ADS_ADM_SESSION_DATA_PROVIDER',
      'ADS_ADM_MOCK_SESSION_DATA_ENABLED',
    ],
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
        // soa#271 LAYER 3: the ?mode=session dev override (overrides/resolver.ts gates
        // on this) so an admin can force the SESSION attendance surface to assert the
        // measured-time overlay renders real TELEMETRY dosage (journey stage-8, #280).
        VITE_ENABLE_OVERRIDES: 'true',
      },
    },
    seed: [],
    lane: lanes(8900, 'dash'),
    tunnelSlug: 'dash',
    isFrontend: true,
    optional: false,
    prelaunchHook: 'sync-dash-local-defaults',
    // soa#328: the dash's routing JSON rides its OWN launch env now
    // (DASH_CONFIG_LOCAL_JSON — dash-defaults.ts's DASH_CONFIG_ENV_VAR, stamped
    // by stack-api's launch loop in tunnel / slot > 0 modes), and a new-enough
    // dash dev server serves that env verbatim for /config.local.json —
    // SHADOWING the static file. Without this guard an already-up dash from a
    // different mode gets adopted with its frozen routing (e.g. `up --tunnel`
    // then plain `up`: the file hook removes config.local.json, but the adopted
    // dash keeps serving the dead tunnel hosts from its stale env — the
    // file-only self-heal the dash used to have is gone). Fingerprint the key so
    // a mode-drifted dash is REFUSED loudly and relaunched with the current
    // mode's env (soa#305 pattern, like iam-api's JWT_ISSUER; same one-time
    // "stop and re-run" cost for a dash launched by an older CLI with no stamp).
    adoptEnv: ['DASH_CONFIG_LOCAL_JSON'],
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
        // Same iss iam-api stamps — see programs-api's JWT_ISSUER note. Was the
        // prod literal, which 401'd once iam began minting ${IAM_ISSUER} (58d58e4).
        JWT_ISSUER: '${IAM_ISSUER}',
        // #222 port: dash calls connect-api cross-origin (journey attendance /
        // connect embeds) — without DASH_URL in the allowlist those are CORS-blocked.
        ALLOWED_ORIGINS: '${CONNECT_WEB_URL},${DASH_URL}',
        // soa#271: tokenize the sessions dial so connect-api reaches the SLOT's
        // sessions-api (byte-identical :3007 at slot 0, :5007 at slot 2). This is
        // the one cross-slot literal that made connect-api un-slottable; the
        // remaining literals (livekit/FLEEK ws:7880) are AV and stay slot-0-pinned.
        SESSIONS_API_BASE_URL: 'http://localhost:${SESSIONS_PORT}',
        SAGA_API_TARGET: '${SAGA_API_TARGET}',
        CONTENT_API_URL: '${CONTENT_API_URL}',
        PUBLIC_API_URL: '${CONNECT_API_URL}',
        LIVEKIT_URL: 'ws://localhost:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'devsecret',
        // #222 port: point the private-convos supervisor at the local rtsm so
        // server-side dark-corner enforcement runs (otherwise connect-api logs
        // "private-convos registry disabled" and private conversations aren't
        // enforced). Tokenized (up.sh hardcoded :6110) so slots stay correct.
        RTSM_API_URL: '${RTSM_URL}',
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
    // soa#336 (the saga-dash soa#328 idiom): connect-web's VITE_* deps are
    // BROWSER-plane, resolved by the vite dev server from its launch env at
    // start — an adopted dev server keeps serving whatever hosts it started
    // with, and nothing written to disk afterward can win (launch env >
    // dotfiles). In the tunnel-then-plain incident that meant a leftover
    // `--tunnel` frontend rode into a plain run still dialing the dead
    // https://*.vms.wootdev.com hosts. Fingerprint the tunnel-rewritten dep
    // URLs (all five are in the plain launch env above AND value-flipped by
    // tunnelOverlay(), so tunnel-vs-plain mismatches in both directions) so a
    // mode-drifted connect-web is REFUSED loudly and relaunched with the
    // current mode's env — refuse-or-relaunch, never adopt.
    adoptEnv: [
      'VITE_CONNECTV3_API_URL',
      'VITE_IAM_API_URL',
      'VITE_RTSM_BOOTSTRAP_URL',
      'VITE_JANUS_LOGIN_HOST',
      'VITE_DASHBOARD_URL',
    ],
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
        // FLEET_CONFIG_PATH → the fleet file whose `nodes.local.endpoint` is the
        // BROWSER-visible rtsm host. `${RTSM_FLEET_PATH}` resolves to the CLI's VENDORED
        // single-node fleet (`vendor/rtsm-fleet-local.json`, endpoint :6110) at slot 0 —
        // byte-identical to the old `${VENDOR_DIR}/...` — and to a GENERATED per-slot
        // file (endpoint `localhost:<6110+offset>`) at slot > 0 (soa#271), so a slot's
        // browser CRDT/realtime socket reaches the SLOT's own rtsm, not slot 0's (the
        // realtime plane is stateful and does NOT share). The `--tunnel` case overrides
        // this with the generated rtsm-fleet-tunnel.json.
        FLEET_CONFIG_PATH: '${RTSM_FLEET_PATH}',
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
    // SINGLE-STORE: coach_api pg only (via `databases`). Mongo is RETIRED — coach's
    // curriculum read path is Postgres now (PostgresContentReadStore over
    // content_release), coach-api carries no mongo dependency and reads no MONGO_*
    // env, so the mesh mongo is NOT gated on and those vars are not injected.
    // RABBITMQ_ENABLED=false, so rabbitmq is intentionally NOT gated on either.
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        NODE_ENV: 'development',
        EXPRESS_SERVER_PORT: '${COACH_API_PORT}',
        DATABASE_URL: '${COACH_DB_URL}',
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
    // Client-only SPA (ssr = false): the BROWSER calls coach-api for data and
    // iam's auth.whoami direct for identity — so it needs both URLs, and iam
    // must allow its origin (see iam-api's CORS_ORIGIN).
    dependsOn: ['coach-api', 'iam-api'],
    depKinds: { 'coach-api': 'browser', 'iam-api': 'browser' },
    mesh: [],
    launch: {
      cmd: 'pnpm dev',
      env: {
        PUBLIC_COACH_API_URL: '${COACH_API_URL}',
        // Without this, coach-web falls back to its .env default
        // (https://iam.wootdev.com) and the local SPA talks to deployed iam.
        PUBLIC_IAM_API_URL: '${IAM_URL}',
      },
    },
    seed: [],
    lane: lanes(8800, 'coach-web'),
    tunnelSlug: 'coach-web',
    isFrontend: true,
    optional: false,
    // soa#336 (the saga-dash soa#328 idiom): coach-web's PUBLIC_* vars are
    // SvelteKit `$env/static/public` — INLINED into the bundle at vite-dev
    // start with launch env > .env.local > .env precedence (coach-web-env.ts,
    // soa#298). An adopted vite therefore serves the hosts baked in at ITS
    // start forever; no post-hoc .env.local write can win. That is exactly the
    // 2026-07-16 slot-0 incident: a plain `develop coach` adopted a leftover
    // `--tunnel` coach-web and the browser whoami dialed the dead tunnel iam →
    // the misleading soa#300 "503 — Unable to reach the sign-in service".
    // Fingerprint the four browser-plane keys tunnelOverlay() rewrites:
    //  - PUBLIC_COACH_API_URL / PUBLIC_IAM_API_URL (boot-critical): in the
    //    plain launch env above AND value-flipped under --tunnel ⇒ the
    //    fingerprints differ in both directions.
    //  - PUBLIC_LOGIN_URL / PUBLIC_DASHBOARD_URL: tunnel-ONLY (no plain-env
    //    entry — plain runs let them fall through to coach-web's dotfiles).
    //    The fingerprint OMITS absent keys, so plain stamps lack them while
    //    tunnel stamps carry them — present-vs-omitted still mismatches BOTH
    //    ways, the same asymmetry saga-dash's guard relies on.
    // A mode-drifted coach-web is REFUSED loudly and relaunched with the
    // current mode's env — refuse-or-relaunch, never adopt.
    adoptEnv: [
      'PUBLIC_COACH_API_URL',
      'PUBLIC_IAM_API_URL',
      'PUBLIC_LOGIN_URL',
      'PUBLIC_DASHBOARD_URL',
    ],
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
  'authz-sync': {
    id: 'authz-sync',
    repo: 'ROSTERING',
    subpath: 'apps/node/authz-sync',
    // NOT 3110 — that collides mod 1000 with rtsm-api's 6110 (6110 = 3110 + 3000),
    // which the M7 slot-offset scheme (offset = slot*1000) turns into a real port
    // collision at slot 3 (and every 3 slots after). 3111 is clear of every other
    // manifest port's `% 1000` value across slots 0..8 (derive-instance's
    // no-collision property test enumerates this).
    port: 3111,
    portEnvVar: 'PORT',
    healthPath: '/health',
    // `openfga` here (not just authz_sync_local) is deliberate: it's the ONLY
    // service that owns it, so `isPlaybackDb`/`isAuthzDb` (core/snapshot/plan.ts)
    // and the `!def.meshProvisioned` reset gate (runtime/reset.ts) correctly treat
    // the store as authz-opt-in too — it has no app schema of its own to migrate
    // (owned by the openfga_migrate compose sidecar), so it rides along on
    // authz-sync's ownership rather than needing its own ServiceDef.
    databases: ['authz_sync_local', 'openfga'],
    // Consumer-only (RabbitMQ iam.* events), not a url dependency — same shape as
    // sessions-api's async projection deps. iam-api itself has no hard dependency
    // ON authz-sync (nothing calls it); this edge only orders launch (mesh/DB
    // prep before the consumer starts) and would otherwise be unreachable from
    // iam-api's own dependsOn (authz-sync has none).
    dependsOn: [],
    depKinds: {},
    // openfga comes up ONLY when this optional service is in the closure (--with
    // authz) — mesh is a union over the closure's services (closure.ts), so
    // iam-api's own (unconditional) mesh membership need not list it: mesh units
    // start before any service launches regardless of which service pulled them in.
    mesh: ['postgres', 'rabbitmq', 'openfga'],
    launch: {
      cmd: 'pnpm dev',
      env: {
        PORT: '${AUTHZ_SYNC_PORT}',
        RABBITMQ_URL: '${MESH_MQ}',
        DATABASE_URL: '${AUTHZ_SYNC_DB_URL}',
        OPENFGA_API_URL: '${OPENFGA_API_URL}',
        OPENFGA_STORE_ID: '${OPENFGA_STORE_ID}',
      },
    },
    seed: [],
    lane: lanes(3111, 'authz-sync'),
    tunnelSlug: 'authz-sync',
    isFrontend: false,
    optional: true,
  },
};
