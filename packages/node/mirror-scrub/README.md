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
`rds_superuser` member may do; it skips superuser, `pg_*` and `rds*` owners. The grant persists
on the mirror until the next restore.
4. **Closed-world audit:** every column of every base table must be
   overridden or allow-listed by exact `(db, table, column)` unless its type is numeric, bool,
   date/time, interval, enum or uuid (fail-closed: inet, xml, composites, domains over text are
   flagged); non-scrub views are audited too.

`ss stack hydrate --source real` reads `t_real`; `--source scrubbed` reads the view.

The SQL lib (`sql/mirror-scrub-lib.sql`) is design-reviewed: function bodies match
rostering@`bf110ac5` (`iam-mirror-bootstrap/sql/mirror-scrub-lib.sql`) except the audit NOTICE
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

`run-db.sql` owns the `\connect`, the transaction and the db assertion (before and after your file).
`lint` rejects any backslash (psql meta-commands), transaction control and `SET ROLE`/`SET SESSION` in either file.

## CLI

```bash
mirror-scrub run   --db <db> --scrub <db>.scrub.sql --allow <db>.allow.sql [--allow-absent] [-- <psql args>]
mirror-scrub check --db <db> --scrub <db>.scrub.sql --allow <db>.allow.sql [--matrix <file>] [-- <psql args>]
mirror-scrub lint  <file>...
```

Connection comes from `PG*` env vars and/or psql args after `--`; the first connection goes to
`--maintenance-db` (default `postgres`).

### `run` exit codes (iac contract)

| Code | Meaning | Database state |
|---|---|---|
| 0 | Committed, audit clean | scrubbed |
| 10 | Committed, N unreviewed columns/views | scrubbed; new columns NOT scrubbed |
| 11 | Committed, audit did not complete | scrubbed; coverage unknown |
| 20 | Not committed (scrub error, or db absent without `--allow-absent`) | **raw** (rolled back) |
| 30 | Database absent, `--allow-absent` given | n/a |
| 2 | Usage or lint error, nothing ran | untouched |

A runner scrubbing many databases should run them all, then fail on any non-zero code (a 20 is a
raw database and the mirror must not be handed out).

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

A new text/json column without a rule fails `check` with exit 10, which is the pre-merge signal.

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
