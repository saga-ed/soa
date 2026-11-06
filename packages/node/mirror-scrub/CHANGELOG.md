# Changelog

## 0.2.0

- `run` drops unreviewed tables, matviews and views (`DROP ... CASCADE`) instead of leaving them raw; the audit now runs inside the transaction and a residue rolls back (exit 20). New exit codes 12 (dropped) and 40 (`--dry-run`); 10 remains for `--on-unreviewed keep`.
- A table is reviewed when swapped, allow-listed on any column, or marked `('db', 'table', '*')`; tables of only exempt-type columns are no longer implicitly reviewed. Allow rows take an optional `sch` (NULL = public).
- `_prisma_migrations` / `goose_db_version` base tables in any schema are never touched when their columns match the tool's exact shape. Only relations on a named extension allowlist (PostGIS and pg_stat_statements views) are exempt, never `pg_extension.extconfig` tables; large objects fail closed.
- Re-running over an already swapped table re-owns and revokes `<t>_real`; an unlocked `<t>_real` is a finding (dropped in drop mode).
- Reports are written to temp files and moved into place; `check` also runs a dry-run drop plan.
- `--report-dir` JSON + markdown report with itemised cascade dependents; `--exact-counts`; `--on-unreviewed keep --keep-until --keep-ref` escape hatch (max 14 days).
- `check` is unchanged in intent: hard-fail (exit 10), never drops.

## 0.1.2

- Release adopted owner roles before COMMIT.
