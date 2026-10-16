-- Seeds 2 rows into every empty public base table with recognizable values
-- ('REAL_<column>_<n>') so mirror-scrub check can see which columns survive the scrub.
-- Test-only: run against a throwaway Postgres, never a real mirror. Needs superuser
-- (FK triggers are disabled for the seed).
SET session_replication_role = replica;
DO $seed$
DECLARE
  t record;
  ck record;
  cols text;
  vals text;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND c.relname !~ '^_prisma' AND c.relname !~ '_real$'
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           string_agg(CASE
             WHEN format_type(a.atttypid, a.atttypmod) = 'uuid' THEN 'gen_random_uuid()'
             WHEN a.atttypid IN ('text'::regtype, 'varchar'::regtype)
               THEN format('left(%L || g::text, %s)', 'REAL_' || a.attname || '_',
                           CASE WHEN a.atttypmod > 0 THEN a.atttypmod - 4 ELSE 100000 END)
             WHEN a.atttypid IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype) THEN 'g'
             WHEN a.atttypid = 'bool'::regtype THEN 'false'
             WHEN a.atttypid IN ('timestamp'::regtype, 'timestamptz'::regtype) THEN 'now()'
             WHEN a.atttypid = 'date'::regtype THEN 'current_date'
             WHEN a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype) THEN '1.5'
             WHEN a.atttypid IN ('jsonb'::regtype, 'json'::regtype)
               THEN $j$jsonb_build_object('pii', 'REAL')$j$
             WHEN a.atttypid = 'bytea'::regtype THEN $b$'REAL'::bytea$b$
             WHEN a.atttypid = '_text'::regtype THEN $a$ARRAY['REAL']$a$
             WHEN a.atttypid = '_int4'::regtype THEN 'ARRAY[1]'
             WHEN EXISTS (SELECT 1 FROM pg_type ty WHERE ty.oid = a.atttypid AND ty.typtype = 'e')
               THEN format('(SELECT enumlabel::text FROM pg_enum WHERE enumtypid = %s ORDER BY enumsortorder LIMIT 1)::%s',
                           a.atttypid::int, format_type(a.atttypid, NULL))
             ELSE 'NULL' END, ', ' ORDER BY a.attnum)
      INTO cols, vals
      FROM pg_attribute a
     WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
    BEGIN
      EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM generate_series(1, 2) g', t.relname, cols, vals);
    EXCEPTION WHEN check_violation THEN
      -- generic values can't satisfy domain CHECKs; drop them on this throwaway DB and retry
      FOR ck IN SELECT conname FROM pg_constraint WHERE conrelid = t.oid AND contype = 'c' LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t.relname, ck.conname);
      END LOOP;
      BEGIN
        EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM generate_series(1, 2) g', t.relname, cols, vals);
      EXCEPTION WHEN others THEN
        RAISE WARNING 'seed skipped for %: %', t.relname, SQLERRM;
      END;
    WHEN others THEN
      RAISE WARNING 'seed skipped for %: %', t.relname, SQLERRM;
    END;
  END LOOP;
END;
$seed$;
