/**
 * `ss stack hydrate` pure core — the mirror→local database map, the SQL
 * vocabulary, and the planner that turns a source description into the exact
 * argv + statements the executor runs.
 *
 * PURE: zero IO. Nothing here imports `src/runtime/**`.
 */

export * from './databases.js';
export * from './sql.js';
export * from './plan.js';
