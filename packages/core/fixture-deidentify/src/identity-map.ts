/**
 * Stable identity map builder for fixture de-identification.
 *
 * Determinism strategy
 * --------------------
 * For a given `user_id`, the FakeIdentity is computed purely from the
 * user_id string and a fixed pool. No external state, no random number
 * generators, no Date.now. The same user_id ALWAYS yields the same
 * FakeIdentity, across runs and across different machines.
 *
 *   seed_input  = "deidentify-v1:" + user_id
 *   hash        = sha1(seed_input).hex
 *   first_idx   = parseInt(hash[0..8],   16) % FIRST_NAMES.length
 *   last_idx    = parseInt(hash[8..16],  16) % LAST_NAMES.length
 *   first_name  = FIRST_NAMES[first_idx]
 *   last_name   = LAST_NAMES[last_idx]
 *   screen_name = `${first_name} ${last_name}`
 *   email       = `user_${user_id}@fixture.test`
 *   password    = sha1(`saga.${user_id}`).hex
 *
 * The `deidentify-v1:` prefix is a versioning hook. If the algorithm ever
 * changes (different pool, different hash, different field shape) bump the
 * prefix so old fixture snapshots can be detected by their stored map.
 *
 * Why sha1 and not sha256? Speed and determinism — both are deterministic,
 * but sha1 is what saga_api uses for password hashing, so this code stays
 * dependency-light (single hash family) and the password format already
 * has to be sha1 to interoperate with auth_helper.ts.
 */

import { createHash } from 'crypto';
import { FIRST_NAMES, LAST_NAMES } from './fake-names.js';
import type { DeidentifyMap, FakeIdentity } from './types.js';

const VERSION_PREFIX = 'deidentify-v1:';

/**
 * Build a stable de-identification map for the given list of user_ids.
 *
 * Input order does not matter — the function de-duplicates and sorts
 * internally so the resulting map is byte-stable across re-runs.
 *
 * @param user_ids string-form user_ids from the extraction scope
 * @returns a DeidentifyMap keyed by both string and (where parseable) int
 */
export function buildIdentityMap(user_ids: readonly string[]): DeidentifyMap {
  const unique = [...new Set(user_ids)].sort();
  const by_user_id = new Map<string, FakeIdentity>();
  const by_mysql_user_id = new Map<number, FakeIdentity>();

  for (const uid of unique) {
    const identity = generateFakeIdentity(uid);
    by_user_id.set(uid, identity);
    if (identity.mysql_user_id !== null) {
      by_mysql_user_id.set(identity.mysql_user_id, identity);
    }
  }

  return { by_user_id, by_mysql_user_id };
}

/**
 * Compute a single FakeIdentity from a user_id. Exposed for tests; in
 * normal use call `buildIdentityMap` once and look up against the map.
 */
export function generateFakeIdentity(user_id: string): FakeIdentity {
  const hash = sha1Hex(VERSION_PREFIX + user_id);
  const first_idx = parseInt(hash.slice(0, 8), 16) % FIRST_NAMES.length;
  const last_idx = parseInt(hash.slice(8, 16), 16) % LAST_NAMES.length;
  const first_name = FIRST_NAMES[first_idx]!;
  const last_name = LAST_NAMES[last_idx]!;
  const screen_name = `${first_name} ${last_name}`;
  const email = `user_${user_id}@fixture.test`;
  const password_hash = sha1Hex(`saga.${user_id}`);

  // MongoDB user_id is the string form of the MySQL int. parseInt with the
  // round-trip check matches the existing fixture-builder/extractor pattern.
  const parsed = Number.parseInt(user_id, 10);
  const mysql_user_id =
    Number.isNaN(parsed) || String(parsed) !== user_id ? null : parsed;

  return {
    user_id,
    mysql_user_id,
    first_name,
    last_name,
    screen_name,
    email,
    password_hash,
  };
}

/**
 * Compute the hashed password value the saga_api login flow expects when
 * the plaintext password is `saga`. Used by the MySQL transformer for
 * the `users.password` column.
 */
export function passwordHashForUserId(user_id: string | number): string {
  return sha1Hex(`saga.${user_id}`);
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
