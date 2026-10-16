SELECT pg_temp.mirror_scrub('public', 'person', jsonb_build_object(
  'email',     $e$'x_' || left(md5(id::text), 12) || '@example.invalid'$e$,
  'full_name', $e$'Person ' || left(md5(id::text), 6)$e$,
  'note',      $e$NULL$e$,
  'tags',      $e$NULL$e$));
SELECT pg_temp.mirror_scrub('public', 'outbox_event', jsonb_build_object('payload', $e$'{}'$e$));
