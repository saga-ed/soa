# @saga-ed/soa-mirror-scrub

View-swap PII scrub for the **dev** Postgres mirror (`saga-postgres-mirror-current`), plus the
pre-merge check each owning repo runs in CI. **Never run against prod.**

Each service repo owns the scrub rules for its databases; this package owns the mechanism.
iac's `postgres_mirror_to_dev.yml` pins this package and each service's rules package, then
calls `mirror-scrub run` once per database.

## How the scrub works

Per scrubbed table `t` in a database, as the mirror master:

1. `CREATE VIEW t_public AS SELECT <scrambled cols> FROM t`, built from the live catalog, so
   name/order/type match `t` and a column added later passes through.
2. `t` → `t_real` (re-owned by the master; every grantee loses all access), `t_public` → `t`.
   Table- and column-level SELECT grants move to the view.
3. Views/matviews over `t_real` are re-owned by the master, ungranted and (matviews) emptied.

On RDS the master is NOSUPERUSER and holds no membership in service owner roles. Before
steps 2–3 the lib grants the owner role to the master (`WITH INHERIT TRUE, SET TRUE`), which an
`rds_superuser` member may do; it skips superuser, `pg_*` and `rds*` owners. The grant is revoked
before COMMIT and the scrub refuses to commit if it can't be: an owner in `rds_iam` would otherwise
force IAM auth on the master, locking out its password logins.
4. **Closed-world audit and default drop (0.2.0).** Every relation must be *reviewed*:
   - a table is reviewed when it is swapped by `mirror_scrub`, has at least one `mirror_allow` row,
     or carries a table marker `('db', 'table', '*')` (never allows a column);
   - every column of a reviewed table must be overridden or allow-listed by exact
     `(db, table, column)` unless its type is numeric, bool, date/time, interval, enum or uuid
     (fail-closed: inet, xml, composites, domains over text are flagged);
   - populated non-scrub matviews need the same table review; non-scrub views are audited by column.

   `run` **drops** every unreviewed table/view/matview (`DROP ... CASCADE`, whole relation, never
   nulling columns) inside the transaction, re-audits, and rolls back (exit 20) if anything unreviewed
   remains (extconfig tables of extensions, large objects). Every cascaded dependent is itemised in the
   report. **Referencing tables keep their rows**: foreign keys onto a dropped table are dropped, so
   those rows hold dangling ids. Never touched: `_prisma_migrations` / `goose_db_version` base tables in any schema whose columns match
   the tool's exact shape (a look-alike with another column is audited), extension-owned relations (except
   tables in `pg_extension.extconfig`, which stay audited), and the scrub's own swap views. An already
   swapped `<t>_real` found on a re-run is re-owned and its grants revoked.

`ss stack hydrate --source real` reads `t_real`; `--source scrubbed` reads the view.

The SQL lib (`sql/mirror-scrub-lib.sql`) is design-reviewed: function bodies match
rostering@`bf110ac5` (`iam-mirror-bootstrap/sql/mirror-scrub-lib.sql`) except the audit (0.2.0 reimplements it on `mirror_findings`; needs its own design review), the audit NOTICE
text and its fail-closed type filter (flags every type but numeric, bool, date/time, interval,
enum, uuid and uuid/int arrays; a strict superset of the reviewed filter), and `mirror_adopt`
(0.1.1, separately reviewed). A body change needs a new design review.

## Per-database file contract (owning repo)

Two files per database, shipped in the service's rules package:

- **`<db>.scrub.sql`** — only `pg_temp.mirror_scrub(...)` calls:

  ```sql
  SELECT pg_temp.mirror_scrub('public', 'user_pii', jsonb_build_object(
    'email',      $e$'x_' || left(md5(id::text), 12) || '@example.invalid'$e$,
    'email_hash', $e$NULL$e$));
  SELECT pg_temp.mirror_scrub('public', 'hand_made_table', '{}'::jsonb, false); -- optional table
  ```

  `mirror_scrub(schema, table, overrides, required default true)`: `overrides` maps column → SQL
  expression over the base table's columns (cast to the column type). It raises if an override
  names a missing column, or if the table is missing and `required`.
- **`<db>.allow.sql`** — the reviewed pass-through columns:

  ```sql
  INSERT INTO pg_temp.mirror_allow (db, tbl, col) VALUES
    ('iam_db', 'groups', 'kind');
  ```

  Adding a row is a data-classification decision: opaque ids, enum-like codes, config, measures.
  Never names, free text, credentials, contact data or external student identifiers.
  `('db', 'table', '*')` marks a table as known (needed for tables with only uuid/number/date/enum
  columns, which have nothing to allow-list); it allows no column. An optional fourth column `sch`
  names the schema; NULL means `public`, so tables in other schemas need it. The marker row is inert
  on core 0.1.x, so a rules package can ship it before the core is bumped.

`run-db.sql` owns the `\connect`, the transaction and the db assertion (before and after your file).
`lint` rejects any backslash (psql meta-commands), transaction control and `SET ROLE`/`SET SESSION` in either file.

## CLI

