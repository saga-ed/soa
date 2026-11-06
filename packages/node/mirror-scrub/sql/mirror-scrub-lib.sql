-- mirror-scrub-lib.sql — view-swap scrub helpers for the dev Postgres mirror.
--
-- Loaded by run-db.sql after the \connect to each database (pg_temp is per-connection).
-- Function bodies are design-reviewed (rostering@bf110ac5; 0.2.0 additions need their own review);
-- a body change needs re-review.
--
-- pg_temp.mirror_scrub(schema, table, overrides jsonb, required bool)
--   Builds {table}_public from the live catalog (pg_attribute, attnum order, so
--   name/order/type always equal the base table and new columns pass through),
--   replacing only the columns named in `overrides` (column -> SQL expression
--   over the base table's columns) with `(expr)::<column type>`, then swaps.
--   RAISES if an override names a column that no longer exists. RAISES if the
--   table is missing, unless required = false (hand-applied DDL: NOTICE, skip).
--   Re-run safe: an already swapped table (base name is a view, {table}_real
--   exists) is skipped. The overridden column names are stored in the view's
--   comment so pg_temp.mirror_audit() can read them on any later run.
-- pg_temp.mirror_swap(schema, base)
--   Rename swap + grant transfer. Precondition: {base}_public exists.
--   The real table is re-owned by the running role. Every grantee of the real table
--   (PUBLIC included, current_user excluded) loses ALL on {base}_real and receives the
--   same SELECT on the view; column-level SELECT grants move to the view's columns.
--   Views/matviews over {base}_real are re-owned, ungranted and (matviews) emptied.
-- pg_temp.mirror_findings() / mirror_audit()
--   Every unreviewed item: tables that are not swapped, allow-listed on some column, or marked
--   with a ('db', 'table', '*') allow row (a table-level marker; it never allows a column);
--   non-exempt columns of reviewed tables that are neither overridden nor allow-listed by exact
--   (db, table, column) (pg_temp.mirror_allow, filled by <db>.allow.sql; optional sch, NULL = public);
--   populated non-scrub matviews; views and matviews that are not locked down. Fail-closed on
--   type: only numeric, bool, date/time, interval, enum, uuid and uuid/int arrays are exempt
--   (domains follow their base type). _prisma_migrations and goose_db_version are never touched.
--   mirror_audit() counts (and NOTICEs) them plus large objects. Does not raise.
-- pg_temp.mirror_plan(exact) / mirror_cascade(oid) / mirror_drop_unreviewed()
--   Plan the drop of each unreviewed table/view (DROP ... CASCADE, dependents itemised from
--   pg_depend and verified against a catalog diff), then execute it. Undroppable findings
--   (extension-owned relations) are skipped and remain in the audit.
-- pg_temp.mirror_report_json() / mirror_report_md()
--   The per-database report (README).
-- pg_temp.mirror_expect_db(name)
--   RAISES unless current_database() = name.
-- pg_temp.mirror_adopt(owner)
--   On RDS the master is NOSUPERUSER and not a member of service owner roles; as an
--   rds_superuser member it may GRANT them to itself (the AWS-documented route). Grants
--   owner -> current_user WITH INHERIT, SET when missing; only for a non-superuser,
--   non-reserved owner, and only when current_user inherits rds_superuser. No-op elsewhere.
-- pg_temp.mirror_release()
--   Revokes every adopted grant; run-db.sql calls it before COMMIT so no grant outlives the
--   transaction. On RDS an owner in rds_iam would otherwise force IAM auth on the master.

CREATE TEMP TABLE IF NOT EXISTS mirror_allow (db text, tbl text, col text, sch text);
CREATE TEMP TABLE IF NOT EXISTS mirror_adopted (role oid, n_before bigint);
-- Swap views this session built (or verified as its own); never identified by comment, which comes from prod.
CREATE TEMP TABLE IF NOT EXISTS mirror_created (oid oid PRIMARY KEY);

CREATE OR REPLACE FUNCTION pg_temp.mirror_adopt(p_owner oid)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_name text;
BEGIN
  IF pg_has_role(current_user, p_owner, 'USAGE') AND pg_has_role(current_user, p_owner, 'SET') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser')
     OR NOT pg_has_role(current_user, 'rds_superuser', 'USAGE') THEN
    RETURN;
  END IF;
  SELECT rolname INTO v_name FROM pg_roles
   WHERE oid = p_owner AND NOT rolsuper AND rolname NOT LIKE 'pg\_%' AND rolname NOT LIKE 'rds%';
  IF v_name IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO pg_temp.mirror_adopted
    SELECT p_owner, count(*) FROM pg_auth_members
     WHERE roleid = p_owner AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', v_name, current_user);
  RAISE NOTICE 'mirror: granted % to % (rds_superuser adopt)', v_name, current_user;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_release()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT role, min(n_before) AS n_before FROM pg_temp.mirror_adopted GROUP BY role LOOP
    EXECUTE format('REVOKE %s FROM %I', r.role::regrole, current_user);
    IF (SELECT count(*) FROM pg_auth_members
         WHERE roleid = r.role AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user))
       <> r.n_before
       OR pg_has_role(current_user, r.role, 'USAGE') THEN
      RAISE EXCEPTION 'mirror: could not release adopted role % from %; refusing to commit', r.role::regrole, current_user;
    END IF;
    RAISE NOTICE 'mirror: revoked % from % (adopt released)', r.role::regrole, current_user;
  END LOOP;
  DELETE FROM pg_temp.mirror_adopted;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_expect_db(p_db text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_database() <> p_db THEN
    RAISE EXCEPTION 'mirror: connected to % but expected %', current_database(), p_db;
  END IF;
END;
$fn$;


-- Views/matviews (recursively) that depend on any of p_reals, skipping the scrub's own swap
-- views (identified by their 'mirror-scrub:' comment). They stay bound to {t}_real by OID.
CREATE OR REPLACE FUNCTION pg_temp.mirror_dependents(p_reals oid[])
RETURNS TABLE (oid oid) LANGUAGE sql AS $fn$
  WITH RECURSIVE dep(oid) AS (
    SELECT r.ev_class
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
     WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY (p_reals) AND r.ev_class <> d.refobjid
       AND r.ev_class NOT IN (SELECT c.oid FROM pg_temp.mirror_created c)
    UNION
    SELECT r.ev_class
      FROM dep
      JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = dep.oid
      JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
     WHERE r.ev_class <> dep.oid
       AND r.ev_class NOT IN (SELECT c.oid FROM pg_temp.mirror_created c)
  )
  SELECT dep.oid FROM dep;
$fn$;

-- Owned by the master, no grantee (incl. PUBLIC, column-level too), matviews emptied.
CREATE OR REPLACE FUNCTION pg_temp.mirror_locked(p_rel oid) RETURNS boolean
LANGUAGE sql AS $fn$
  SELECT c.relowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)
     AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                      WHERE a.grantee <> c.relowner)
     AND NOT EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a
                      WHERE at.attrelid = c.oid AND at.attacl IS NOT NULL AND a.grantee <> c.relowner)
     AND (c.relkind <> 'm' OR NOT c.relispopulated)
    FROM pg_class c WHERE c.oid = p_rel;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_lock_dependents(p_real oid)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  d record;
  g record;
  v_kw text;
