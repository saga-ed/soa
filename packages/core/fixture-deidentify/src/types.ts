/**
 * Types for the fixture de-identification pipeline.
 *
 * The de-identifier produces a stable, deterministic FakeIdentity per real
 * `user_id`, then walks an in-memory mongo extraction payload and replaces
 * any PII field whose owning user is in the map.
 *
 * Determinism requirements:
 *   - Same `user_id` always maps to the same FakeIdentity, across runs and
 *     across MongoDB + MySQL sides of the same fixture.
 *   - No external state (Math.random, Date.now, faker) is allowed in the
 *     mapping itself. The hashing strategy is documented in identity-map.ts.
 */

/**
 * One synthesized identity to substitute for a real user. The `user_id`
 * field is preserved from the source — only display fields and credentials
 * are replaced.
 */
export interface FakeIdentity {
  /** Source MongoDB user_id (string). PRESERVED — never modified. */
  user_id: string;
  /** Same user_id parsed as a MySQL int, or null if it doesn't parse. */
  mysql_user_id: number | null;
  /** Fake first name from FIRST_NAMES. */
  first_name: string;
  /** Fake last name from LAST_NAMES. */
  last_name: string;
  /** "{first_name} {last_name}" — matches the real `screen_name` shape. */
  screen_name: string;
  /** `user_{user_id}@fixture.test`. */
  email: string;
  /**
   * MySQL `users.password` value: `sha1("saga." + user_id)`.
   * This is the same hash format the saga_api login flow uses
   * (`sha1("{password}.{user_id}")`), so logging in with password `saga`
   * succeeds against the de-identified fixture.
   */
  password_hash: string;
}

/**
 * Lookup map keyed two ways. MongoDB documents store `user_id` as a string,
 * MySQL rows as an int — both are needed during the apply walk.
 */
export interface DeidentifyMap {
  by_user_id: Map<string, FakeIdentity>;
  by_mysql_user_id: Map<number, FakeIdentity>;
}

/**
 * Serializable form of the map for inclusion in manifest.json.
 *
 * Maps don't survive JSON.stringify, so we flatten to an array of records
 * keyed by `user_id`. The verifier in Phase 4 reconstructs from this.
 */
export interface SerializedDeidentifyMap {
  version: 'deidentify-v1';
  identities: FakeIdentity[];
}

/**
 * Generic mongo collection payload shape consumed by the de-identifier.
 *
 * Callers (ads-adm-seed, iam-seed, pgm-seed) all keep richer payload types
 * for their own extraction; this shape is the structural minimum the walk
 * relies on, intentionally untyped on `documents` so it accepts either
 * `Array<Record<string, unknown>>` or a more specific document type.
 */
export interface MongoCollectionPayload {
  db: string;
  collection: string;
  documents: Array<Record<string, unknown>>;
}

export interface MongoExtractionPayload {
  collections: MongoCollectionPayload[];
}
