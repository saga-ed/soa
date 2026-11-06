# Changelog

## 0.2.0

- `run` drops unreviewed tables, matviews and views (`DROP ... CASCADE`) instead of leaving them raw; the audit now runs inside the transaction and a residue rolls back (exit 20). New exit codes 12 (dropped) and 40 (`--dry-run`); 10 remains for `--on-unreviewed keep`.
- A table is reviewed when swapped, allow-listed on any column, or marked `('db', 'table', '*')`; tables of only exempt-type columns are no longer implicitly reviewed. Allow rows take an optional `sch` (NULL = public).
- `_prisma_migrations` and `goose_db_version` are never touched; extension-owned relations and large objects fail closed.
- `--report-dir` JSON + markdown report with itemised cascade dependents; `--exact-counts`; `--on-unreviewed keep --keep-until --keep-ref` escape hatch (max 14 days).
- `check` is unchanged in intent: hard-fail (exit 10), never drops.

## 0.1.2

- Release adopted owner roles before COMMIT.
