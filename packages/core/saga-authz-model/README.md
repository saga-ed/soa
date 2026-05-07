# @saga-ed/saga-authz-model

Source of truth for Saga's OpenFGA authorization model. Ships:

- `model.fga` — the DSL file. **The model.** Everything else flows from this.
- `src/types.ts` — TypeScript constants mirroring the DSL types and relations.
- `src/tuple-keys.ts` — type-safe tuple-key builders.
- A unit test that asserts the DSL and the TS types agree (catches drift).

See [ADR 0005](../../../docs/auth/adr/0005-openfga-model-as-source-of-truth.md) for the governance model.

## Today

The package ships the model. **No FGA store is deployed yet** — services do not call `check` against this model in P1. The model lands ready for the sync worker (later phase) to begin writing tuples.

## Tomorrow

Once an FGA store is deployed:

1. The CI pipeline pushes `model.fga` to the FGA store; the returned `authorization_model_id` is recorded in SSM.
2. The sync worker (separate package) subscribes to `iam.*` events and writes tuples reflecting group/role/membership state.
3. Services adopt `check`/`list-objects` resource-by-resource alongside their existing RBAC checks.
4. RBAC is removed once parity is proven.

## Editing the model

1. Open a PR editing `model.fga` and `src/types.ts` in lockstep.
2. The unit test asserts they agree — CI will fail if you forget one.
3. Backwards-incompatible changes (renaming a relation, removing a type) require a coordinated rollout plan in the PR description.
4. Additive changes (new types, new relations) can land normally.
