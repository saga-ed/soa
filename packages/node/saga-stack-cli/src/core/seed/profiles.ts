/**
 * Seed profiles + the canonical SeedStep registry (plan §4.1, saga-ed/soa#214).
 *
 * Sourced from up.sh's `seed_*` family (`~1610-1714`):
 *   seed_iam / seed_sessions / seed_programs / seed_content / seed_playback /
 *   seed_qtf_demo, plus the dev-user re-seed (`node dist/seed-dev-user.js`).
 *
 * Connection data (DATABASE_URL, the POSTGRES_* set) is DERIVED from the
 * manifest's `DatabaseDef` (owner role/pw + db name) — NOT hardcoded — per the
 * review minor that collapsed the triplicated `MESH_DATABASES`. This module is
 * PURE (types + frozen data + a registry builder; zero IO).
 */

import { getDb, getService, manifest } from '../manifest/index.js';
import type { DatabaseDef, DbId, Manifest, ServiceId } from '../manifest/index.js';
import type { SeedAddOn, SeedEnv, SeedProfile, SeedStep } from './types.js';

/** The canonical seed-step ids (superset of `SeedStepRef` — incl. `scheduling`/`coach-pg`). */
export type SeedStepId =
  | 'iam-dev-user'
  | 'iam'
  | 'sessions'
  | 'qtf-demo'
  | 'programs'
  | 'scheduling'
  | 'content'
  | 'coach-pg'
  | 'transcripts'
  | 'insights'
  | 'chat';

/** Profile → the seed-step ids it contributes (plan §4.1). */
export const PROFILE_STEPS: Readonly<Record<SeedProfile, readonly SeedStepId[]>> = {
  roster: ['iam-dev-user', 'iam', 'sessions'],
  full: ['iam-dev-user', 'iam', 'sessions', 'programs', 'scheduling', 'content', 'coach-pg'],
};

/** Add-on → the seed-step ids it contributes (plan §4.1). */
export const ADDON_STEPS: Readonly<Record<SeedAddOn, readonly SeedStepId[]>> = {
  playback: ['transcripts', 'insights', 'chat'],
  qtf: ['qtf-demo'],
};

/**
 * Canonical seed run order (plan §4.1):
 *   iam-dev-user → iam → sessions → qtf → programs → scheduling → content →
 *   coach-pg → playback.
 * `composeSeedPlan` walks this order so the emitted plan is deterministic.
 */
export const SEED_RUN_ORDER: readonly SeedStepId[] = [
  'iam-dev-user',
  'iam',
  'sessions',
  'qtf-demo',
  'programs',
  'scheduling',
  'content',
  'coach-pg',
  'transcripts',
  'insights',
  'chat',
];

// ── connection derivation (from the manifest's DatabaseDef) ──────────────────

/** The mesh postgres address (single shared instance — up.sh PROGRAMS_DB_URL et al.). */
const MESH_PG_HOST = 'localhost';
const MESH_PG_PORT = 5432;

/** `postgresql://<owner>:<pw>@localhost:5432/<dbname>` — derived from DatabaseDef. */
function pgUrl(db: DatabaseDef): string {
  return `postgresql://${db.ownerRole}:${db.ownerPw}@${MESH_PG_HOST}:${MESH_PG_PORT}/${db.name}`;
}

/** Single inline `DATABASE_URL` override (programs/sessions/content/qtf). */
function inlineDatabaseUrl(db: DatabaseDef): SeedEnv {
  return { kind: 'inline', vars: { DATABASE_URL: pgUrl(db) } };
}

/** The multi-var `POSTGRES_*` set the playback apps read (host/port/db/user/pw/instance). */
function postgresVarSet(db: DatabaseDef, instanceName: string): SeedEnv {
  return {
    kind: 'inline-multi',
    vars: {
      POSTGRES_HOST: MESH_PG_HOST,
      POSTGRES_PORT: String(MESH_PG_PORT),
      POSTGRES_DATABASE: db.name,
      POSTGRES_USERNAME: db.ownerRole,
      POSTGRES_PASSWORD: db.ownerPw,
      POSTGRES_INSTANCENAME: instanceName,
    },
  };
}

/**
 * The FIXED synthetic-dev PII crypto keys up.sh writes into `$ROSTERING/.env.local`
 * (apply_fixes template, up.sh ~L405-406). The iam seeds REQUIRE these: both
 * `seed-dev-user.js` and iam's `db:seed` read `PII_CRYPTO_PIIDEKHEX` /
 * `PII_CRYPTO_PIIHMACKEYHEX` off `process.env` and THROW when absent. Deterministic
 * dev fixtures, NOT real secrets — safe as frozen core data (keeps this pure, no
 * dotenv IO). (`PII_CRYPTO_PIIDEKVERSION` is injected for completeness but is not
 * read by the seeds.)
 */
