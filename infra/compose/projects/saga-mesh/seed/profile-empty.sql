-- saga-mesh / profile=empty
--
-- Creates the per-app databases and owners for the SDS fixture mesh.
-- No application data is seeded here — each app runs its own prisma
-- migrations into its database after this file executes.
--
-- Context: POSTGRES_HOST_AUTH_METHOD=trust in soa/infra dev, so passwords
-- exist for completeness but aren't enforced. Role ownership still matters
-- because prisma uses it for `CREATE SCHEMA` and similar DDL.
--
-- Tracking: saga-ed/student-data-system#80 Phase 2 D2.2.

-- ── Users (owners) ──────────────────────────────────────────────────
CREATE USER iam            WITH PASSWORD 'iam';
CREATE USER iam_pii        WITH PASSWORD 'iam_pii';
CREATE USER saga_user      WITH PASSWORD 'password123';
CREATE USER ads_adm        WITH PASSWORD 'ads_adm';
CREATE USER ledger         WITH PASSWORD 'ledger';
CREATE USER sis            WITH PASSWORD 'sis';
CREATE USER coach_api_app  WITH PASSWORD 'dev-password-coach-api-app';
CREATE USER authz_sync     WITH PASSWORD 'authz_sync';
CREATE USER authz_api      WITH PASSWORD 'authz_api';

-- ── Databases ───────────────────────────────────────────────────────
-- Owner set at creation time so prisma migrate deploy can CREATE SCHEMA.
CREATE DATABASE iam_local       OWNER iam;
CREATE DATABASE iam_pii_local   OWNER iam_pii;
CREATE DATABASE programs        OWNER saga_user;
CREATE DATABASE scheduling      OWNER saga_user;
CREATE DATABASE sessions        OWNER saga_user;
CREATE DATABASE content         OWNER saga_user;
CREATE DATABASE ads_adm_local   OWNER ads_adm;
CREATE DATABASE ledger_local    OWNER ledger;
CREATE DATABASE sis_db          OWNER sis;
CREATE DATABASE coach_api       OWNER coach_api_app;

-- Opt-in (rostering `authz` bundle, `--with authz`): created unconditionally
-- here like every other app DB above (a few KB, harmless if unused), but only
-- the openfga/authz-sync CONTAINERS start when the bundle is selected (see
-- ../../../services/openfga/compose.yml's `profiles: ["authz"]`).
-- `openfga` stays owned by the mesh superuser — its schema is (re)created by
-- the `openfga_migrate` one-shot job, not by app-level `CREATE SCHEMA`.
-- `authz_api_local` is owned by authz_api so the CLI's prisma migrate deploy
-- (R3, meshProvisioned:true) can CREATE SCHEMA — same owner-at-creation pattern
-- as the sis_db/programs app DBs above.
CREATE DATABASE openfga          OWNER postgres_admin;
CREATE DATABASE authz_sync_local OWNER authz_sync;
CREATE DATABASE authz_api_local  OWNER authz_api;

-- ── Grants (belt-and-suspenders; owner already has these) ──────────
GRANT ALL PRIVILEGES ON DATABASE iam_local     TO iam;
GRANT ALL PRIVILEGES ON DATABASE iam_pii_local TO iam_pii;
GRANT ALL PRIVILEGES ON DATABASE programs      TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE scheduling    TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE sessions      TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE content       TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE ads_adm_local TO ads_adm;
GRANT ALL PRIVILEGES ON DATABASE ledger_local  TO ledger;
GRANT ALL PRIVILEGES ON DATABASE sis_db        TO sis;
GRANT ALL PRIVILEGES ON DATABASE coach_api     TO coach_api_app;
GRANT ALL PRIVILEGES ON DATABASE openfga          TO postgres_admin;
GRANT ALL PRIVILEGES ON DATABASE authz_sync_local TO authz_sync;
GRANT ALL PRIVILEGES ON DATABASE authz_api_local  TO authz_api;

-- The sentinel row in _profile_meta.seeded is written by
-- services/postgres/seed/init-and-seed.sh after this file completes.