BEGIN
  FOR d IN
    SELECT c.oid, c.relkind, c.relowner, n.nspname, c.relname
      FROM pg_temp.mirror_dependents(ARRAY[p_real]) x
      JOIN pg_class c ON c.oid = x.oid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm')
  LOOP
    v_kw := CASE d.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END;
    IF d.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
      PERFORM pg_temp.mirror_adopt(d.relowner);
      IF NOT pg_has_role(current_user, d.relowner, 'MEMBER') THEN
        RAISE EXCEPTION 'mirror: % cannot re-own dependent %.% (owner %): GRANT % TO %',
          current_user, d.nspname, d.relname, d.relowner::regrole, d.relowner::regrole, current_user;
      END IF;
      EXECUTE format('ALTER %s %I.%I OWNER TO %I', v_kw, d.nspname, d.relname, current_user);
    END IF;
    FOR g IN
      SELECT DISTINCT a.grantee,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS who
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE c.oid = d.oid AND (a.grantee = 0 OR r.rolname <> current_user)
    LOOP
      EXECUTE format('REVOKE ALL ON %I.%I FROM %s', d.nspname, d.relname, g.who);
    END LOOP;
    FOR g IN
      SELECT DISTINCT at.attname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS who
        FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
        LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE at.attrelid = d.oid AND at.attacl IS NOT NULL AND (a.grantee = 0 OR r.rolname <> current_user)
    LOOP
      EXECUTE format('REVOKE ALL (%I) ON %I.%I FROM %s', g.attname, d.nspname, d.relname, g.who);
    END LOOP;
    IF d.relkind = 'm' AND (SELECT relispopulated FROM pg_class WHERE oid = d.oid) THEN
      EXECUTE format('REFRESH MATERIALIZED VIEW %I.%I WITH NO DATA', d.nspname, d.relname);
    END IF;
    RAISE NOTICE 'mirror: locked dependent % %.% (master-owned, no grants%)', lower(v_kw), d.nspname, d.relname,
      CASE WHEN d.relkind = 'm' THEN ', emptied' ELSE '' END;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_swap(p_schema text, p_base text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_real oid;
  g record;
BEGIN
  SELECT c.oid INTO v_real
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = p_schema AND c.relname = p_base AND c.relkind = 'r';
  IF v_real IS NULL THEN RETURN; END IF;

  EXECUTE format('ALTER TABLE %I.%I RENAME TO %I', p_schema, p_base, p_base || '_real');
  EXECUTE format('ALTER VIEW %I.%I RENAME TO %I', p_schema, p_base || '_public', p_base);

  -- The service's owner role must not keep owner access to the real data either.
  IF (SELECT relowner FROM pg_class WHERE oid = v_real) <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', p_schema, p_base || '_real', current_user);
  END IF;

  FOR g IN
    SELECT a.grantee,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS who,
           bool_or(a.privilege_type = 'SELECT') AS has_select
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.oid = v_real AND (a.grantee = 0 OR r.rolname <> current_user)
     GROUP BY a.grantee, r.rolname
  LOOP
    IF g.has_select THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO %s', p_schema, p_base, g.who);
    END IF;
    EXECUTE format('REVOKE ALL ON %I.%I FROM %s', p_schema, p_base || '_real', g.who);
  END LOOP;

  -- Column-level grants follow too (SELECT moves to the view's column).
  FOR g IN
    SELECT at.attname,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS who,
           bool_or(a.privilege_type = 'SELECT') AS has_select
      FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE at.attrelid = v_real AND at.attacl IS NOT NULL AND (a.grantee = 0 OR r.rolname <> current_user)
     GROUP BY at.attname, a.grantee, r.rolname
  LOOP
    IF g.has_select THEN
      EXECUTE format('GRANT SELECT (%I) ON %I.%I TO %s', g.attname, p_schema, p_base, g.who);
    END IF;
    EXECUTE format('REVOKE ALL (%I) ON %I.%I FROM %s', g.attname, p_schema, p_base || '_real', g.who);
  END LOOP;

  PERFORM pg_temp.mirror_lock_dependents(v_real);
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_scrub(
  p_schema text, p_table text,
  p_overrides jsonb DEFAULT '{}'::jsonb,
  p_required boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_oid     oid;
  v_kind    "char";
  v_cols    text[] := '{}';
  v_missing text[];
  v_real    oid;
  v_view    text;
  v_swapped boolean := false;
  r         record;
BEGIN
  SELECT c.oid, c.relkind INTO v_oid, v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = p_schema AND c.relname = p_table AND c.relkind IN ('r', 'v');

  IF v_oid IS NULL THEN
    IF p_required THEN
      RAISE EXCEPTION 'mirror_scrub: %.% does not exist (schema drift?)', p_schema, p_table;
    END IF;
    RAISE NOTICE 'mirror_scrub: %.% does not exist - skipped (optional)', p_schema, p_table;
    RETURN;
  END IF;

  v_view := p_table || '_public';
  IF v_kind = 'v' THEN
    -- Re-run on an already swapped table: rebuild the view from the _real table so nothing about it is trusted.
    SELECT c.oid INTO v_real
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = p_schema AND c.relname = p_table || '_real' AND c.relkind = 'r';
    IF v_real IS NULL THEN
      RAISE EXCEPTION 'mirror_scrub: %.% is a view with no %_real table', p_schema, p_table, p_table;
    END IF;
    RAISE NOTICE 'mirror_scrub: %.% already swapped - view rebuilt', p_schema, p_table;
    v_oid := v_real;
    v_view := p_table;
    v_swapped := true;
  END IF;

  PERFORM pg_temp.mirror_adopt((SELECT relowner FROM pg_class WHERE oid = v_oid));
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = v_oid), 'USAGE')
     OR NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = v_oid), 'MEMBER') THEN
    RAISE EXCEPTION 'mirror_scrub: % cannot rename/re-own %.% (owner %): % must be a member of the owner role (GRANT % TO %)',
      current_user, p_schema, p_table, (SELECT relowner::regrole FROM pg_class WHERE oid = v_oid),
      current_user, (SELECT relowner::regrole FROM pg_class WHERE oid = v_oid), current_user;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_missing
    FROM jsonb_object_keys(p_overrides) AS k
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = v_oid AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'mirror_scrub: %.% has no column(s) % (renamed or dropped?)',
      p_schema, p_table, v_missing;
  END IF;

  FOR r IN
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
     WHERE a.attrelid = v_oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum
  LOOP
    IF p_overrides ? r.attname THEN
      v_cols := v_cols || format('(%s)::%s AS %I', p_overrides ->> r.attname, r.typ, r.attname);
    ELSE
      v_cols := v_cols || format('%I', r.attname);
    END IF;
  END LOOP;

  EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS SELECT %s FROM %s',
                 p_schema, v_view, array_to_string(v_cols, ', '), v_oid::regclass);
  EXECUTE format('COMMENT ON VIEW %I.%I IS %L', p_schema, v_view,
                 'mirror-scrub:' || coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(p_overrides) k), ''));
  INSERT INTO pg_temp.mirror_created
    VALUES (format('%I.%I', p_schema, v_view)::regclass::oid) ON CONFLICT DO NOTHING;
  IF NOT v_swapped THEN
    PERFORM pg_temp.mirror_swap(p_schema, p_table);
  END IF;
