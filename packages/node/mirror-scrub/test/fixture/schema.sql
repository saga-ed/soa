-- Fixture schema for the mirror-scrub suite: one PII table with a dependent view and
-- matview, one outbox table, one table that is fully allow-listed.
CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  email text UNIQUE,
  full_name varchar(200),
  note text,
  kind text NOT NULL DEFAULT 'student',
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_event (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE org (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL
);
CREATE VIEW person_emails AS SELECT id, email FROM person;
CREATE MATERIALIZED VIEW person_counts AS SELECT kind, count(*) AS n FROM person GROUP BY kind;