const IAM_PII_CRYPTO: Readonly<Record<string, string>> = {
  PII_CRYPTO_PIIDEKHEX: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PII_CRYPTO_PIIHMACKEYHEX: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  PII_CRYPTO_PIIDEKVERSION: '1',
};

/**
 * Env for the iam seeds (dev-user bootstrap + roster db:seed). Mirrors the vars
 * up.sh sources from `.env.local` for `cd iam-db && env $(...) node
 * dist/seed-dev-user.js` / `pnpm db:seed`: DATABASE_URL + PII_DATABASE_URL derived
 * from the manifest iam DBs, plus the fixed PII crypto keys. `inline-multi` ⇒ the
 * runtime spawns the child with exactly these layered over process.env — no dotenv.
 */
function iamSeedEnv(m: Manifest): SeedEnv {
  return {
    kind: 'inline-multi',
    vars: {
      DATABASE_URL: pgUrl(getDb('iam_local', m)),
      PII_DATABASE_URL: pgUrl(getDb('iam_pii_local', m)),
      ...IAM_PII_CRYPTO,
    },
  };
}

/** A playback seed step (transcripts/insights/chat) — all share the same shape. */
function playbackStep(m: Manifest, id: SeedStepId, service: ServiceId, dbId: DbId): SeedStep {
  const db = getDb(dbId, m);
  // POSTGRES_INSTANCENAME is service config, not connection data — read it off the
  // service's launch env (TranscriptsDB / InsightsDB / ChatDB) rather than hardcode.
  const instanceName = getService(service, m).launch.env.POSTGRES_INSTANCENAME ?? '';
  return {
    id,
    service,
    databases: [dbId],
    cwd: getService(service, m).subpath,
    command: ['pnpm', 'seed'],
    env: postgresVarSet(db, instanceName),
    requiresServiceUp: [], // pure db fixtures (db:seed-equivalent) — offline
    failureMode: 'fatal',
  };
}

/**
 * Build the canonical SeedStep registry, deriving all connection data from the
 * given manifest. Exported (vs. a frozen const) so tests can feed a hand-built
 * `Manifest` fixture; `SEED_STEPS` below is the default built from the real one.
 */
