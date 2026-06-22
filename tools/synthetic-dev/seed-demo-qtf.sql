-- seed-demo-qtf.sql — a sample QTF evaluation + observation notes on a demo
-- session, so saga-dash's Session Viewer QTF / Notes panels show populated
-- content (the dash's first browser-facing read of sessions.qtf.* /
-- .observations.*). Run by up.sh `seed_qtf_demo()` under the opt-in
-- `--with-qtf-demo` flag — mirrors seed-demo-polls.mjs, but writes straight to
-- the sessions DB because the qtf/observations API is Janus-gated (no seed auth).
--
-- It also seeds the AUTHZ so the calls don't 404: sessions-api gates qtf/
-- observations on `coach:access_qtf` / `coach:use_shared_qtf`, which the IAM
-- demo seed never grants. As a LOCAL-DEV SHIM we (a) grant those perms to the
-- Demo District Observer persona and (b) assign the dev user that persona on the
-- session's district group. The REAL fix belongs in rostering's iam-db seed —
-- this only patches the sessions-api projection so the demo works locally.
--
-- Idempotent throughout (upsert / dedup / delete+insert). Targets the first
-- Ended `v1.` session seed_sessions created, authored as the dev user.
\set ON_ERROR_STOP on
DO $$
DECLARE
  tgt text;
  grp text;
  startt timestamptz;
  dev text := '1e2ca0d8-8f6a-5a97-a141-b38d472a1186';        -- dev@saga.org (the devLogin user)
  obs_persona text := '00000000-0000-4000-a003-000000000016'; -- Demo District Observer persona
BEGIN
  SELECT id, "actualStart" INTO tgt, startt FROM tutoring_session WHERE status = 'Ended' ORDER BY id LIMIT 1;
  IF tgt IS NULL THEN
    RAISE NOTICE 'no Ended demo session — skipping QTF/notes seed';
    RETURN;
  END IF;
  -- Anchor "during the session" note timestamps to the real session window;
  -- fall back to a plausible past window if the session has no actualStart.
  IF startt IS NULL THEN startt := now() - interval '5 days'; END IF;

  -- The session's grant group = its program's organization (district group, #386).
  SELECT prog.organization_id INTO grp
  FROM tutoring_session t
  JOIN period_projection pp ON pp.id = t."periodId"
  JOIN program_projection prog ON prog.id = pp.program_id
  WHERE t.id = tgt;

  -- ── QTF evaluation (per-skill levels + notes) + general notes ──
  INSERT INTO qtf_evaluation (id, session_id, evaluator_id, ratings, general_notes, session_offset_ms, created_at, updated_at)
  VALUES (gen_random_uuid(), tgt, dev,
    '{"positive_relationships":{"level":"skilled","notes":"Warm, encouraging open — strong rapport."},"cognitive_lift":{"level":"approaching","notes":"Push for student reasoning before confirming the answer."},"strategic_use_of_questioning":{"level":"approaching"},"responding_to_student_needs":{"level":"beginning"}}'::jsonb,
    'Strong rapport throughout. Aim for a touch more wait time after open questions, and set a clearer success criterion up front.',
    NULL, now(), now())
  ON CONFLICT (session_id, evaluator_id)
    DO UPDATE SET ratings = EXCLUDED.ratings, general_notes = EXCLUDED.general_notes, updated_at = now();

  -- ── Observation notes: some taken DURING the session, some AFTER ──
  -- The dash tells them apart by session_offset_ms (sessions-api stamps it
  -- = created_at − session_start): a small offset reads as "m:ss into session",
  -- a null/huge offset reads as a post-session note shown by date (MM/DD/YY).
  DELETE FROM session_observation_note WHERE session_id = tgt AND creator_id = dev;
  -- Taken DURING the session: small offsets, created within the session window.
  INSERT INTO session_observation_note (id, session_id, creator_id, note_type, text, session_offset_ms, created_at, updated_at)
  VALUES
    (gen_random_uuid(), tgt, dev, 'glow',     'Warm, encouraging tone right from the start.',             8000,    startt + interval '8 seconds',    startt + interval '8 seconds'),
    (gen_random_uuid(), tgt, dev, 'grow',     'Could give a little more wait time after open questions.', 44000,   startt + interval '44 seconds',   startt + interval '44 seconds'),
    (gen_random_uuid(), tgt, dev, 'bookmark', 'Nice checking-for-understanding move here.',               132000,  startt + interval '132 seconds',  startt + interval '132 seconds'),
    (gen_random_uuid(), tgt, dev, 'glow',     'Student explained their reasoning unprompted — big step.', 1140000, startt + interval '1140 seconds', startt + interval '1140 seconds');
  -- Taken AFTER the session: no offset, created post-session (shown by date).
  INSERT INTO session_observation_note (id, session_id, creator_id, note_type, text, session_offset_ms, created_at, updated_at)
  VALUES
    (gen_random_uuid(), tgt, dev, 'reflection', 'Overall a strong session — the student gained real confidence with elimination.', NULL, now(), now()),
    (gen_random_uuid(), tgt, dev, 'grow',       'Next time, set a clearer success criterion up front and plan a quick retrieval warm-up.', NULL, now() - interval '1 day', now() - interval '1 day');

  -- ── Authz shim: grant the coach QTF perms + assign the dev user the observer
  --    persona on the session's group, so qtf/observations authz passes (else 404).
  UPDATE authz_persona_definition
  SET permissions = (
        SELECT array_agg(DISTINCT p)
        FROM unnest(permissions || ARRAY['coach:access_qtf','coach:use_shared_qtf']) AS p
      ),
      updated_at = now()
  WHERE persona_id = obs_persona;

  IF grp IS NOT NULL THEN
    DELETE FROM authz_persona_assignment WHERE user_id = dev AND persona_id = obs_persona AND group_id = grp;
    INSERT INTO authz_persona_assignment (id, user_id, persona_id, group_id, group_kind, valid_from)
    VALUES (gen_random_uuid(), dev, obs_persona, grp, 'district', timestamptz '2020-01-01 00:00:00+00');
  ELSE
    RAISE NOTICE 'could not resolve grant group for % — qtf/notes authz NOT granted', tgt;
  END IF;
END $$;
-- Emit the target id so up.sh can surface the /session-viewer/<id> link.
SELECT id FROM tutoring_session WHERE status = 'Ended' ORDER BY id LIMIT 1;
