-- mirror-scrub-lib.sql — view-swap scrub helpers for the dev Postgres mirror.
--
-- Loaded by run-db.sql after the \connect to each database (pg_temp is per-connection).
-- Function bodies are design-reviewed (rostering@bf110ac5); a body change needs re-review.
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
-- pg_temp.mirror_audit()
--   Counts (and NOTICEs) columns of base tables that are neither overridden nor
--   allow-listed by EXACT (db, table, column) match
--   (pg_temp.mirror_allow, filled by the service's <db>.allow.sql), plus views and
--   matviews that are not locked down. Fail-closed on type: only numeric, bool,
--   date/time, interval, enum, uuid and uuid/int arrays are exempt (domains follow
--   their base type); a text column named *_id is flagged like any other. Does not raise.
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

CREATE TEMP TABLE IF NOT EXISTS mirror_allow (db text, tbl text, col text);
CREATE TEMP TABLE IF NOT EXISTS mirror_adopted (role oid, n_before bigint);

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
       AND coalesce(obj_description(r.ev_class, 'pg_class'), '') NOT LIKE 'mirror-scrub:%'
    UNION
    SELECT r.ev_class
      FROM dep
      JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = dep.oid
      JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
     WHERE r.ev_class <> dep.oid
       AND coalesce(obj_description(r.ev_class, 'pg_class'), '') NOT LIKE 'mirror-scrub:%'
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

  IF v_kind = 'v' THEN
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = p_schema AND c.relname = p_table || '_real' AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'mirror_scrub: %.% already swapped - skipped', p_schema, p_table;
      RETURN;
    END IF;
    RAISE EXCEPTION 'mirror_scrub: %.% is a view with no %_real table', p_schema, p_table, p_table;
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

  EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS SELECT %s FROM %I.%I',
                 p_schema, p_table || '_public', array_to_string(v_cols, ', '), p_schema, p_table);
  EXECUTE format('COMMENT ON VIEW %I.%I IS %L', p_schema, p_table || '_public',
                 'mirror-scrub:' || coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(p_overrides) k), ''));
  PERFORM pg_temp.mirror_swap(p_schema, p_table);
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.mirror_audit() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  r2 record;
  n integer := 0;
BEGIN
  FOR r IN
    WITH cols AS (
      SELECT n.nspname, c.relname, a.attname,
             CASE WHEN c.relname LIKE '%\_real' AND v.oid IS NOT NULL
                  THEN regexp_replace(c.relname, '_real$', '') ELSE c.relname END AS logical,
             coalesce(string_to_array(substring(obj_description(v.oid, 'pg_class') FROM '^mirror-scrub:(.*)$'), ','), '{}') AS overridden
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_class v ON v.relnamespace = c.relnamespace AND v.relkind = 'v'
             AND c.relname LIKE '%\_real' AND v.relname = regexp_replace(c.relname, '_real$', '')
       WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname !~ '^pg_(toast|temp)' AND c.relname <> '_prisma_migrations'
         AND NOT (t.typcategory IN ('N', 'B', 'D', 'T', 'E') OR t.oid IN ('uuid'::regtype, 'uuid[]'::regtype, 'int2[]'::regtype, 'int4[]'::regtype, 'int8[]'::regtype))
    )
    SELECT * FROM cols
     WHERE NOT (attname = ANY (overridden))
       AND NOT EXISTS (
         SELECT 1 FROM pg_temp.mirror_allow m
          WHERE m.db = current_database() AND m.tbl = logical AND m.col = attname)
     ORDER BY 1, 2, 3
  LOOP
    n := n + 1;
    RAISE NOTICE 'UNREVIEWED COLUMN % .%.% (scrub it in <db>.scrub.sql or allow-list it in <db>.allow.sql)',
      current_database(), r.logical, r.attname;
  END LOOP;
  -- Views / materialized views that are not the scrub's own swap views.
  FOR r IN
    WITH reals AS (
      SELECT t.oid FROM pg_class t JOIN pg_class v ON v.relnamespace = t.relnamespace
         AND v.relname = regexp_replace(t.relname, '_real$', '') AND v.relkind = 'v'
       WHERE t.relkind = 'r' AND t.relname LIKE '%\_real'
         AND coalesce(obj_description(v.oid, 'pg_class'), '') LIKE 'mirror-scrub:%'
    ), over_real AS (
      SELECT oid FROM pg_temp.mirror_dependents(ARRAY(SELECT oid FROM reals))
    )
    SELECT c.oid, n.nspname, c.relname, c.relkind, (c.oid IN (SELECT oid FROM over_real)) AS on_real
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_(toast|temp)'
       AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'mirror-scrub:%'
       AND NOT pg_temp.mirror_locked(c.oid)
  LOOP
    IF r.on_real THEN
      n := n + 1;
      RAISE NOTICE 'UNLOCKED DEPENDENT % .%.% reads a scrubbed table''s real data (not master-owned/ungranted/emptied)',
        current_database(), r.nspname, r.relname;
    ELSE
      FOR r2 IN
        SELECT a.attname FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
         WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
           AND NOT (t.typcategory IN ('N', 'B', 'D', 'T', 'E') OR t.oid IN ('uuid'::regtype, 'uuid[]'::regtype, 'int2[]'::regtype, 'int4[]'::regtype, 'int8[]'::regtype))
           AND NOT EXISTS (SELECT 1 FROM pg_temp.mirror_allow m
                            WHERE m.db = current_database() AND m.tbl = r.relname AND m.col = a.attname)
      LOOP
        n := n + 1;
        RAISE NOTICE 'UNREVIEWED VIEW COLUMN % .%.%', current_database(), r.relname, r2.attname;
      END LOOP;
    END IF;
  END LOOP;
  RETURN n;
END;
$fn$;
