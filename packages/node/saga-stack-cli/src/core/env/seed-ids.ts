/**
 * Deterministic canonical seed-id derivation — a byte-exact reimplementation of
 * `@saga-ed/iam-seed-ids` (`rostering/packages/core/iam-seed-ids/src/derive.ts`)
 * for the `ss env` family (soa#355).
 *
 * Every canonical fixture UUID in the fleet is `uuidv5('<kind>:<slug>', ROOT_NAMESPACE)`.
 * Reimplemented here (node:crypto SHA-1; RFC 4122 v5 is implementation-independent)
 * instead of depending on the published package because saga-stack-cli deliberately
 * carries no registry dependencies beyond oclif — and the derivation IS the contract:
 * `seed-ids.unit.test.ts` byte-matches the canonical Empty Org id, so any drift from
 * the rostering package fails loudly.
 *
 * SAFETY ROLE: `ss env org` commands target orgs by catalog SLUG only; the UUID is
 * derived, never typed. An org id that this module cannot derive is not a fixture
 * org and is refused by default — that is the structural guard protecting the
 * hand-built training orgs from a mistyped target.
 */

import { createHash } from 'node:crypto';

/**
 * The fixed root namespace for ALL saga canonical seed ids (the contract value
 * from iam-seed-ids — NEVER change it; changing it re-randomizes every id).
 */
export const ROOT_NAMESPACE = 'b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c';

/** RFC 4122 v5 (SHA-1) UUID, byte-identical to iam-seed-ids' @noble/hashes version. */
export function uuidv5(name: string, namespace: string = ROOT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Uint8Array.prototype.slice.call(digest, 0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic UUID for a group (district/school/section) slug. */
export const deriveGroupId = (slug: string): string => uuidv5(`group:${slug}`);

/** Deterministic UUID for a user slug. */
export const deriveUserId = (slug: string): string => uuidv5(`user:${slug}`);

/** Deterministic UUID for the INITIAL seeded (user, group) membership row. */
export const deriveGroupMembershipId = (userId: string, groupId: string): string =>
  uuidv5(`group_membership:${userId}:${groupId}`);

/**
 * A resettable fixture org: the catalog entry `ss env org` commands accept.
 * Only orgs listed in `RESETTABLE_ORGS` may be targeted by slug; everything
 * else requires the unsafe escape hatch (and its typed-name confirm).
 */
export interface FixtureOrg {
  slug: string;
  displayName: string;
  orgId: string;
  adminSlug: string;
  adminEmail: string;
  adminUserId: string;
  adminMembershipId: string;
  /**
   * The org's SEEDED persona rows (fixed ids from iam-seed-ids `personas.ts`
   * — not uuidv5-derived). Part of the seed skeleton: `env org reset` keeps
   * them (and their cascaded permissions) by explicit NOT IN predicates.
   */
  seededPersonaIds: string[];
}

function fixtureOrg(
  slug: string,
  displayName: string,
  adminSlug: string,
  adminEmail: string,
  seededPersonaIds: string[],
): FixtureOrg {
  const orgId = deriveGroupId(slug);
  const adminUserId = deriveUserId(adminSlug);
  return {
    slug,
    displayName,
    orgId,
    adminSlug,
    adminEmail,
    adminUserId,
    adminMembershipId: deriveGroupMembershipId(adminUserId, orgId),
    seededPersonaIds,
  };
}

/**
 * The orgs `ss env org` will operate on, keyed by slug. Deliberately starts as
 * Empty Org ONLY — the org whose whole purpose is scratch/journey testing
 * ("district with an admin but NOTHING else", iam-seed-ids catalog). Growing
 * this list is a reviewed code change, not a runtime input.
 */
export const RESETTABLE_ORGS: Record<string, FixtureOrg> = {
  // Seeded personas: personaAdmin/Student/TutorEmptyOrg — fixed ids from
  // rostering/packages/core/iam-seed-ids/src/personas.ts (verified 2026-07-21).
  emptyOrg: fixtureOrg('emptyOrg', 'Empty Org', 'empty', 'empty@saga.org', [
    '00000000-0000-4000-a003-000000000021',
    '00000000-0000-4000-a003-000000000022',
    '00000000-0000-4000-a003-000000000023',
  ]),
};

/** Resolve a fixture org by slug; undefined for anything not in the catalog. */
export const resolveFixtureOrg = (slug: string): FixtureOrg | undefined => RESETTABLE_ORGS[slug];
