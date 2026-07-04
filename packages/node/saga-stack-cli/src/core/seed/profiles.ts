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
  | 'coach-mongo' //           M8 R5: coach curriculum mongoimport (stdinFile)
  | 'transcripts-provision' // M8 R5: playback bootstrap SQL + migrate (--with playback)
  | 'insights-provision'
  | 'chat-provision'
  | 'transcripts'
  | 'insights'
  | 'chat';

/** Profile → the seed-step ids it contributes (plan §4.1). */
export const PROFILE_STEPS: Readonly<Record<SeedProfile, readonly SeedStepId[]>> = {
  roster: ['iam-dev-user', 'iam', 'sessions'],
  // M8 R5: coach-mongo (curriculum) is now expressible (stdinFile) — un-gated so
  // native `--seed full` seeds BOTH coach stores (mongo curriculum + pg progress).
  full: ['iam-dev-user', 'iam', 'sessions', 'programs', 'scheduling', 'content', 'coach-pg', 'coach-mongo'],
};

/** Add-on → the seed-step ids it contributes (plan §4.1). */
export const ADDON_STEPS: Readonly<Record<SeedAddOn, readonly SeedStepId[]>> = {
  // M8 R5: the playback DBs are meshProvisioned:false, so they need their
  // bootstrap SQL + migrate (`*-provision`) BEFORE the fixture seed (`pnpm seed`).
  // Now expressible via stdinFile, so native `--with playback` is un-gated.
  playback: [
    'transcripts-provision',
    'insights-provision',
    'chat-provision',
    'transcripts',
    'insights',
    'chat',
  ],
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
  'coach-mongo',
  // playback provisioning (bootstrap + migrate) precedes the playback fixtures.
  'transcripts-provision',
  'insights-provision',
  'chat-provision',
  'transcripts',
  'insights',
  'chat',
];

// ── connection derivation (from the manifest's DatabaseDef) ──────────────────

/** The mesh postgres address (single shared instance — up.sh PROGRAMS_DB_URL et al.). */
const MESH_PG_HOST = 'localhost';
/**
 * The mesh postgres PORT is emitted as a `${MESH_PG_PORT}` TOKEN, not a literal —
 * this module is PURE (no slot/offset context), so it cannot know the slot's offset
 * port. The facade's seed-env resolver (`stack-api.ts` `seedEnv`) expands the token
 * against the runtime, exactly like `${SAGA_MESH_*_CONTAINER}`: at slot 0 it resolves
 * to `5432` (byte-identical to before), at slot N>0 to `5432 + meshOffset` (:6432 at
 * slot 1). Baking a literal here dialed slot 0's postgres from every slot (the bug).
 */
const MESH_PG_PORT_TOKEN = '${MESH_PG_PORT}';

/**
 * M8 R5 — container-name tokens the runtime resolves per SLOT. The registry is
 * PURE (can't read `process.env`/the slot profile), so a docker-exec seed step
 * (coach curriculum / playback bootstrap) references its target container by
 * token; the facade's seed runner expands it against the RESOLVED slot containers
 * (`soa-s<N>-postgres-1` / `soa-s<N>-connect-mongo-1`), exactly like R2/R3 receive
 * the resolved `pgContainer`. At slot 0 they expand to `soa-postgres-1` /
 * `soa-connect-mongo-1`.
 */
const MONGO_CONTAINER_TOKEN = '${SAGA_MESH_CONNECT_MONGO_CONTAINER}';
const PG_CONTAINER_TOKEN = '${SAGA_MESH_POSTGRES_CONTAINER}';

/** The mesh superuser creds up.sh's playback `*_DB_URL` migrate as (up.sh:235-237). */
function playbackDbUrl(db: DatabaseDef): string {
  return `postgresql://postgres_admin:password123@${MESH_PG_HOST}:${MESH_PG_PORT_TOKEN}/${db.name}`;
}

/**
 * M8 R5 — a playback DB provisioning step (up.sh `provision_playback_dbs`,
 * up.sh:937-951). The `*-db` package's `seed/local-bootstrap.sql` creates the DB +
 * least-privilege app role + grants, piped to the mesh postgres via stdin
 * (`docker exec -i <pg> psql < local-bootstrap.sql`); the tail step then migrates
 * it as MASTER (`postgres_admin`) with `pnpm db:deploy` (a freshly-bootstrapped DB
 * is empty → replays the full migration history). Gated under `--with playback`.
 */