END;
$fn$;

-- Exempt column types (domains follow their base type): fail-closed, everything else needs a review.
CREATE OR REPLACE FUNCTION pg_temp.mirror_exempt_type(p_type oid) RETURNS boolean
LANGUAGE sql AS $fn$
  SELECT t.typcategory IN ('N', 'B', 'D', 'T', 'E')
      OR t.oid IN ('uuid'::regtype, 'uuid[]'::regtype, 'int2[]'::regtype, 'int4[]'::regtype, 'int8[]'::regtype)
    FROM pg_type t WHERE t.oid = p_type;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_is_ext(p_rel oid) RETURNS boolean
LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = p_rel AND d.deptype = 'e');
$fn$;

-- Infra tables never touched: public base tables only, so a same-named table elsewhere is audited normally.
CREATE OR REPLACE FUNCTION pg_temp.mirror_is_infra(p_kind "char", p_schema text, p_name text) RETURNS boolean
LANGUAGE sql AS $fn$
  SELECT p_kind = 'r' AND p_schema = 'public' AND p_name IN ('_prisma_migrations', 'goose_db_version');
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_large_objects() RETURNS bigint
LANGUAGE sql AS $fn$ SELECT count(*) FROM pg_largeobject_metadata; $fn$;

-- One row per unreviewed item. Logical tables (a swapped t_real counts as t; a partition family as
-- its root) are "reviewed" when swapped, allow-listed on any column, or marked with col = '*'.
-- f_oid is the relation a drop must target (t_real for swapped tables).
CREATE OR REPLACE FUNCTION pg_temp.mirror_findings()
RETURNS TABLE (f_sch text, f_logical text, f_relkind "char", f_col text, f_reason text,
               f_oid oid, f_swapped boolean, f_undroppable boolean)
