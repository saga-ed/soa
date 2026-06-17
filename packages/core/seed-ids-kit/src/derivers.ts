/**
 * The two deterministic-id strategies the fleet uses, as one-liner factories.
 *
 * They are NOT interchangeable and must not be unified: each encodes ids that
 * are already persisted in a domain's database. Pick by the situation:
 *
 *   - new domain, no legacy ids   -> makeHashDeriver  (order-independent)
 *   - preserving an existing scheme -> makePositionDeriver (keeps the numbers)
 */
import { uuidv5 } from './uuid.js';

/**
 * Hash strategy (rostering `iam-seed-ids`). `derive(key)` = `uuidv5(key, root)`.
 *
 * Order-independent: any service computes the same id from a stable key, with
 * no catalog order, no shared database, and no network call. `rootNamespace`
 * IS the contract — changing it re-randomizes every id. Prefer this for new
 * domains. `key` is conventionally `"<kind>:<slug>"` (e.g. `group:lincoln`).
 */
export function makeHashDeriver(rootNamespace: string): (key: string) => string {
  return (key: string): string => uuidv5(key, rootNamespace);
}

/**
 * Position-suffix strategy (program-hub `program-seed-ids` / `content-seed-ids`).
 * `derive(n)` = `${namespacePrefix}${pad(n)}`.
 *
 * Pure formatting, no crypto. Use ONLY to reproduce an EXISTING hand-assigned
 * scheme so persisted data is not orphaned — never for a fresh domain.
 * `namespacePrefix` must include its trailing separator, e.g.
 * `'a1b2c3d4-0001-4000-8000-'`; `n` is the 1-based position.
 */
export function makePositionDeriver(
  namespacePrefix: string,
  padWidth = 12,
): (n: number) => string {
  return (n: number): string => `${namespacePrefix}${String(n).padStart(padWidth, '0')}`;
}
