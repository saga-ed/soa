# Design — numbered, immutable canonical snapshot versions (non-destructive re-cut + rollback)

> ## ✅ Outcome (IMPLEMENTED + SHIPPED 2026-06-19)
> Built as **soa#168** → PR #169 (merged) → published as `@saga-ed/infra-compose@1.5.0` (PR #170) →
> deployed to all 5 dev db-host-v2 nodes in place via SSM `npm install -g` (no instance refresh) →
> iac db-host-v2 ASG template default bumped 1.3.2→1.5.0 (hipponot/iac#435, merged). `snapshot_db`
> now writes immutable `profile-<p>-v<N>.sql` + sidecar (version/supersedes) then advances the mutable
> `profile-<p>.sql` pointer; `download_profile_seed` accepts a `<profile>@vN` rollback pin. Exercised by
> the canonical re-cut: existing canonicals backfilled to `-v1`, re-cut landed as `-v2`, the new sessions
> canonical as `-v1`, and the iam-pii fix as `-v3` — all non-destructively, prior versions retained.
> See `rebaseline-canonical-from-synthetic-dev.md` Outcome block.

**Status:** DONE 2026-06-19 (was DRAFT 2026-06-18; design prerequisite for Goal 2, now implemented + live)
**Scope:** the db-host-v2 snapshot/restore flow — `soa/infra/src/ec2/profiles.js` (`snapshot_db` /
`download_profile_seed` / `list_s3_profiles`), the orchestrator pass-through (`iac` db_host_v2), and
the `saga-orch snapshot|restore` CLI.
**Complements (does NOT duplicate):** `microservices/services/switchboard/docs/snapshot-schema-versioning.md`
— that doc handles *schema-rev compatibility* (snapshot behind/ahead app migrations → auto-heal vs
hard-fail). THIS doc handles *artifact retention + rollback* (don't lose the prior snapshot on re-cut).
Orthogonal; both wanted.

## Problem

`snapshot_db` writes `s3://<bucket>/<name>/profile-<profile>.sql` and **overwrites in place**
(`profiles.js:7,23`). The seed bucket `saga-db-seeds-dev` has **S3 versioning OFF** (verified
2026-06-18: objects have `VersionId: null`, single version). So every canonical re-cut **destroys the
prior snapshot with no rollback** — a bad cut silently breaks every future sandbox that restores
`canonical`, and there's no way back to the last-known-good. This is the blocker that stopped the
Goal-2 fleet canonical re-cut: overwriting `profile-canonical.sql` is irreversible today.

## Goal

Make canonical re-cuts **non-destructive and rollback-able** with a **legible, by-number** scheme
(not opaque S3 version IDs), baked into the standard snapshot flow so every future re-cut is safe.

## Design

### Artifacts (S3 layout, per `<serviceName>/`)
```
profile-canonical-v1.sql        profile-canonical-v1.meta.json     ← immutable, never overwritten
profile-canonical-v2.sql        profile-canonical-v2.meta.json     ← each re-cut = a NEW number
profile-canonical.sql           profile-canonical.meta.json        ← "latest" pointer (= copy of newest vN)
```
- **Numbered files are immutable** — a re-cut only ever *adds* `v<N+1>`; old ones are retained.
- **`profile-canonical.sql` stays as the latest-pointer** — exactly what `download_profile_seed` reads
  today (`profiles.js:12`), so **restore is unchanged and backward-compatible** by default.
- `N` is derived by listing existing `profile-<profile>-v*.sql` and taking max+1 — no global counter,
  no DynamoDB dependency. First snapshot of a profile = `v1`.

### Sidecar (extend the existing `sidecarVersion:1` meta — `profiles.js:126-134`)
Add to `profile-<profile>-vN.meta.json` (and the pointer copy):
- `version: N` — the integer snapshot version (NEW)
- `supersedes: N-1 | null` — provenance chain (NEW)
- keep existing `schemaRev`, `takenAt`, `takenFromDb`, `profile`, `seedIdsVersion`, `appGitSha`.
(`version` here is the *artifact* number; `schemaRev` remains the *schema* token from the sibling doc —
distinct fields, distinct purposes.)

### `snapshot_db` change (`profiles.js`)
1. Dump as today.
2. Compute `N` = max existing `-vNN` for this profile + 1 (via `aws s3 ls <name>/profile-<profile>-v`).
3. Upload `profile-<profile>-v<N>.sql` (immutable) FIRST.
4. Write `profile-<profile>-v<N>.meta.json` (sidecar + `version:N`, `supersedes:N-1`).
5. Copy `v<N>` → `profile-<profile>.sql` + `.meta.json` (the latest-pointer) LAST (so the pointer never
   leads a missing artifact — mirrors the existing "upload dump before sidecar" ordering at :22).
   Return `{ s3Path, version:N, ... }`.

### Restore change (`download_profile_seed`) — additive, backward-compatible
- Default unchanged: `profile=canonical` → reads `profile-canonical.sql` (the pointer = latest). No
  caller change; existing composes keep working.
- NEW optional pin: `profile=canonical@v1` (or a `version` param) → reads `profile-canonical-v1.sql`.
  This is the **rollback path** — re-point a sandbox (or re-cut) at a prior known-good version.

### CLI / orchestrator
- `saga-orch snapshot` surfaces the assigned `version` in its response.
- `saga-orch restore --seed-profile canonical@v1` (or `--version 1`) for rollback.
- `saga-orch list-versions --service-name <svc> --seed-profile canonical` → enumerate `v1..vN` + their
  `takenAt`/`schemaRev` (extends `list_s3_profiles`).

### `list_s3_profiles` collision guard
The existing helper matches `profile-(.+)\.json$` and already had to dodge `*.meta.json` phantoms
(`profiles.js:29-30`). The new `-vN.meta.json` files must be excluded from the *profile* listing too
(they're versions of a profile, not profiles). Filter `-v\d+\.meta\.json$`.

## Migration / rollout
- **Backfill:** the current `profile-canonical.sql` (the stale pre-#419 cut) becomes `v1` for each
  service (one `s3 cp`), so history starts from the existing known state rather than orphaning it.
- **Backward compatibility:** old sandboxes/tooling that read `profile-canonical.sql` keep working
  unchanged — they always get latest. Only callers wanting rollback use the `@vN` form.
- **Retention:** keep all numbered versions for now (dumps are KB–MB); add a lifecycle/prune policy
  later if needed (out of scope).

## Why by-number over enabling S3 bucket versioning
S3 versioning would auto-retain overwrites, but versions are **opaque S3 IDs** — not enumerable as
`v1/v2/v3`, not self-describing, and rollback means juggling version-id strings. The by-number scheme
is **legible** (`canonical@v2`), self-documents in the sidecar (`version`/`supersedes`), and is visible
in a plain `s3 ls`. (Enabling bucket versioning as defense-in-depth is compatible and cheap, but it's
not the primary mechanism.)

## Then: Goal 2 runs under this flow
Once snapshot writes numbered versions: the canonical re-cut (load the validated synthetic-dev dumps →
`saga-orch snapshot --seed-profile canonical`) **automatically** produces `v2` while retaining the
stale `v1` — non-destructive, with `restore …canonical@v1` as instant rollback. See
`rebaseline-canonical-from-synthetic-dev.md` (the re-cut runbook) — it should be updated to assume this
versioned flow once built.

## Open questions
- **Pointer-copy vs. symlink/manifest:** copy is simplest + keeps restore a dumb `s3 cp`; a manifest
  (`profile-canonical.json` → `{latest: "v2"}`) is cleaner but changes the restore read. Recommend the
  copy for v1 of this feature (minimal restore change).
- **Per-version schemaRev gating:** ties into the sibling schema-versioning doc — a pinned `@vN` restore
  should still run that doc's behind/ahead/destructive gate against the app HEAD.
- **Mongo/MySQL profiles:** same numbering applies (engine-agnostic key scheme); sidecar stays
  postgres-only as today.