function playbackProvisionStep(m: Manifest, id: SeedStepId, service: ServiceId, dbId: DbId): SeedStep {
  const db = getDb(dbId, m);
  // The bootstrap SQL + the migrations both live in the owning `*-db` package
  // (packages/node/<app>-db) — the manifest already carries that dir.
  const dbDir = db.migrate?.dir ?? getService(service, m).subpath;
  return {
    id,
    service,
    databases: [dbId],
    cwd: dbDir,
    // psql reads the bootstrap SQL from stdin (\gexec + IF NOT EXISTS ⇒ idempotent).
    command: ['docker', 'exec', '-i', PG_CONTAINER_TOKEN, 'psql', '-U', 'postgres_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    stdinFile: 'seed/local-bootstrap.sql',
    env: { kind: 'inline', vars: {} },
    requiresServiceUp: [],
    // Opt-in path — warn (not fatal) so a playback hiccup never reddens the stack;
    // the fixture seed step that follows fails visibly if the DB never came up.
    failureMode: 'warn',
    optionalSteps: [
      {
        id: `${id}-migrate`,
        service,
        databases: [dbId],
        cwd: dbDir,
        command: ['pnpm', 'db:deploy'],
        env: { kind: 'inline', vars: { DATABASE_URL: playbackDbUrl(db) } },
        requiresServiceUp: [],
        failureMode: 'warn',
      },
    ],
  };
}

/** `postgresql://<owner>:<pw>@localhost:${MESH_PG_PORT}/<dbname>` — derived from DatabaseDef; port token resolved per-slot in `seedEnv`. */
function pgUrl(db: DatabaseDef): string {
  return `postgresql://${db.ownerRole}:${db.ownerPw}@${MESH_PG_HOST}:${MESH_PG_PORT_TOKEN}/${db.name}`;
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
      POSTGRES_PORT: MESH_PG_PORT_TOKEN,
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
    // M8 R5: the curriculum mongoimport is now the 'coach-mongo' step below (was
    // OMITTED for lack of stdin redirect; `stdinFile` makes it expressible).
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
    // M8 R5 — coach curriculum mongoimport (up.sh:1780-1798 seed_coach_mongo_only).
    // TWO upserts into the mesh mongo: content_coach.json (single object) →
    // saga_local.content_coach, and content.json (array) → wmlms_local.content —
    // the dbs coach-api's launch_if points at. Curriculum is static committed
    // fixtures, so `--mode upsert` makes re-seeds converge. Reads each file from
    // stdin (`stdinFile`) so no `docker cp` into the container. `--port 27017` is
    // the CONTAINER-internal port (slot-invariant); the container name is the
    // slot-resolved token. Best-effort (coach may be absent).
    'coach-mongo': {
      id: 'coach-mongo',
      service: 'coach-api',
      databases: [], // mongo curriculum (saga_local/wmlms_local) — not a tracked DbId; always seeds
      cwd: 'apps/node/coach-api',
      command: [
        'docker', 'exec', '-i', MONGO_CONTAINER_TOKEN,
        'mongoimport', '--quiet', '--port', '27017',
        '-d', 'saga_local', '-c', 'content_coach', '--mode', 'upsert', '--upsertFields', 'name',
      ],
      stdinFile: 'scripts/data/content_coach.json',
      env: { kind: 'inline', vars: {} },
      requiresServiceUp: [],
      failureMode: 'warn',
      optionalSteps: [
        {
          id: 'coach-mongo-content',
          service: 'coach-api',
          databases: [],
          cwd: 'apps/node/coach-api',
          command: [
            'docker', 'exec', '-i', MONGO_CONTAINER_TOKEN,
            'mongoimport', '--quiet', '--port', '27017',
            '-d', 'wmlms_local', '-c', 'content', '--jsonArray', '--mode', 'upsert', '--upsertFields', 'id',
          ],
          stdinFile: 'scripts/data/content.json',
          env: { kind: 'inline', vars: {} },
          requiresServiceUp: [],
          failureMode: 'warn',
        },
      ],
    },
    // M8 R5 — playback DB provisioning (bootstrap SQL + migrate; up.sh:937-951),
    // gated under `--with playback`. Precede the fixture seed steps below.
    'transcripts-provision': playbackProvisionStep(m, 'transcripts-provision', 'transcripts-api', 'transcripts_local'),
    'insights-provision': playbackProvisionStep(m, 'insights-provision', 'insights-api', 'insights_local'),
    'chat-provision': playbackProvisionStep(m, 'chat-provision', 'chat-api', 'chat_local'),
    // playback fixtures (sds_93) — each app's `pnpm seed`, app-role POSTGRES_* inline.
    transcripts: playbackStep(m, 'transcripts', 'transcripts-api', 'transcripts_local'),
    insights: playbackStep(m, 'insights', 'insights-api', 'insights_local'),
    chat: playbackStep(m, 'chat', 'chat-api', 'chat_local'),
  };
}

/** The default registry, built from the real frozen manifest. */
export const SEED_STEPS: Readonly<Record<SeedStepId, SeedStep>> = buildSeedRegistry();