export function buildSeedRegistry(m: Manifest = manifest): Record<SeedStepId, SeedStep> {
  return {
    // dev-user bootstrap (auth user dev@example.org / DEV_USER_UUID f0000004-…beef).
    // Runs `node dist/seed-dev-user.js` from the iam-db package with the repo dotenv
    // loaded (PII keys), matching up.sh's reset re-seed + prep bootstrap.
    'iam-dev-user': {
      id: 'iam-dev-user',
      service: 'iam-api',
      databases: ['iam_local', 'iam_pii_local'],
      cwd: 'packages/node/iam-db',
      command: ['node', 'dist/seed-dev-user.js'],
      env: iamSeedEnv(m),
      requiresServiceUp: [],
      // Best-effort, matching up.sh: BOTH invocations tolerate failure — prep
      // bootstrap (up.sh:1030) and reset re-seed (up.sh:1596) run it as
      // `… node dist/seed-dev-user.js … || true`. It refuses to run until the iam
      // registry is seeded (needs `seed:registry` — which up.sh never runs), and
      // the canonical `dev@saga.org` user comes from `db:seed` (the `iam` step)
      // anyway. So a failure here must NOT abort the bring-up (the soak's
      // "registry is missing required session permissions" abort).
      failureMode: 'warn',
    },
    // iam roster — db:seed deterministic ids, direct DB. Needs the repo dotenv for
    // DATABASE_URL/PII_DATABASE_URL + PII_DEK/HMAC (else names write blank).
    iam: {
      id: 'iam',
      service: 'iam-api',
      databases: ['iam_local', 'iam_pii_local'],
      cwd: 'packages/node/iam-db',
      command: ['pnpm', 'db:seed'],
      env: iamSeedEnv(m),
      requiresServiceUp: [],
      failureMode: 'fatal',
    },
    // sessions-api Connect-demo direct-projection seed (+ projection_readiness row).
    sessions: {
      id: 'sessions',
      service: 'sessions-api',
      databases: ['sessions'],
      cwd: getService('sessions-api', m).subpath,
      command: ['pnpm', 'db:seed'],
      env: inlineDatabaseUrl(getDb('sessions', m)),
      requiresServiceUp: [],
      failureMode: 'fatal',
    },
    // QTF + observation-notes demo on an Ended session. Add-on, online: only
    // meaningful once the stack has produced an Ended demo session (plan §4.1).
    'qtf-demo': {
      id: 'qtf-demo',
      service: 'sessions-api',
      databases: ['sessions'],
      cwd: getService('sessions-api', m).subpath,
      command: ['pnpm', 'db:seed:qtf-demo'],
      env: inlineDatabaseUrl(getDb('sessions', m)),
      requiresServiceUp: ['sessions-api'],
      // up.sh runs this best-effort (`|| true`, warns when no Ended session yet).
      failureMode: 'warn',
    },
    // programs/periods/enrollment — db:seed deterministic offline derived ids.
    // DATABASE_URL forced to mesh :5432 (program-hub apps default :5433).
    programs: {
      id: 'programs',
      service: 'programs-api',
      databases: ['programs'],
      cwd: getService('programs-api', m).subpath,
      command: ['pnpm', 'db:seed'],
      env: inlineDatabaseUrl(getDb('programs', m)),
      requiresServiceUp: [],
      failureMode: 'fatal',
    },
    // scheduling deterministic demo schedules/slots (db:seed, direct). main's
    // seed_stack full runs seed_scheduling between programs and content (up.sh:1914,
    // fatal — no `|| true`); added on main after gh_214 branched. Without it a native
    // `--seed full` leaves scheduling unseeded → the Schedule step renders nothing.
    scheduling: {
      id: 'scheduling',
      service: 'scheduling-api',
      databases: ['scheduling'],
      cwd: getService('scheduling-api', m).subpath,
      command: ['pnpm', 'db:seed'],
      env: inlineDatabaseUrl(getDb('scheduling', m)),
      requiresServiceUp: [],
      failureMode: 'fatal',
    },
    // content catalog (db:seed) + self-guarding HTTP tail (demo-polls / legacy-poll).
    // The HTTP tail needs content-api up ⇒ the whole step is online; the catalog
    // db:seed is itself best-effort in up.sh (warns on failure).
    content: {
      id: 'content',
      service: 'content-api',
      databases: ['content'],
      cwd: getService('content-api', m).subpath,
      command: ['pnpm', 'db:seed'],
      env: inlineDatabaseUrl(getDb('content', m)),
      requiresServiceUp: ['content-api'],
      failureMode: 'warn',
      optionalSteps: [
        {
          // seed-demo-polls.mjs (HTTP authoring against content-api :3009).
          // TODO(M3/M4): cwd here is the synthetic-dev tool dir ($SCRIPT_DIR), not a
          // repo subpath — the runtime adapter resolves the shipped script location.
          id: 'demo-polls',
          service: 'content-api',
          databases: ['content'],
          cwd: 'tools/synthetic-dev',
          command: ['node', 'seed-demo-polls.mjs'],
          env: { kind: 'inline', vars: { CONTENT_API: '${CONTENT_API_URL}' } },
          requiresServiceUp: ['content-api'],
          failureMode: 'warn',
        },
        {
          // legacy→content migration — only present on an unmerged program-hub branch.
          id: 'legacy-poll',
          service: 'content-api',
          databases: ['content'],
          cwd: getService('content-api', m).subpath,
          command: [
            'pnpm',
            'exec',
            'tsx',
            'tools/legacy-poll-migrate/migrate.ts',
            '--fixture',
            'bwo8my5mgprq9ran',
            '--target',
            '${CONTENT_API_URL}',
          ],
          env: inlineDatabaseUrl(getDb('content', m)),
          requiresServiceUp: ['content-api'],
          failureMode: 'warn',
        },
      ],
    },
    // coach progress store (Postgres) — coach-db `db:seed` (coach#155 local-snapshot),
    // DATABASE_URL forced to the mesh :5432 coach_api (== $COACH_DB_URL; coach-db's own
    // default is :5433). main runs it best-effort in seed_stack full after content
    // (up.sh:1808-1816, `warn` on failure — coach may be absent / coach#155 unmerged).
    //
    // TODO(coach-curriculum): main's seed_coach ALSO mongoimports coach's curriculum
    // fixtures into the mesh mongo (up.sh:1780-1798 seed_coach_mongo_only —
    // `docker exec -i soa-connect-mongo-1 mongoimport … < content_coach.json`). The
    // SeedStep model has no stdin-redirect (`< file`) support, so that step is NOT
    // expressible cleanly and is intentionally OMITTED here rather than hacked in.
    'coach-pg': {
      id: 'coach-pg',
      service: 'coach-api',
      databases: ['coach_api'],
      cwd: 'packages/node/coach-db',
      command: ['pnpm', 'db:seed'],
      env: inlineDatabaseUrl(getDb('coach_api', m)),
      requiresServiceUp: [], // direct pg db:seed — offline
      failureMode: 'warn',
    },
    // playback fixtures (sds_93) — each app's `pnpm seed`, app-role POSTGRES_* inline.
    transcripts: playbackStep(m, 'transcripts', 'transcripts-api', 'transcripts_local'),
    insights: playbackStep(m, 'insights', 'insights-api', 'insights_local'),
    chat: playbackStep(m, 'chat', 'chat-api', 'chat_local'),
  };
}

/** The default registry, built from the real frozen manifest. */
export const SEED_STEPS: Readonly<Record<SeedStepId, SeedStep>> = buildSeedRegistry();
