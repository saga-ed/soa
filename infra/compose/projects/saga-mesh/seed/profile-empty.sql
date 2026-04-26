-- saga-mesh / profile=empty
--
-- Creates the six per-app databases and owners for the SDS fixture mesh.
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

-- ── Databases ───────────────────────────────────────────────────────
-- Owner set at creation time so prisma migrate deploy can CREATE SCHEMA.
CREATE DATABASE iam_local       OWNER iam;
CREATE DATABASE iam_pii_local   OWNER iam_pii;
CREATE DATABASE programs        OWNER saga_user;
CREATE DATABASE scheduling      OWNER saga_user;
CREATE DATABASE ads_adm_local   OWNER ads_adm;
CREATE DATABASE ledger_local    OWNER ledger;

-- ── Grants (belt-and-suspenders; owner already has these) ──────────
GRANT ALL PRIVILEGES ON DATABASE iam_local     TO iam;
GRANT ALL PRIVILEGES ON DATABASE iam_pii_local TO iam_pii;
GRANT ALL PRIVILEGES ON DATABASE programs      TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE scheduling    TO saga_user;
GRANT ALL PRIVILEGES ON DATABASE ads_adm_local TO ads_adm;
GRANT ALL PRIVILEGES ON DATABASE ledger_local  TO ledger;

-- The sentinel row in _profile_meta.seeded is written by
-- services/postgres/seed/init-and-seed.sh after this file completes.
