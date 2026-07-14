# DRAFT coach-repo issue (Option A) — ready to file, holding pending Seth

> Target repo: **saga-ed/coach**. Coordinate under saga-dash #448/#463 and coach PR #237.
> Filing held until Seth confirms the #237 assignment-seam question (see plan). Say "file it" to post.

---

**Title:** coach-content: `playlist assign` CLI verb (coach-owned `group_track_map` writer) + 2nd seed track

**Body:**

## Summary

Give coach a **coach-owned way to assign a group to a track** (write `group_track_map`) from the
CLI, and seed a second track, so playlist selection no longer depends on `db:seed` alone or on the
legacy `saga_api` `user_policy` path. Keeps playlisting **CLI-driven, no UI**. Unblocks
`ss develop coach --scenario playlist` (soa#305).

## Background

Playlisting is already ~fully re-platformed in coach: `@saga-ed/coach-content-publish`
(`coach-content` CLI) owns publish/materialize, and `group_track_map` + the reconcile materializer
own track resolution (coach #202/#206/#207/#230/#232/#235). The one verified gap: **nothing writes
`group_track_map` in production** — only `db:seed` writes it, reconcile only reads it. The live
signal is the iam policy `coach:coach_playlist_name`, with no projector into coach. So there's no
coach-owned way to (re)assign a group's track without the legacy stack.

## Scope (Option A — minimal, unblocks develop-coach)

- [ ] Add a `playlist` subcommand group to `packages/node/coach-content-publish/src/cli.ts`
      (`src/playlist.ts` beside `src/store.ts`), Prisma → `coach_api` Postgres:
  - `coach-content playlist assign --group <groupId> --content <content_name>` — upsert a
    `group_track_map` row.
  - `coach-content playlist list [--group <groupId>]` — show the current group→track map.
  - `coach-content playlist unassign --group <groupId>` — remove a mapping.
- [ ] Surface from coach-api via a delegating `package.json` script (precedent: `db:seed:run`).
- [ ] Seed/publish a **2nd track** so a persona can be switched between ≥2 playlists locally
      (seed ships only `spring-pilot`).
- [ ] Tests: Postgres integration tests for the writer + the reconcile read-through; unit tests for
      arg parsing/validation.

## Explicitly out of scope (follow-up / Option B)

- Legacy `saga_api` `user_policy` selection cutover (cross-api-plan § session endpoint).
- iam-policy (`coach:coach_playlist_name`) → `group_track_map` projector for live prod parity.

## Coordination

- **Must not** read `saga_api`/saga-dash `user_policy` at runtime (keeps coach's domain boundary).
- Design `playlist assign` to be **additive** to `group_track_map` and compatible with the
  `tagFilter` shape from **coach PR #237** (Phase 2b) — confirm the seam with @SethPaul before build.
- Driving product issues: saga-dash #448, #463.

## Downstream

Enables soa#305 `ss develop coach --scenario playlist`: `coach-content publish` a 2nd track →
`playlist assign` → `materialize --replace`, all inside coach; saga-dash leaves the loop.
