-- run-db.sql — scrub ONE database. Invoked by bin/mirror-scrub, never directly.
-- psql vars: db, lib, allow, scrub (absolute paths); mode (drop|keep), dry (0|1), exact (0|1),
-- version, keep_until, keep_ref; optional report_json / report_md (absolute paths).
-- Sentinel lines on stdout are the CLI's exit-code contract: MIRROR_SCRUB_COMMITTED / _DROPPED <n> /
-- _UNREVIEWED <n> / _DRYRUN <n> / _RESIDUE <n> / _ABSENT.
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
SELECT CASE WHEN :is_dry = 1 THEN 'dry_run' WHEN :must_rollback = 1 THEN 'rolled_back'
            WHEN :do_drop = 0 AND :n_resid > 0 THEN 'kept_raw' WHEN :n_dropped > 0 THEN 'dropped' ELSE 'clean' END AS status,
       CASE WHEN :is_dry = 1 THEN 40 WHEN :must_rollback = 1 THEN 20 WHEN :do_drop = 0 AND :n_resid > 0 THEN 10
            WHEN :n_dropped > 0 THEN 12 ELSE 0 END AS exit_code \gset
\echo MIRROR_SCRUB_REPORT_BEGIN :db
SELECT pg_temp.mirror_report_md(:'mode', :is_dry = 1, :'status', :exit_code, :'keep_until', :'keep_ref') AS report_md_text \gset
\o
\qecho :report_md_text
\o /dev/null
\echo MIRROR_SCRUB_REPORT_END :db
\if :{?report_json}
\pset tuples_only on
\pset format unaligned
\o :report_json
SELECT pg_temp.mirror_report_json(:'mode', :is_dry = 1, :'status', :exit_code, :'version', :'keep_until', :'keep_ref');
\o :report_md
\qecho :report_md_text
\o /dev/null
\endif
\if :is_dry
ROLLBACK;
\echo MIRROR_SCRUB_DRYRUN :db :n_planned
\elif :must_rollback
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
\endif
\else
\echo MIRROR_SCRUB_ABSENT :db
\endif
