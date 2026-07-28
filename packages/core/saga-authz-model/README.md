# @saga-ed/saga-authz-model

Source of truth for Saga's OpenFGA authorization model. Ships:

- `model.fga` — the DSL file. **The model.** Everything else flows from this.
- `src/types.ts` — TypeScript constants mirroring the DSL types and relations.
- `src/tuple-keys.ts` — type-safe tuple-key builders.
- Unit tests that compile the DSL through the OpenFGA transformer (proving it
  would load into a store) and assert it agrees with the TS types (catches drift).

See [ADR 0005](../../../docs/auth/adr/0005-openfga-model-as-source-of-truth.md) for the governance model.

## Today

The package ships the model. **No FGA store is deployed yet** — services do not call `check` against this model in P1. The model lands ready for the sync worker (later phase) to begin writing tuples.

## Tomorrow

Once an FGA store is deployed:

1. The CI pipeline pushes `model.fga` to the FGA store; the returned `authorization_model_id` is recorded in SSM.
2. The sync worker (separate package) subscribes to `iam.*` events and writes tuples reflecting group/role/membership state.
3. Services adopt `check`/`list-objects` resource-by-resource alongside their existing RBAC checks.
4. RBAC is removed once parity is proven.

## Session hosting (pod / persona / pgrant)

A tutor attaches to a **pod**, not to a session — program-hub's `tutoring_session`
table has no owner column at all. So session hosting resolves *through* the pod:

```
session.host      = [user] or tutor from pod      # relationship branch
session.edit_grant = edit_non_hosted from parent  # delegation branch
session.can_edit   = host or edit_grant
```

The two branches stay **separable relations on purpose**: `checkDetailed(user,
['host','edit_grant'], session)` attributes D19 actor `HOST` vs `ADMIN`, which is
what program-hub stamps into `cancellationActor`. Never collapse them into one
OR'd relation — attribution is lost and the audit column goes wrong.

Delegation is a **group-scoped persona capability**, never a direct grant:

```
persona.grants_* ─→ pgrant (subject AND grants_*) ─→ group ─→ program.grant_group ─→ session.edit_grant
```

`persona` is a first-class type *because* `authz_persona_definition.permissions[]`
is mutable — revoking a capability is one tuple on the persona object, rather than
a fleet-wide rewrite of every derived assignment tuple.

⚠️ Two invariants in that chain are load-bearing, and both are pinned by tests:

- **`pgrant`'s `and` must never become `or`.** `persona.grants_*` is a `[user:*]`
  public wildcard, so the union form confers the capability on *every user in the
  store*. The intersection with `subject` is the only thing binding it to that
  assignment's user.
- **The spine is FLAT — no group ancestor cascade.** program-hub enumerates
  `programGrantGroupIds` (org group + school groups) and does a flat `groupId IN
  (...)` test, explicitly "not a hierarchy crawl". A `from parent_group` edge would
  grant edits that `callerHoldsGrant` denies.

Writing `persona.grants_*` is the highest-privilege tuple write in this model —
district-agnostic, and one flip changes every holder fleet-wide.

### Notes for whoever writes the tuples (not written today)

- **`session.pod` is the EFFECTIVE pod**, resolved from
  `pod_assignment_override(slotId, date)`: `SWAP` → the swapped-in pod; `ABSENT` →
  write **no** pod tuple and no direct `host` tuples; otherwise the default pod.
  ⚠️ The sessionId encodes the **default** podId and the override row is keyed on
  it independent of any SWAP — resolve the pod, never parse it out of the id.
- **`pod.parent`** is a two-hop lookup, not a column: a pod carries `periodId`/`cohortId`
  and the program comes via `PeriodProjection.programId` (non-null, but soft-deletable
  via `deletedAt`). Re-resolve it when `Pod.rotation` changes re-point `PodAssignment` —
  a missing `pod.parent` tuple silently denies `can_create_session`.
- **`pod.tutor`** comes from `pod_tutor_projection` (1:N, **interval-modeled**), not
  programs-api's `PodTutor` table (1:1 — using it silently loses multi-tutor pods).
  FGA tuples are at-now, so the writer must re-run on interval boundaries (a timer,
  not only an event handler).
