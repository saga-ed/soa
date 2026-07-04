/**
 * The pure-core public API — the single import surface the command layer, the
 * in-process `stack-api`, and the e2e topic consume. Everything re-exported
 * here is PURE (zero IO): the frozen manifest + its types and getters, the
 * dependency-closure engine, the launch-order waver, and the `want_service`
 * gate.
 *
 * The `seed/` and `flow/` sub-barrels are owned by the seed/flow vertical; they
 * are re-exported here from their planned paths so consumers get one core entry
 * point. (If a sub-barrel is not yet present in a partial checkout, drop its
 * line — the four core modules above stand alone.)
 */

export * from './manifest/index.js';
export * from './closure.js';
export * from './launch-order.js';
export * from './launch-plan.js';
export * from './want-service.js';
export * from './flag-map.js';
export * from './e2e-map.js';
export * from './probe-plan.js';
export * from './overlay-plan.js';
export * from './overlay-tsv.js';

// Owned by the seed/flow vertical — planned core sub-barrels (plan §2.1, §4, §5).
export * from './seed/index.js';
export * from './flow/index.js';

// Native snapshot fast-path — per-snapshot manifest + pure planners (plan §4.3, M3).
export * from './snapshot/index.js';
