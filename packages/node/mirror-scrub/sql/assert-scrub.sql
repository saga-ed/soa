-- Run per database AFTER the scrub, on seeded data, as the scrubbing role (mirror-scrub check).
-- Prints one line per finding: "FAIL ..." (must be empty), "COL <table>.<col> SCRUBBED|PASS|UNSEEDED".
SET client_min_messages = warning;

-- 1. View columns equal {t}_real columns by name, order and type; same row count.
DO $chk$
DECLARE r record; v_cols text; r_cols text; vn bigint; rn bigint;
BEGIN
  FOR r IN SELECT relname FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE '%\_real'
  LOOP
    SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO r_cols
      FROM pg_attribute a WHERE a.attrelid = format('public.%I', r.relname)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a, pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = regexp_replace(r.relname, '_real$', '')
       AND c.relkind = 'v' AND a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_cols IS DISTINCT FROM r_cols THEN
      RAISE WARNING 'FAIL columns differ for %: view=[%] real=[%]', r.relname, v_cols, r_cols;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', regexp_replace(r.relname, '_real$', '')) INTO vn;
    EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO rn;
    IF vn <> rn THEN RAISE WARNING 'FAIL row count differs for %: view=% real=%', r.relname, vn, rn; END IF;
  END LOOP;
END
$chk$;

-- 2. Per-column matrix: SCRUBBED when no non-null view value also occurs in the real table.
CREATE TEMP TABLE _matrix (tbl text, col text, status text);
DO $mx$
DECLARE r record; hit bigint; real_nn bigint;
BEGIN
  FOR r IN
    SELECT regexp_replace(c.relname, '_real$', '') AS tbl, a.attname AS col
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE '%\_real'
     ORDER BY 1, a.attnum
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL', r.tbl || '_real', r.col) INTO real_nn;
    EXECUTE format('SELECT count(*) FROM (SELECT %1$I::text v FROM public.%2$I WHERE %1$I IS NOT NULL INTERSECT SELECT %1$I::text FROM public.%3$I WHERE %1$I IS NOT NULL) x',
                   r.col, r.tbl, r.tbl || '_real') INTO hit;
    INSERT INTO _matrix VALUES (r.tbl, r.col,
      CASE WHEN real_nn = 0 THEN 'UNSEEDED' WHEN hit = 0 THEN 'SCRUBBED' ELSE 'PASS' END);
  END LOOP;
END
$mx$;
SELECT 'COL ' || tbl || '.' || col || ' ' || status FROM _matrix ORDER BY tbl, col;

-- 3. Only the running (master) role may hold any privilege on a {t}_real table.
SELECT 'FAIL ' || c.relname || ' still granted to ' || coalesce(r.rolname, 'PUBLIC') || ' / owner ' || o.rolname
  FROM pg_class c
  JOIN pg_roles o ON o.oid = c.relowner
  LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE '%\_real'
   AND (o.rolname <> current_user OR (a.grantee IS NOT NULL AND coalesce(r.rolname, '') <> current_user));
-- (The unreviewed-column check lives in run-db.sql: pg_temp.mirror_audit +
--  the <db>.allow.sql file make the run exit 10.)

-- 4. Every view/matview (recursively) over a {t}_real table, other than the swap views, is
--    owned by the running role, has no grantee (relation or column level) and is unpopulated.
WITH RECURSIVE dep(oid) AS (
  SELECT r.ev_class FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
   WHERE d.refclassid = 'pg_class'::regclass AND r.ev_class <> d.refobjid
     AND d.refobjid IN (SELECT oid FROM pg_class WHERE relkind = 'r' AND relname LIKE '%\_real')
  UNION
  SELECT r.ev_class FROM dep JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = dep.oid
    JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass WHERE r.ev_class <> dep.oid
)
SELECT 'FAIL dependent ' || c.relname || ' not locked down'
  FROM dep JOIN pg_class c ON c.oid = dep.oid
 WHERE coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'mirror-scrub:%'
   AND (pg_get_userbyid(c.relowner) <> current_user
        OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner)
        OR EXISTS (SELECT 1 FROM pg_attribute at, aclexplode(at.attacl) a WHERE at.attrelid = c.oid AND a.grantee <> c.relowner)
        OR (c.relkind = 'm' AND c.relispopulated));

-- 5. Column-level grants on {t}_real are gone.
SELECT 'FAIL column grant left on ' || c.relname || '.' || at.attname
  FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid AND at.attacl IS NOT NULL
 WHERE c.relkind = 'r' AND c.relname LIKE '%\_real';
