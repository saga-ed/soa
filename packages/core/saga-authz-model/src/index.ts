/**
 * @saga-ed/saga-authz-model
 *
 * Source of truth for the Saga fleet OpenFGA model. The .fga DSL ships
 * alongside the package; this index re-exports type-safe tuple-key
 * builders and the canonical type/relation constants.
 *
 * Per ADR 0005, services do not write tuples directly — the sync worker
 * does. Services use the helpers here only to construct tuple keys for
 * `check`/`list-objects`.
 */

export * from './types.js';
export * from './tuple-keys.js';
