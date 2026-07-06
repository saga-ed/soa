/**
 * The 14 databases — verified against infra/compose/projects/saga-mesh/seed/
 * profile-empty.sql (owners/roles) and the plan §2.2 "Databases" table.
 *
 * profile-empty.sql provisions 10 app DBs at mesh-up (iam_local, iam_pii_local,
 * programs, scheduling, sessions, content, coach_api, ads_adm_local, ledger_local,
 * sis_db) — it CREATE USER/DATABASE/GRANTs coach_api's role+db too. up.sh's
 * first-postgres-init role+db_step (up.sh:1061-1067) is only a fallback for
 * pre-existing volumes; coach_api is a mesh-provisioned pg app DB. The 3 playback
 * DBs are provisioned by `provision_playback_dbs` (not mesh) and connectv3 is a
 * mongo DB that auto-creates.
 *
 * Migrate order (plan §2.2 blocker fix):
 *   iam-db → iam-pii-db (db push) → programs → scheduling → sessions → content
 *   → coach-db → sis-db → ads-adm-db.
 */

import type { DatabaseDef, DbId } from './types.js';

export const DATABASES: Readonly<Record<DbId, DatabaseDef>> = {
  iam_local: {
    name: 'iam_local',
    engine: 'postgres',
    // BLOCKER-A: iam-db's prisma.config.ts THROWS if DATABASE_URL is unset — on a
    // fresh checkout with no `$ROSTERING/.env.local`, R3 must inject it (up.sh
    // supplies it via ensure_kv into .env.local; native injects into the child env).
    migrate: { dir: 'packages/node/iam-db', cmd: 'prisma migrate deploy', migrateEnvVar: 'DATABASE_URL' },
    ownerRole: 'iam',
    ownerPw: 'iam',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  iam_pii_local: {
    name: 'iam_pii_local',
    engine: 'postgres',
    // Blocker fix: owned by a SEPARATE iam-pii-db package, applied with `prisma db push`
    // (no migration history) as a distinct step in `prep`.
    // BLOCKER-A: iam-pii-db's prisma.config.ts THROWS if PII_DATABASE_URL is unset.
    migrate: { dir: 'packages/node/iam-pii-db', cmd: 'prisma db push', migrateEnvVar: 'PII_DATABASE_URL' },
    ownerRole: 'iam_pii',
    ownerPw: 'iam_pii',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  programs: {
    name: 'programs',
    engine: 'postgres',
    // program-hub apps default to their own :5433; force the mesh :5432 (matches seed_programs).
    migrate: { dir: 'apps/node/programs-api', cmd: 'db:deploy', databaseUrlOverride: true },
    ownerRole: 'saga_user',
    ownerPw: 'password123',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  scheduling: {
    name: 'scheduling',
    engine: 'postgres',
    migrate: { dir: 'apps/node/scheduling-api', cmd: 'db:deploy', databaseUrlOverride: true },
    ownerRole: 'saga_user',
    ownerPw: 'password123',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  sessions: {
    name: 'sessions',
    engine: 'postgres',
    migrate: { dir: 'apps/node/sessions-api', cmd: 'db:deploy', databaseUrlOverride: true },
    ownerRole: 'saga_user',
    ownerPw: 'password123',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  content: {
    name: 'content',
    engine: 'postgres',
    migrate: { dir: 'apps/node/content-api', cmd: 'db:deploy', databaseUrlOverride: true },
    ownerRole: 'saga_user',
    ownerPw: 'password123',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  coach_api: {
    name: 'coach_api',
    engine: 'postgres',
    // coach's prisma schema lives in the coach-db PACKAGE (not the app); migrations
    // under packages/node/coach-db/src/prisma/migrations (up.sh:802). db:deploy with
    // DATABASE_URL forced to the mesh :5432 (coach-db's own default is :5433 —
    // up.sh's migrate_db passes $COACH_DB_URL).
    migrate: { dir: 'packages/node/coach-db', cmd: 'db:deploy', databaseUrlOverride: true },
    ownerRole: 'coach_api_app',
    ownerPw: 'dev-password-coach-api-app',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  sis_db: {
    name: 'sis_db',
    engine: 'postgres',
    // BLOCKER-A: sis-db's prisma.config.ts loads SIS_DATABASE_URL directly (and
    // THROWS if unset); up.sh writes it into `$ROSTERING/.env.local` (up.sh:448) and
    // it equals $SIS_DB_URL = postgresql://sis:sis@localhost:5432/sis_db.
    migrate: { dir: 'packages/node/sis-db', cmd: 'db:deploy', migrateEnvVar: 'SIS_DATABASE_URL' },
    ownerRole: 'sis',
    ownerPw: 'sis',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  ads_adm_local: {
    name: 'ads_adm_local',
    engine: 'postgres',
    // ads-adm-db's prisma.config.ts reads `DATABASE_URL ?? ADS_ADM_DATABASE_URL`
    // (its `import 'dotenv/config'` never overrides a pre-set var), and the
    // package .env bakes the base-port localhost URL. Injecting DATABASE_URL
    // (slot-offset-correct pgUrl) makes a slot > 0 migrate land on the SLOT's
    // mesh pg instead of slot 0's :5432 (ads-adm slottability); at slot 0 the
    // injected URL is byte-identical to the baked .env value.
    migrate: {
      dir: 'packages/node/ads-adm-db',
      cmd: 'prisma migrate deploy',
      migrateEnvVar: 'DATABASE_URL',
    },
    ownerRole: 'ads_adm',
    ownerPw: 'ads_adm',
    resettable: true,
    resetMode: 'truncate',
    meshProvisioned: true,
  },
  ledger_local: {
    name: 'ledger_local',
    engine: 'postgres',
    // Major fix: profile-empty.sql creates a dedicated `ledger` role and
    // `CREATE DATABASE ledger_local OWNER ledger`; snapshot restore connects AS the
    // owner, so ownerRole must be `ledger` (not ads_adm). Reset via migrate-reset
    // (drop + remigrate), NOT TRUNCATE — decision 2026-06-29.
    // VERIFIED 2026-07-01: ledger_local's TRUE schema owner is the dedicated
    // `ledger-db` package (packages/node/ledger-db — its OWN prisma migrations under
    // src/prisma/migrations, `db:deploy: prisma migrate deploy`, prisma.config reads
    // DATABASE_URL), NOT ads-adm-db (which owns a DIFFERENT db, ads_adm_local, with
    // its own db:seed). Pointing migrate here at ads-adm-db would rebuild ledger_local
    // with ads-adm-db's schema + seed on `prisma migrate reset` — corrected below.
    migrate: { dir: 'packages/node/ledger-db', cmd: 'prisma migrate deploy' },
    ownerRole: 'ledger',
    ownerPw: 'ledger',
    resettable: true,
    resetMode: 'migrate-reset',
    meshProvisioned: true,
  },
  transcripts_local: {
    name: 'transcripts_local',
    engine: 'postgres',
    migrate: { dir: 'packages/node/transcripts-db', cmd: 'prisma migrate deploy' },
    ownerRole: 'transcripts_app',
    ownerPw: 'transcripts_app_local_pw',
    resettable: true, // playback
    resetMode: 'truncate',
    meshProvisioned: false, // provisioned by provision_playback_dbs, not mesh
  },
  insights_local: {
    name: 'insights_local',
    engine: 'postgres',
    migrate: { dir: 'packages/node/insights-db', cmd: 'prisma migrate deploy' },
    ownerRole: 'insights_app',
    ownerPw: 'insights_app_local_pw',
    resettable: true, // playback
    resetMode: 'truncate',
    meshProvisioned: false,
  },
  chat_local: {
    name: 'chat_local',
    engine: 'postgres',
    migrate: { dir: 'packages/node/chat-db', cmd: 'prisma migrate deploy' },
    ownerRole: 'chat_app',
    ownerPw: 'chat_app_local_pw',
    resettable: true, // playback
    resetMode: 'truncate',
    meshProvisioned: false,
  },
  connectv3: {
    name: 'connectv3',
    engine: 'mongo',
    migrate: null, // auto-create; no schema
    ownerRole: '',
    ownerPw: '',
    resettable: true, // reset via dropDatabase
    resetMode: 'truncate', // n/a for mongo; reset path uses dropDatabase, not TRUNCATE
    meshProvisioned: false, // n/a (mongo)
  },
};