LANGUAGE sql AS $fn$
  WITH base AS (
    SELECT c.oid, n.nspname AS sch, c.relname, c.relkind, c.relispopulated,
           (v.oid IS NOT NULL) AS swapped,
           CASE WHEN v.oid IS NOT NULL THEN v.relname ELSE c.relname END AS logical,
           coalesce(string_to_array(substring(obj_description(v.oid, 'pg_class') FROM '^mirror-scrub:(.*)$'), ','), '{}') AS overridden,
           pg_temp.mirror_is_ext(c.oid) AS is_ext
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class v ON v.relnamespace = c.relnamespace AND v.relkind = 'v'
           AND c.relkind = 'r' AND c.relname LIKE '%\_real' AND v.relname = regexp_replace(c.relname, '_real$', '')
           AND v.oid IN (SELECT mc.oid FROM pg_temp.mirror_created mc)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'
       AND NOT pg_temp.mirror_is_infra(c.relkind, n.nspname, c.relname)
       AND c.oid NOT IN (SELECT mc.oid FROM pg_temp.mirror_created mc)
  ), kn AS (
    SELECT b.*,
           (b.swapped OR EXISTS (SELECT 1 FROM pg_temp.mirror_allow m
                                  WHERE m.db = current_database() AND m.tbl = b.logical
                                    AND coalesce(m.sch, 'public') = b.sch)) AS is_known
      FROM base b
  ), on_real AS (
    SELECT oid FROM pg_temp.mirror_dependents(ARRAY(SELECT oid FROM base WHERE swapped))
  )
  SELECT k.sch, k.logical, k.relkind, NULL::text, 'unreviewed_table', k.oid, false, false
    FROM kn k
   WHERE k.relkind IN ('r', 'p', 'f') AND NOT k.is_known AND NOT k.is_ext
  UNION ALL
  SELECT k.sch, k.logical, k.relkind, NULL::text, 'unreviewed_matview', k.oid, false, false
    FROM kn k
   WHERE k.relkind = 'm' AND k.relispopulated AND NOT k.is_known AND NOT k.is_ext
     AND k.oid NOT IN (SELECT oid FROM on_real)
  UNION ALL
  SELECT k.sch, k.logical, k.relkind, a.attname::text, 'unreviewed_column', k.oid, k.swapped, k.is_ext
    FROM kn k
    JOIN pg_attribute a ON a.attrelid = k.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE k.relkind IN ('r', 'p', 'f') AND (k.is_known OR k.is_ext)
     AND NOT pg_temp.mirror_exempt_type(a.atttypid)
     AND NOT (a.attname = ANY (k.overridden))
     AND NOT EXISTS (SELECT 1 FROM pg_temp.mirror_allow m
                      WHERE m.db = current_database() AND m.tbl = k.logical AND m.col = a.attname
                        AND coalesce(m.sch, 'public') = k.sch)
  UNION ALL
  SELECT k.sch, k.logical, k.relkind, NULL::text, 'unlocked_dependent', k.oid, false, k.is_ext
    FROM kn k
   WHERE k.relkind IN ('v', 'm') AND NOT pg_temp.mirror_locked(k.oid) AND k.oid IN (SELECT oid FROM on_real)
  UNION ALL
  SELECT k.sch, k.logical, k.relkind, a.attname::text, 'unreviewed_view_column', k.oid, false, k.is_ext
    FROM kn k
    JOIN pg_attribute a ON a.attrelid = k.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE k.relkind IN ('v', 'm') AND NOT pg_temp.mirror_locked(k.oid) AND k.oid NOT IN (SELECT oid FROM on_real)
     AND NOT pg_temp.mirror_exempt_type(a.atttypid)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.mirror_allow m
                      WHERE m.db = current_database() AND m.tbl = k.logical AND m.col = a.attname
                        AND coalesce(m.sch, 'public') = k.sch);
$fn$;

-- Counts (and NOTICEs) every unreviewed item plus large objects. Does not raise.
CREATE OR REPLACE FUNCTION pg_temp.mirror_audit() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  n integer := 0;
  v_lo bigint;