- **The direct `[user]` branch of `host`** is the per-occurrence override host
  (`session_instance_override.hostIds`). It is *additive* — it never revokes the base
  tutor. Gate it on live period membership **and retract on whole-user deactivation**,
  because `period_membership` does not close on deactivation.
- `ABSENT` suppresses only the **host** branch; a grant holder still passes `can_edit`,
  matching sessions-api checking `holdsGrant` outside its effective-pod guard.

## The occurrence layer (`session_instance`)

A `session_instance` is a **dated occurrence** of a repeating session — the layer
program-hub's per-day facts live at (`pod_assignment_override` SWAP/ABSENT,
`session_instance_override.hostIds`, participant deltas). Instances are **lazy**:
an object carries tuples only when a per-day fact was *authored*; default days
resolve straight through the `session` edge, so there is no per-day tuple fan-out.

```
base_host = host from session but not pod_overridden   # marker removes the base arm
host      = override_host or tutor from override_pod or base_host
member    = added_participant or member from override_pod or base_member
```

- **Override REPLACES, never unions.** The `pod_overridden: [user:*]` wildcard
  marker suppresses the base arm; `override_pod` supplies the swap-day pod (pods
  carry rosters via `pod.member`, so swap-day membership comes with it). ⚠️ The
  marker and `override_pod` MUST be written in the **same authoring action** —
  they are one fact. A marker alone is an ABSENT day; an `override_pod` alone
  would silently union base ∪ swapped pods.
- **`override_host` / `added_participant` are additive** — they never revoke the
  resolved base, matching `session_instance_override.hostIds` semantics.
- **Grants pass through the `session` edge only** — an overridden or ABSENT day
  still admits grant holders, and the D19 arm separability (HOST vs ADMIN
  attribution) holds at the instance level too. The gates mirror the session's
  arm structure: `can_edit`/`can_observe`/`can_view`/`can_lifecycle`.

These semantics have runnable-evidence backing: rostering's prototype slice
(`scripts/fga/prototype/session-instance-slice.fga.yaml`, landed in
[rostering#883](https://github.com/saga-ed/rostering/pull/883)) exercises the
same shapes against a real store via `fga model test` — swap-day replacement,
added-participant days, grant-vs-host separability, see-all reads — 8/8 green.
This package pins the structure with transformer-based tests (no store harness
ships in this repo).

## View / lifecycle capabilities

Two more capabilities ride the same persona → pgrant → group →
`program.grant_group` spine, in the same shape as `edit_non_hosted`/`observe`:

| Capability | Permission string (sessions-api) | Session gate |
|---|---|---|
| `view_non_member` | `sessions:view_non_member_sessions` (see-all reads) | `can_view = host or participant or view_grant` |
| `lifecycle_non_hosted` | `sessions:lifecycle_non_hosted_sessions` (start/end/cancel takeover) | `can_lifecycle = host or lifecycle_grant` |

Both inherit the spine's invariants (the `pgrant` intersection, the flat
no-cascade rule) and stay separable from `host` for D19 attribution. The legacy
`viewer`/`can_join` relations are untouched — `can_view` is the new
vocabulary-aligned gate, not a replacement.

## Editing the model

1. Open a PR editing `model.fga` and `src/types.ts` in lockstep.
2. The unit test asserts they agree — CI will fail if you forget one. Relations are
   checked too, via the `FGA_RELATIONS` runtime mirror: adding a relation to the DSL
   without mirroring it (or vice versa) fails the build.
3. Backwards-incompatible changes (renaming a relation, removing a type) require a
   coordinated rollout plan in the PR description.
4. Additive changes (new types, new relations) can land normally. **Widening an
   existing relation's union** (e.g. `host: [user]` → `host: [user] or tutor from pod`)
   is *monotonic* — existing tuples stay valid and checks only broaden — so it lands
   the same way; but state the intended blast radius, since computed relations that
   consume it (`viewer`, `can_join`, `whiteboard.editor`, `room.can_join`) widen too.
