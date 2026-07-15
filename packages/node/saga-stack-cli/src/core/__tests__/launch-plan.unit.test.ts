/**
 * launch-plan unit tests (plan §6.3 / §7.2 "M4 — Native partial-stack").
 *
 * THE ENV WALL AUDIT, in code. Runs against the REAL frozen manifest +
 * `defaultLaunchContext` (the up.sh ~182-299 defaults, as pure data) and asserts
 * each service's resolved launch env equals — byte-for-byte — what up.sh's
 * `services_up` `launch_if <svc>` line (~1373-1553) passes that service. A
 * faithful diff here is the contract the native partial-stack launcher relies
 * on.
 *
 * PURE: no docker/pnpm/network — `defaultLaunchContext` takes fake repo roots.
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../closure.js';
import { defaultLaunchContext, launchPlan, resolveLaunchEnv } from '../launch-plan.js';
import type { LaunchContext } from '../launch-plan.js';
import { manifest } from '../manifest/index.js';
import type { RepoKey, ServiceId } from '../manifest/index.js';

const REPO_ROOTS: Record<RepoKey, string> = {
  SOA: '/w/soa',
  ROSTERING: '/w/rostering',
  PROGRAM_HUB: '/w/program-hub',
  SAGA_DASH: '/w/saga-dash',
  COACH: '/w/coach',
  SDS: '/w/student-data-system',
  QBOARD: '/w/qboard',
  RTSM: '/w/rtsm',
  FLEEK: '/w/fleek',
};

const ctx: LaunchContext = defaultLaunchContext({
  repoRoots: REPO_ROOTS,
  vendorDir: '/w/vendor',
});

// up.sh `export`s these globally in services_up (~1384-1385) so EVERY launched
// child inherits them. They are not on any `launch_if` line, so the per-service
// fidelity tests below assert the launch_if-line vars only — we strip the two
// globals here and cover them separately in the "global PINO logger env" block.
const GLOBAL_KEYS = ['PINO_LOGGER_LEVEL', 'PINO_LOGGER_ISEXPRESSCONTEXT'] as const;
const rawEnv = (id: ServiceId) => resolveLaunchEnv(id, 'stack', ctx);
const env = (id: ServiceId) => {
  const e = { ...rawEnv(id) };
  for (const k of GLOBAL_KEYS) delete e[k];
  return e;
};

describe('global PINO logger env (up.sh services_up export ~1384-1385)', () => {
  // soa-logger/soa-config validate these at startup with NO defaults, so every
  // node service crashes on boot without them — required on EVERY launched child.
  it.each(['iam-api', 'programs-api', 'sessions-api', 'ads-adm-api', 'connect-api'] as const)(
    'is injected for %s',
    (id) => {
      const e = rawEnv(id);
      expect(e.PINO_LOGGER_LEVEL).toBe('info');
      expect(e.PINO_LOGGER_ISEXPRESSCONTEXT).toBe('true');
    },
  );

  it('an ambient override flows through defaultLaunchContext', () => {
    const overridden = defaultLaunchContext({
      repoRoots: REPO_ROOTS,
      vendorDir: '/w/vendor',
      pinoLevel: 'debug',
      pinoIsExpressContext: 'false',
    });
    const e = resolveLaunchEnv('iam-api', 'stack', overridden);
    expect(e.PINO_LOGGER_LEVEL).toBe('debug');
    expect(e.PINO_LOGGER_ISEXPRESSCONTEXT).toBe('false');
  });
});

describe('resolveLaunchEnv — faithful to up.sh services_up (stack lane)', () => {
  it('iam-api', () => {
    expect(env('iam-api')).toEqual({
      PORT: '3010',
      AUTH_DEVUSERID: 'f0000004-0000-4000-8000-00000000beef',
      // coach-web (:8800) is in the allowlist because its browser calls
      // auth.whoami direct; omit it and every coach page 503s on CORS.
      CORS_ORIGIN: 'http://localhost:8900,http://localhost:6210,http://localhost:8800',
      // Stamped into the tokens coach-api validates (its AUTH_ISSUER) — one
      // token feeds both ends so the `iss` claim cannot drift.
      JWT_ISSUER: 'https://iam.wootdev.com',
      MAIL_FRONTEND_BASE_URL: 'http://localhost:3010/demo',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379', // slot 0 base — offset-aware (:7379 at slot 1), see launch-plan.slot test
      // Slot-pinned DB URLs (gh_214 acceptance find): without these the SERVER inherits
      // $ROSTERING/.env's literal :5432 and dials slot 0's postgres at slot > 0 while
      // migrate/seed (slot-correct seedEnv) hit the slot mesh. At slot 0 these expand
      // to the same literals .env baked, so byte-identity with up.sh holds.
      DATABASE_URL: 'postgresql://iam:iam@localhost:5432/iam_local',
      PII_DATABASE_URL: 'postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local',
      // Slot-pinned broker URL (same find): iam's OutboxRelay otherwise inherits
      // $ROSTERING/.env.local's literal :5672 and publishes iam.* to slot 0's rabbit.
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      JANUS_REQUIRED: 'false', // main up.sh:1467 — without it iam 401s every local S2S/devLogin
      SECURITY_RATELIMITMAXREQUESTS: '1000000', // apply_fixes (up.sh:457) — no local rate-limit
      JWT_ACCESSTOKENTTLSECONDS: '28800', // apply_fixes (up.sh:465) — 8h TTL for long dev/e2e sessions
      // authz bundle (opt-in, --with authz): always present on iam-api's launch
      // env, but FGA_ENABLED only flips 'true' when the bundle is selected —
      // absent selection here, so fail-closed defaults.
      FGA_ENABLED: 'false',
      FGA_API_URL: 'http://localhost:8080',
      FGA_STORE_ID: '',
    });
  });

  it('sis-api', () => {
    expect(env('sis-api')).toEqual({
      NODE_ENV: 'development',
      PORT: '3100',
      SIS_DATABASE_URL: 'postgresql://sis:sis@localhost:5432/sis_db',
      CORS_ORIGIN: 'http://localhost:8900',
      IAM_BASEURL: 'http://localhost:3010/trpc',
      IAM_TOKENURL: 'http://localhost:3010/v1/oauth/token',
    });
  });

  it('programs-api', () => {
    expect(env('programs-api')).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/programs',
      IAM_API_URL: 'http://localhost:3010',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      JANUS_REQUIRED: 'false',
      CORS_ORIGIN: 'http://localhost:8900',
      JANUS_LOGIN_HOST: 'localhost:3010/demo',
      JWT_ISSUER: 'https://iam.wootdev.com',
    });
  });

  it('scheduling-api', () => {
    expect(env('scheduling-api')).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/scheduling',
      IAM_API_URL: 'http://localhost:3010',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      JANUS_REQUIRED: 'false',
      CORS_ORIGIN: 'http://localhost:8900',
      JANUS_LOGIN_HOST: 'localhost:3010/demo',
      JWT_ISSUER: 'https://iam.wootdev.com',
    });
  });

  it('sessions-api', () => {
    expect(env('sessions-api')).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/sessions',
      IAM_API_URL: 'http://localhost:3010',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      CORS_ORIGIN: 'http://localhost:8900',
      JWT_ISSUER: 'https://iam.wootdev.com',
    });
  });

  it('content-api (:3009)', () => {
    expect(env('content-api')).toEqual({
      NODE_ENV: 'development',
      PORT: '3009',
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/content',
      IAM_API_URL: 'http://localhost:3010',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      CORS_ORIGIN: 'http://localhost:8900',
      JWT_ISSUER: 'https://iam.wootdev.com',
    });
  });

  it('ads-adm-api (tokenized env resolves to exactly up.sh literals at base ports)', () => {
    expect(env('ads-adm-api')).toEqual({
      ADS_ADM_SCHEDULE_PROVIDER: 'program-hub',
      SESSIONS_API_CLIENT_BASEURL: 'http://localhost:3007',
      IAM_API_CLIENT_BASEURL: 'http://localhost:3010/trpc',
      IAM_API_URL: 'http://localhost:3010',
      JWT_ISSUER: 'https://iam.wootdev.com',
      SERVICE_TOKEN_SERVICESLUG: 'ads-adm-api',
      ADS_ADM_DATABASE_URL: 'postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local',
      DATABASE_URL: 'postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local',
      CORS_ORIGIN: 'http://localhost:8900',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
    });
  });

  it('saga-dash', () => {
    expect(env('saga-dash')).toEqual({
      VITE_ADS_ADM_REAL: 'true',
      VITE_SESSION_MEASURED: 'true',
      VITE_ENABLE_OVERRIDES: 'true',
    });
  });

  it('connect-api (incl. RABBITMQ_URL — main up.sh:1614)', () => {
    const resolved = env('connect-api');
    expect(resolved).toEqual({
      NODE_ENV: 'development',
      PORT: '6106',
      MONGO_URI: 'mongodb://localhost:27037/connectv3',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      AUTH_ENABLED: 'true',
      JANUS_REQUIRED: 'false',
      IAM_API_URL: 'http://localhost:3010',
      JWT_ISSUER: 'https://iam.wootdev.com',
      // #222 port: dash joins the CORS allowlist; rtsm wired for private-convos.
      ALLOWED_ORIGINS: 'http://localhost:6210,http://localhost:8900',
      SESSIONS_API_BASE_URL: 'http://localhost:3007',
      SAGA_API_TARGET: 'https://wootmath.com',
      CONTENT_API_URL: 'http://localhost:3009',
      PUBLIC_API_URL: 'http://localhost:6106',
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'devsecret',
      RECORDING_SERVICE_TOKEN: 'local-dev-token',
      RECORDER_URL_TEMPLATE: 'http://127.0.0.1:7890',
      RTSM_API_URL: 'http://localhost:6110',
      FLEEK_TOPOLOGY_JSON:
        '{"cityMap":{"_default":"ws://localhost:7880"},"nodes":{"local":{"url":"ws://localhost:7880"}}}',
    });
  });

  it('connect-web', () => {
    expect(env('connect-web')).toEqual({
      VITE_CONNECTV3_API_URL: 'http://localhost:6106',
      VITE_IAM_API_URL: 'http://localhost:3010',
      VITE_SAGA_API_TARGET: 'https://wootmath.com',
      VITE_RTSM_BOOTSTRAP_URL: 'http://localhost:6110',
      VITE_DASHBOARD_URL: 'http://localhost:8900',
      VITE_JANUS_LOGIN_HOST: 'http://localhost:3010/demo',
      VITE_PLAYBACK_ASSET_BASE_OVERRIDE: 'http://localhost:8444',
    });
  });

  it('rtsm-api (FLEET_CONFIG_PATH resolved to the VENDORED rtsm-fleet-local.json)', () => {
    expect(env('rtsm-api')).toEqual({
      EXPRESS_SERVER_PORT: '6110',
      FLEET_CONFIG_PATH: '/w/vendor/rtsm-fleet-local.json',
      FLEET_NODE_NAME: 'local',
    });
  });

  it('transcripts-api (playback, app-role POSTGRES_* — literal, matching up.sh)', () => {
    expect(env('transcripts-api')).toEqual({
      NODE_ENV: 'development',
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5432',
      POSTGRES_DATABASE: 'transcripts_local',
      POSTGRES_USERNAME: 'transcripts_app',
      POSTGRES_PASSWORD: 'transcripts_app_local_pw',
      POSTGRES_INSTANCENAME: 'TranscriptsDB',
      EXPRESS_SERVER_PORT: '6302',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      AUTH_AUTHENABLED: 'false',
      JANUS_REQUIRED: 'false',
    });
  });

  // SINGLE-store: mongo is retired (curriculum reads come from Postgres
  // content_release), so NO MONGO_HOST/MONGO_PORT/MONGO_DATABASE/CONTENT_DATABASE.
  it('coach-api (single-store: coach_api pg; iss=iam.wootdev.com — what local iam mints)', () => {
    expect(env('coach-api')).toEqual({
      NODE_ENV: 'development',
      EXPRESS_SERVER_PORT: '6105',
      DATABASE_URL: 'postgresql://coach_api_app:dev-password-coach-api-app@localhost:5432/coach_api',
      AUTH_AUTHENABLED: 'true',
      IAM_API_TARGET: 'http://localhost:3010',
      AUTH_JWKSURL: 'http://localhost:3010/.well-known/jwks.json',
      AUTH_ISSUER: 'https://iam.wootdev.com',
      RABBITMQ_ENABLED: 'false',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      EXPRESS_SERVER_CORSALLOWEDDOMAINS: 'localhost',
      SAGA_API_TARGET: 'https://staging.wootmath.com',
    });
  });

  it('coach-web (client-only SPA: browser calls coach-api AND iam direct)', () => {
    expect(env('coach-web')).toEqual({
      PUBLIC_COACH_API_URL: 'http://localhost:6105',
      // Without this it falls back to its .env default (https://iam.wootdev.com)
      // and the local SPA talks to DEPLOYED iam.
      PUBLIC_IAM_API_URL: 'http://localhost:3010',
    });
  });

  it('throws on an unset token (drift guard)', () => {
    const broken: LaunchContext = {
      ...ctx,
      tokens: { ...ctx.tokens, IAM_URL: undefined as unknown as string },
    };
    expect(() => resolveLaunchEnv('programs-api', 'stack', broken)).toThrow(/IAM_URL/);
  });
});

describe('launchPlan — ordered native specs for a closure', () => {
  const closure = computeClosure(manifest, ['sessions-api']);
  const plan = launchPlan(manifest, closure.services, 'stack', ctx);

  it('orders the closure by launchOrder (deps first)', () => {
    expect(plan.map((s) => s.id)).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
  });

  it('resolves cwd from repoRoots + subpath', () => {
    const programs = plan.find((s) => s.id === 'programs-api')!;
    expect(programs.cwd).toBe('/w/program-hub/apps/node/programs-api');
    expect(programs.command).toBe('pnpm dev');
  });

  it('builds the stack-lane health URL from the resolved port + healthPath', () => {
    const iam = plan.find((s) => s.id === 'iam-api')!;
    expect(iam.healthUrl).toBe('http://localhost:3010/health');
    expect(iam.healthPath).toBe('/health');
  });

  it('honours a check_ports port remap in the health URL', () => {
    const remapped = defaultLaunchContext({
      repoRoots: REPO_ROOTS,
      vendorDir: '/w/vendor',
      portOverrides: { 'sessions-api': 13007 },
    });
    const p = launchPlan(manifest, ['sessions-api'], 'stack', remapped);
    expect(p.find((s) => s.id === 'sessions-api')!.healthUrl).toBe('http://localhost:13007/health');
  });
});
