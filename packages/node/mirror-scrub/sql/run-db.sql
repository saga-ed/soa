-- run-db.sql — scrub ONE database. Invoked by bin/mirror-scrub, never directly.
-- psql vars: db, lib, allow, scrub (absolute paths). Sentinel lines on stdout are the
-- CLI's exit-code contract: MIRROR_SCRUB_COMMITTED / _UNREVIEWED <n> / _ABSENT.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') AS has_db \gset
\if :has_db
\connect :"db"
\i :lib
\i :allow
SELECT pg_temp.mirror_expect_db(:'db');
BEGIN;
\i :scrub
SELECT pg_temp.mirror_release();
SELECT pg_temp.mirror_expect_db(:'db');
COMMIT;
\echo MIRROR_SCRUB_COMMITTED :db
SELECT pg_temp.mirror_audit() AS n_bad \gset
\echo MIRROR_SCRUB_UNREVIEWED :db :n_bad
\else
\echo MIRROR_SCRUB_ABSENT :db
\endif