BEGIN
  FOR r IN SELECT * FROM pg_temp.mirror_findings() ORDER BY f_sch, f_logical, f_col LOOP
    n := n + 1;
    CASE r.f_reason
      WHEN 'unreviewed_column' THEN
        RAISE NOTICE 'UNREVIEWED COLUMN % .%.% (scrub it in <db>.scrub.sql or allow-list it in <db>.allow.sql)',
          current_database(), r.f_logical, r.f_col;
      WHEN 'unreviewed_table' THEN
        RAISE NOTICE 'UNREVIEWED TABLE % .%.% (scrub it in <db>.scrub.sql, or allow-list a column / add a ''*'' marker in <db>.allow.sql)',
          current_database(), r.f_sch, r.f_logical;
      WHEN 'unreviewed_matview' THEN
        RAISE NOTICE 'UNREVIEWED MATVIEW % .%.%', current_database(), r.f_sch, r.f_logical;
      WHEN 'unlocked_dependent' THEN
        RAISE NOTICE 'UNLOCKED DEPENDENT % .%.% reads a scrubbed table''s real data (not master-owned/ungranted/emptied)',
          current_database(), r.f_sch, r.f_logical;
      ELSE
        RAISE NOTICE 'UNREVIEWED VIEW COLUMN % .%.%', current_database(), r.f_logical, r.f_col;
    END CASE;
  END LOOP;
  v_lo := pg_temp.mirror_large_objects();
  IF v_lo > 0 THEN
    n := n + 1;
    RAISE NOTICE 'LARGE OBJECTS % : % large object(s) present; they cannot be scrubbed or dropped per table', current_database(), v_lo;
  END IF;
  RETURN n;
END;
$fn$;

-- All objects DROP ... CASCADE of p_oid would remove, as (classid, objid), following pg_depend
-- (rewrite rules are mapped to their view).
CREATE OR REPLACE FUNCTION pg_temp.mirror_closure(p_oid oid)
RETURNS TABLE (classid oid, objid oid) LANGUAGE sql AS $fn$
  WITH RECURSIVE dep(classid, objid) AS (
    SELECT 'pg_class'::regclass::oid, p_oid
    UNION
    SELECT x.classid, x.objid
      FROM dep
      JOIN pg_depend d ON d.refclassid = dep.classid AND d.refobjid = dep.objid AND d.deptype NOT IN ('p', 'e')
      CROSS JOIN LATERAL (
        SELECT d.classid, d.objid
        UNION ALL
        SELECT 'pg_class'::regclass::oid, r.ev_class FROM pg_rewrite r
         WHERE d.classid = 'pg_rewrite'::regclass AND r.oid = d.objid
           AND r.ev_class IN (SELECT c.oid FROM pg_class c WHERE c.relkind IN ('v', 'm'))
      ) x
  )
  SELECT dep.classid, dep.objid FROM dep;
$fn$;

