/**
 * @saga-ed/seed-ids-kit — the shared mechanism behind the `*-seed-ids` contract.
 *
 * Canonical, deterministic entity ids let independent service seeds agree on the
 * same UUIDs with no shared database. Historically each domain hand-rolled the
 * same machinery (a derivation function, a drift test, sometimes a frozen
 * `ids.ts` + codegen). This kit factors out the parts that are genuinely the
 * same, leaving each domain to own only its catalog and its choice of strategy:
 *
 *   - `uuidv5`                     browser-safe v5 (no node:crypto)
 *   - `makeHashDeriver`           order-independent hash strategy (new domains)
 *   - `makePositionDeriver`       position-suffix strategy (preserve a scheme)
 *   - `checkSeedIdContract`       (from `/contract`) the reusable drift/value-lock test
 *
 * It is opt-in: a package adds it as a dependency when convenient. It does NOT
 * own any catalog or any id values — those stay in each domain's repo. See the
 * recipe in the saga-iac plugin's `seed-fixtures.md`.
 */
export { uuidv5 } from './uuid.js';
export { makeHashDeriver, makePositionDeriver } from './derivers.js';
export {
  checkSeedIdContract,
  type SeedIdCollection,
  type ContractResult,
  type UuidShape,
} from './contract.js';