```bash
mirror-scrub run   --db <db> --scrub <db>.scrub.sql --allow <db>.allow.sql [--allow-absent]
                   [--dry-run] [--report-dir <dir>] [--exact-counts]
                   [--on-unreviewed drop|keep --keep-until YYYY-MM-DD --keep-ref <ref>] [-- <psql args>]
mirror-scrub check --db <db> --scrub <db>.scrub.sql --allow <db>.allow.sql [--matrix <file>] [-- <psql args>]
mirror-scrub lint  <file>...
```

Connection comes from `PG*` env vars and/or psql args after `--`; the first connection goes to
`--maintenance-db` (default `postgres`).

### `run` exit codes (iac contract)

| Code | Meaning | Database state |
|---|---|---|
| 0 | Committed, nothing unreviewed | scrubbed |
| 10 | Escape hatch only (`--on-unreviewed keep`): committed, N unreviewed items left RAW | scrubbed; unreviewed RAW |
| 11 | Committed, post-commit audit did not complete or found residue | scrubbed; coverage unknown |
| 12 | Committed, N unreviewed relations DROPPED, nothing raw remains | scrubbed; relations missing |
| 20 | Not committed (scrub error, undroppable residue, large objects, absent db without `--allow-absent`) | **raw** (rolled back) |
| 30 | Database absent, `--allow-absent` given | n/a |
| 40 | `--dry-run` finished; rolled back by design; a real run would exit 0/12 | unchanged |
| 20 (dry-run) | `--dry-run` found residue; a real run would roll back | unchanged |
| 2 | Usage or lint error, nothing ran | untouched |

A runner scrubbing many databases should run them all, then fail on any code other than 0, 12 and 30
(a 20 is a raw database and the mirror must not be handed out). Treat 12 as success **with a loud report**.

`--dry-run` runs scrub, plan, drop and re-audit inside the transaction, writes the report, then rolls back.
Exit 40 means a real run would succeed (0/12); exit 20 means it would roll back. The report lists everything
under `would_drop`; `dropped` and `left_raw` stay empty. `check` ends with such a dry-run and fails on 20.

`--on-unreviewed keep` (the escape hatch) restores the 0.1.x behavior: nothing is dropped and unreviewed
items stay RAW (exit 10). It requires `--keep-until` (today or later, at most 14 days out) and
`--keep-ref` (issue ref), prints an `ESCAPE HATCH ACTIVE` banner and records it in the report.
`check` always runs this way, without arguments, and never drops.

### Report

`--report-dir <dir>` writes `<db>.mirror-scrub.json` and `<db>.mirror-scrub.md`; the markdown block is
also printed between `MIRROR_SCRUB_REPORT_BEGIN <db>` / `_END` lines. JSON: `schema_version`, `tool`,
`db`, `mode`, `dry_run`, `status` (`clean|dropped|kept_raw|rolled_back|dry_run|audit_incomplete`), `exit_code` (the process exit: the SQL writes the report after the post-commit audit and prints `MIRROR_SCRUB_EXIT <db> <code>`; a disagreement is reported as 11/`audit_incomplete` with a `post_commit_audit` object, and when the SQL never got that far the CLI writes a minimal report with the same keys), `counts`, `dropped[]` (schema,
table, relkind, swapped, reason, reasons, columns, rows_estimate from `pg_class.reltuples` or exact with
`--exact-counts`, size_bytes, cascade[]), `left_raw[]`, `would_drop[]` (dry-run and keep mode),
`infra_allowlisted`, `inventory`, `escape_hatch`. Cascade kinds: `fk_constraint` (referencing table and
columns), `view`, `matview`, `policy`, `function`, `column_default`, `publication_member`, `partition`,
`inheritance_child`, `own_objects` (count).

### `check` (pre-merge CI gate)

Runs against a **throwaway** Postgres whose database already has the service's migrations applied.
It refuses unless `MIRROR_SCRUB_THROWAWAY=1`, refuses when it detects RDS (`rdsadmin` /
`rds_superuser`), and must connect as a superuser. It then:

1. seeds 2 recognizable rows into every empty table (`sql/seed-generic.sql`);
2. re-owns every relation to `mirror_check_owner`, grants SELECT to `mirror_check_ro` (plus a
   column-level grant per table), and runs as `mirror_check_master` (NOSUPERUSER, member of the owner);
3. runs the scrub twice (idempotence), each must exit 0;
4. asserts views match `t_real` shape and row count, nothing but the master can read `t_real`,
   dependents are locked (`sql/assert-scrub.sql`). `--matrix` writes per-column
   `SCRUBBED|PASS|UNSEEDED`.

A new text/json column without a rule, or an unknown table, fails `check` with exit 10, which is the pre-merge signal.

Caller job shape (service repo):

```yaml
services:
  postgres:
    image: postgres:18
    env: { POSTGRES_PASSWORD: pw }
    ports: ['5432:5432']
steps:
  - run: pnpm --filter <db-pkg> exec prisma migrate deploy   # DATABASE_URL=.../<db>
  - run: pnpm exec mirror-scrub check --db <db> --scrub mirror-scrub/<db>.scrub.sql --allow mirror-scrub/<db>.allow.sql
    env: { PGHOST: localhost, PGUSER: postgres, PGPASSWORD: pw, MIRROR_SCRUB_THROWAWAY: '1' }
```

## Development

`pnpm test` runs the suite against `postgres:18` via testcontainers (Docker required; override
with `MIRROR_SCRUB_PG_IMAGE`). It needs `psql` on PATH.