-- Itemised dependents (not the relation's own indexes/triggers/constraints) as a jsonb array.
CREATE OR REPLACE FUNCTION pg_temp.mirror_cascade(p_oid oid) RETURNS jsonb
LANGUAGE sql AS $fn$
  WITH cl AS (SELECT * FROM pg_temp.mirror_closure(p_oid)),
  rels AS (SELECT objid FROM cl WHERE classid = 'pg_class'::regclass),
  items AS (
    SELECT jsonb_build_object('kind',
             CASE WHEN c.relkind = 'v' THEN 'view' WHEN c.relkind = 'm' THEN 'matview'
                  WHEN c.relkind = 'f' THEN 'foreign_table'
                  WHEN c.relispartition THEN 'partition' ELSE 'inheritance_child' END,
             'schema', n.nspname, 'name', c.relname) AS item
      FROM cl JOIN pg_class c ON cl.classid = 'pg_class'::regclass AND c.oid = cl.objid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid <> p_oid AND c.relkind IN ('v', 'm', 'r', 'p', 'f')
    UNION ALL
    SELECT jsonb_build_object('kind', 'fk_constraint', 'name', k.conname, 'schema', n.nspname,
             'table', t.relname,
             'columns', (SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(num, ord)
                          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num),
             'referencing_rows_estimate', CASE WHEN t.reltuples < 0 THEN NULL ELSE t.reltuples::bigint END)
      FROM cl JOIN pg_constraint k ON cl.classid = 'pg_constraint'::regclass AND k.oid = cl.objid
      JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE k.contype = 'f' AND k.conrelid NOT IN (SELECT objid FROM rels)
    UNION ALL
    SELECT jsonb_build_object('kind', 'policy', 'name', p.polname, 'schema', n.nspname, 'table', t.relname)
      FROM cl JOIN pg_policy p ON cl.classid = 'pg_policy'::regclass AND p.oid = cl.objid
      JOIN pg_class t ON t.oid = p.polrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE p.polrelid NOT IN (SELECT objid FROM rels)
    UNION ALL
    SELECT jsonb_build_object('kind', 'trigger', 'name', tr.tgname, 'schema', n.nspname, 'table', t.relname)
      FROM cl JOIN pg_trigger tr ON cl.classid = 'pg_trigger'::regclass AND tr.oid = cl.objid
      JOIN pg_class t ON t.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE tr.tgrelid NOT IN (SELECT objid FROM rels) AND NOT tr.tgisinternal
    UNION ALL
    SELECT jsonb_build_object('kind', 'rule', 'name', rw.rulename, 'schema', n.nspname, 'table', t.relname)
      FROM cl JOIN pg_rewrite rw ON cl.classid = 'pg_rewrite'::regclass AND rw.oid = cl.objid
      JOIN pg_class t ON t.oid = rw.ev_class JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE rw.ev_class NOT IN (SELECT objid FROM rels)
    UNION ALL
    SELECT jsonb_build_object('kind', 'function', 'name', pr.proname, 'schema', n.nspname)
      FROM cl JOIN pg_proc pr ON cl.classid = 'pg_proc'::regclass AND pr.oid = cl.objid
      JOIN pg_namespace n ON n.oid = pr.pronamespace
    UNION ALL
    SELECT jsonb_build_object('kind', 'column_default', 'schema', n.nspname, 'table', t.relname, 'name', a.attname)
      FROM cl JOIN pg_attrdef ad ON cl.classid = 'pg_attrdef'::regclass AND ad.oid = cl.objid
      JOIN pg_class t ON t.oid = ad.adrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
     WHERE ad.adrelid NOT IN (SELECT objid FROM rels)
    UNION ALL
    SELECT jsonb_build_object('kind', 'publication_member', 'name', pub.pubname)
      FROM cl JOIN pg_publication_rel pr ON cl.classid = 'pg_publication_rel'::regclass AND pr.oid = cl.objid
      JOIN pg_publication pub ON pub.oid = pr.prpubid
  )
  SELECT coalesce(jsonb_agg(item ORDER BY item ->> 'kind', item ->> 'schema', item ->> 'name', item ->> 'table'), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('kind', 'own_objects',
              'count', (SELECT count(*) FROM cl) - 1 - (SELECT count(*) FROM items)))
    FROM items;
$fn$;

CREATE TEMP TABLE IF NOT EXISTS mirror_plan_t (
  seq serial, oid oid, sch text, logical text, relkind "char", swapped boolean,
  reasons text[], cols text[], undroppable boolean,
  rows_est bigint, size_bytes bigint, cascade jsonb, owner oid, closure text[],
  dropped boolean NOT NULL DEFAULT false
);

-- Fills mirror_plan_t from mirror_findings(), one row per drop target; changes nothing else.
CREATE OR REPLACE FUNCTION pg_temp.mirror_plan(p_exact boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  v_rows bigint;
  v_casc jsonb;
BEGIN
  DELETE FROM pg_temp.mirror_plan_t;
  FOR r IN
    SELECT f_oid, f_sch, f_logical, f_relkind, bool_or(f_swapped) AS swapped,
           array_agg(DISTINCT f_reason ORDER BY f_reason) AS reasons,
           coalesce(array_agg(f_col ORDER BY f_col) FILTER (WHERE f_col IS NOT NULL), '{}') AS cols,
           bool_or(f_undroppable) AS undroppable
      FROM pg_temp.mirror_findings()
     GROUP BY f_oid, f_sch, f_logical, f_relkind
     ORDER BY CASE f_relkind WHEN 'v' THEN 3 WHEN 'm' THEN 2 ELSE 1 END, f_sch, f_logical
  LOOP
    IF p_exact AND r.f_relkind IN ('r', 'p', 'f', 'm') THEN
      EXECUTE format('SELECT count(*) FROM %s', r.f_oid::regclass) INTO v_rows;
    ELSIF r.f_relkind = 'p' THEN
      SELECT sum(c.reltuples)::bigint INTO v_rows
        FROM pg_partition_tree(r.f_oid) t JOIN pg_class c ON c.oid = t.relid WHERE t.isleaf AND c.reltuples > 0;
    ELSE
      SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END INTO v_rows FROM pg_class c WHERE c.oid = r.f_oid;
    END IF;
    v_casc := pg_temp.mirror_cascade(r.f_oid);
    -- A policy, trigger or rule on a retained table would vanish silently: fail closed instead.
    INSERT INTO pg_temp.mirror_plan_t
      (oid, sch, logical, relkind, swapped, reasons, cols, undroppable, rows_est, size_bytes, cascade, owner, closure)
    SELECT r.f_oid, r.f_sch, r.f_logical, r.f_relkind, r.swapped, r.reasons, r.cols,
           r.undroppable OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_casc) e WHERE e ->> 'kind' IN ('policy', 'trigger', 'rule')),
           v_rows,
           CASE WHEN r.f_relkind = 'p' THEN (SELECT sum(pg_total_relation_size(t.relid))::bigint FROM pg_partition_tree(r.f_oid) t WHERE t.isleaf)
                WHEN r.f_relkind IN ('v', 'f') THEN 0 ELSE pg_total_relation_size(r.f_oid) END,
           v_casc,
           (SELECT relowner FROM pg_class WHERE oid = r.f_oid),
           pg_temp.mirror_closure_keys(r.f_oid);
  END LOOP;
  RETURN (SELECT count(*) FROM pg_temp.mirror_plan_t);
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_closure_keys(p_oid oid) RETURNS text[]
LANGUAGE sql AS $fn$
  SELECT array_agg(CASE classid WHEN 'pg_class'::regclass THEN 'pg_class:' WHEN 'pg_constraint'::regclass THEN 'pg_constraint:'
                                WHEN 'pg_trigger'::regclass THEN 'pg_trigger:' WHEN 'pg_policy'::regclass THEN 'pg_policy:'
                                WHEN 'pg_rewrite'::regclass THEN 'pg_rewrite:' WHEN 'pg_attrdef'::regclass THEN 'pg_attrdef:'
                                ELSE 'other:' END || objid)
    FROM pg_temp.mirror_closure(p_oid);
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_catalog_keys() RETURNS text[]
LANGUAGE sql AS $fn$
  SELECT array_agg(k) FROM (
    SELECT 'pg_class:' || oid FROM pg_class UNION ALL SELECT 'pg_constraint:' || oid FROM pg_constraint
    UNION ALL SELECT 'pg_trigger:' || oid FROM pg_trigger UNION ALL SELECT 'pg_policy:' || oid FROM pg_policy
    UNION ALL SELECT 'pg_rewrite:' || oid FROM pg_rewrite UNION ALL SELECT 'pg_attrdef:' || oid FROM pg_attrdef
  ) s(k);
