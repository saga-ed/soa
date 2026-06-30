/**
 * The runtime barrel — the IO seam the M1 wrapper commands import from.
 *
 * Everything re-exported here may touch the OS (process spawn, fs existence,
 * HTTP): the injectable `Runner` + `makeRealRunner`, the injectable
 * `HealthProber` + `makeRealProber`, script-path resolution, and the
 * sibling-repo → env mapping. `src/core/**` must NEVER import this barrel
 * (core stays pure); commands compose `core` (planning) + `runtime` (execution).
 */

export * from './exec.js';
export * from './health.js';
export * from './scripts.js';
export * from './repos.js';
