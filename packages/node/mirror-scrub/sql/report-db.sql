-- report-db.sql — included by run-db.sql with status, exit_code and post_n (-1 = no post-commit
-- disagreement) set: prints the markdown report between sentinels and writes the files when asked.
SELECT pg_temp.mirror_report_md(:'mode', :is_dry = 1, :'status', :exit_code, :'keep_until', :'keep_ref', :post_n) AS report_md_text \gset
\echo MIRROR_SCRUB_REPORT_BEGIN :db
\o
\qecho :report_md_text
\o /dev/null
\echo MIRROR_SCRUB_REPORT_END :db
\if :{?report_json}
\pset tuples_only on
\pset format unaligned
\o :report_json
SELECT pg_temp.mirror_report_json(:'mode', :is_dry = 1, :'status', :exit_code, :'version', :'keep_until', :'keep_ref', :post_n);
\o :report_md
\qecho :report_md_text
\o /dev/null
\endif