$fn$;

-- Drops every planned relation (CASCADE). Needs the adopted owner grants, so run it before mirror_release().
-- Undroppable findings are skipped and stay in the audit. After each drop, every catalog object that
-- vanished must be in the pg_depend closure computed beforehand; otherwise it raises.
CREATE OR REPLACE FUNCTION pg_temp.mirror_drop_unreviewed() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  v_kw text;
  v_before text[];
  v_closure text[];
  v_unexpected text;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM pg_temp.mirror_plan_t WHERE NOT undroppable ORDER BY seq LOOP
    SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END
      INTO v_kw FROM pg_class c WHERE c.oid = r.oid;
    IF v_kw IS NULL THEN
      UPDATE pg_temp.mirror_plan_t SET dropped = true WHERE seq = r.seq;
      v_n := v_n + 1;
      CONTINUE;
    END IF;

    PERFORM pg_temp.mirror_adopt(r.owner);
    IF NOT pg_has_role(current_user, r.owner, 'USAGE') OR NOT pg_has_role(current_user, r.owner, 'MEMBER') THEN
      RAISE EXCEPTION 'mirror_drop: % cannot drop %.% (owner %): % must be a member of the owner role (GRANT % TO %)',
        current_user, r.sch, r.logical, r.owner::regrole, current_user, r.owner::regrole, current_user;
    END IF;

    v_before := pg_temp.mirror_catalog_keys();
    v_closure := r.closure;

    EXECUTE format('DROP %s %s CASCADE', v_kw, r.oid::regclass);

    SELECT string_agg(k, ', ') INTO v_unexpected FROM (
      (SELECT k FROM unnest(v_before) k EXCEPT SELECT k FROM unnest(pg_temp.mirror_catalog_keys()) k)
      EXCEPT SELECT k FROM unnest(v_closure) k) s;
    IF v_unexpected IS NOT NULL THEN
      RAISE EXCEPTION 'mirror_drop: dropping %.% also removed objects outside its dependency closure: %', r.sch, r.logical, v_unexpected;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = r.oid) THEN
      RAISE EXCEPTION 'mirror_drop: %.% still exists after DROP', r.sch, r.logical;
    END IF;
    UPDATE pg_temp.mirror_plan_t SET dropped = true WHERE seq = r.seq;
    v_n := v_n + 1;
    RAISE NOTICE 'mirror: DROPPED %.% (%)', r.sch, r.logical, array_to_string(r.reasons, ',');
  END LOOP;
  RETURN v_n;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_plan_entry(r pg_temp.mirror_plan_t) RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'schema', r.sch, 'table', r.logical, 'relkind', r.relkind::text, 'swapped', r.swapped,
    'reason', CASE WHEN 'unreviewed_table' = ANY (r.reasons) THEN 'unreviewed_table' ELSE r.reasons[1] END,
    'reasons', to_jsonb(r.reasons), 'columns', to_jsonb(r.cols),
    'rows_estimate', r.rows_est, 'size_bytes', r.size_bytes,
    'undroppable', r.undroppable, 'cascade', r.cascade);
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_report_json(
  p_mode text, p_dry boolean, p_status text, p_exit integer, p_version text, p_until text, p_ref text, p_post integer
) RETURNS text LANGUAGE sql AS $fn$
  SELECT jsonb_pretty(jsonb_build_object(
    'schema_version', 1,
    'tool', jsonb_build_object('name', '@saga-ed/soa-mirror-scrub', 'version', p_version),
    'db', current_database(), 'mode', p_mode, 'dry_run', p_dry, 'status', p_status, 'exit_code', p_exit,
    'counts', jsonb_build_object(
      'dropped', (SELECT count(*) FROM pg_temp.mirror_plan_t WHERE dropped),
      'cascaded', (SELECT coalesce(sum(jsonb_array_length(cascade) - 1), 0) FROM pg_temp.mirror_plan_t WHERE dropped),
      'left_raw', (SELECT count(*) FROM pg_temp.mirror_plan_t WHERE NOT dropped),
      'estimated_rows_dropped', (SELECT coalesce(sum(rows_est), 0) FROM pg_temp.mirror_plan_t WHERE dropped)),
    'dropped', (SELECT coalesce(jsonb_agg(pg_temp.mirror_plan_entry(t) ORDER BY seq), '[]') FROM pg_temp.mirror_plan_t t WHERE dropped),
    'left_raw', (SELECT coalesce(jsonb_agg(pg_temp.mirror_plan_entry(t) ORDER BY seq), '[]') FROM pg_temp.mirror_plan_t t WHERE NOT dropped),
    'would_drop', (SELECT coalesce(jsonb_agg(pg_temp.mirror_plan_entry(t) ORDER BY seq), '[]') FROM pg_temp.mirror_plan_t t
                    WHERE p_dry OR p_mode = 'keep'),
    'infra_allowlisted', (SELECT coalesce(jsonb_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname), '[]')
                            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE pg_temp.mirror_is_infra(c.relkind, n.nspname, c.relname)),
    'inventory', jsonb_build_object(
      'relkinds', (SELECT coalesce(jsonb_object_agg(relkind::text, n), '{}') FROM (
                     SELECT c.relkind, count(*) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                      WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname !~ '^pg_(toast|temp)'
                        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') GROUP BY c.relkind) s),
      'extension_members', (SELECT coalesce(jsonb_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname), '[]')
                              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
                               AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'
                               AND pg_temp.mirror_is_ext(c.oid)),
      'large_objects', pg_temp.mirror_large_objects(),
      'non_public_schemas', (SELECT coalesce(jsonb_agg(nspname ORDER BY nspname), '[]') FROM pg_namespace
                              WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND nspname !~ '^pg_(toast|temp)')),
    'escape_hatch', jsonb_build_object('active', p_mode = 'keep' AND p_until <> '', 'until', nullif(p_until, ''), 'ref', nullif(p_ref, ''))
  ) || CASE WHEN p_post >= 0 THEN jsonb_build_object('post_commit_audit', jsonb_build_object('agrees', false, 'unreviewed', p_post)) ELSE '{}'::jsonb END)::text;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_report_md(
  p_mode text, p_dry boolean, p_status text, p_exit integer, p_until text, p_ref text, p_post integer
) RETURNS text LANGUAGE sql AS $fn$
  SELECT concat_ws(E'\n',
    format('### mirror-scrub `%s`: %s (exit %s)%s', current_database(), p_status, p_exit, CASE WHEN p_dry THEN ' [dry-run, rolled back]' ELSE '' END),
    CASE WHEN p_post >= 0 THEN format('**Post-commit audit disagreed:** %s unreviewed item(s) found after COMMIT.', p_post) END,
    CASE WHEN p_mode = 'keep' AND p_until <> '' THEN format('**ESCAPE HATCH ACTIVE** until %s (%s): unreviewed items are left RAW.', p_until, p_ref) END,
    CASE WHEN (SELECT count(*) FROM pg_temp.mirror_plan_t) = 0 THEN 'No unreviewed relations.' ELSE
      E'\n| Relation | Reason | Columns | Rows~ | State |\n|---|---|---|---|---|' || E'\n' ||
      (SELECT string_agg(format('| `%s.%s` | %s | %s | %s | %s |', sch, logical, array_to_string(reasons, ','),
                                coalesce(array_to_string(cols, ','), ''), coalesce(rows_est::text, '?'),
                                CASE WHEN dropped THEN 'DROPPED' WHEN undroppable THEN 'RAW (cannot drop)' WHEN p_mode = 'keep' THEN 'RAW (kept)' ELSE 'RAW' END),
                         E'\n' ORDER BY seq)
         FROM (SELECT * FROM pg_temp.mirror_plan_t ORDER BY seq LIMIT 100) t) ||
      CASE WHEN (SELECT count(*) FROM pg_temp.mirror_plan_t) > 100
           THEN format(E'\n+%s more in the JSON report', (SELECT count(*) FROM pg_temp.mirror_plan_t) - 100) ELSE '' END
    END,
    (SELECT string_agg(format('- `%s.%s` cascade: %s', t.sch, t.logical, c.s), E'\n' ORDER BY t.seq)
       FROM pg_temp.mirror_plan_t t
       CROSS JOIN LATERAL (SELECT string_agg(coalesce(e ->> 'schema' || '.', '') || coalesce(e ->> 'table' || '.', '') || coalesce(e ->> 'name', '') || ' (' || (e ->> 'kind') || ')', ', ') AS s
                             FROM jsonb_array_elements(t.cascade) e WHERE e ->> 'kind' <> 'own_objects') c
      WHERE c.s IS NOT NULL),
    CASE WHEN EXISTS (SELECT 1 FROM pg_temp.mirror_plan_t t, jsonb_array_elements(t.cascade) e WHERE t.dropped AND e ->> 'kind' = 'fk_constraint')
         THEN '> Dangling FKs: foreign keys referencing dropped tables were dropped with them. The referencing tables keep all their rows, and their FK columns now hold ids that no longer exist.' END,
    CASE WHEN (SELECT count(*) FROM pg_temp.mirror_plan_t) > 0
         THEN 'Fix: scrub the table in `<db>.scrub.sql`, or allow-list its reviewed columns / add a `''*''` marker row in `<db>.allow.sql`.' END
  );
$fn$;
