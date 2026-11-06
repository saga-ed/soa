-- run-db.sql — scrub ONE database. Invoked by bin/mirror-scrub, never directly.
-- psql vars: db, lib, allow, scrub (absolute paths); mode (drop|keep), dry (0|1), exact (0|1),
-- version, keep_until, keep_ref; optional report_json / report_md (absolute paths).
-- Sentinel lines on stdout are the CLI's exit-code contract: MIRROR_SCRUB_COMMITTED / _DROPPED <n> /
-- _UNREVIEWED <n> / _DRYRUN <n> / _RESIDUE <n> / _ABSENT, and the final verdict MIRROR_SCRUB_EXIT <code>.
-- Also: report (sql/report-db.sql path).
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
SELECT pg_temp.mirror_plan(:exact = 1) AS n_planned \gset
SELECT (:'mode' = 'drop')::int AS do_drop \gset
\if :do_drop
SELECT pg_temp.mirror_drop_unreviewed() AS n_dropped \gset
\else
\set n_dropped 0
\endif
SELECT pg_temp.mirror_audit() AS n_resid \gset
SELECT (:dry = 1)::int AS is_dry, (:do_drop = 1 AND :n_resid > 0)::int AS must_rollback \gset
\set post_n -1
\if :is_dry
\set status dry_run
\set exit_code 40
\i :report
ROLLBACK;
\echo MIRROR_SCRUB_DRYRUN :db :n_planned
\elif :must_rollback
\set status rolled_back
\set exit_code 20
\i :report
ROLLBACK;
\echo MIRROR_SCRUB_RESIDUE :db :n_resid
\else
SELECT pg_temp.mirror_release();
SELECT pg_temp.mirror_expect_db(:'db');
COMMIT;
\echo MIRROR_SCRUB_COMMITTED :db
\echo MIRROR_SCRUB_DROPPED :db :n_dropped
SELECT pg_temp.mirror_audit() AS n_bad \gset
\echo MIRROR_SCRUB_UNREVIEWED :db :n_bad
SELECT CASE WHEN :n_bad > 0 THEN CASE WHEN :do_drop = 1 THEN 'audit_incomplete' ELSE 'kept_raw' END
            WHEN :n_dropped > 0 THEN 'dropped' ELSE 'clean' END AS status,
       CASE WHEN :n_bad > 0 THEN CASE WHEN :do_drop = 1 THEN 11 ELSE 10 END
            WHEN :n_dropped > 0 THEN 12 ELSE 0 END AS exit_code,
       CASE WHEN :n_bad > 0 AND :do_drop = 1 THEN :n_bad ELSE -1 END AS post_n \gset
\i :report
\endif
\echo MIRROR_SCRUB_EXIT :db :exit_code
\else
\echo MIRROR_SCRUB_ABSENT :db
\endif
