/**
 * Fixture definition loader — single source of truth for fixture identity.
 *
 * A fixture-id (e.g., 'adm-combined') resolves to a definition.json under
 * mesh-fixture-cli/fixtures/<id>/ that declares the orgs, programs, date
 * range, and prod-mirror source. The 3 seeders (iam-seed, pgm-seed,
 * ads-adm-seed) import loadFixtureDefinition() from here instead of
 * duplicating hardcoded TARGETS arrays.
 *
 * Distinct from SnapshotManifest in snapshot-store.ts (snapshot metadata
 * under ~/.saga-mesh/snapshots/) and the per-service fixture.registry.*
 * tRPC surface in lib/registry.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';

// dist/lib/load-fixture-definition.js → ../../fixtures resolves to package
// root. Works both for the soa workspace (compiled output in dist/) and
// when consumed via workspace-link from another repo (same relative shape).
const FIXTURES_SOURCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
);

const ProgramSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
});

const OrgSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  timezone: z.string().min(1),
  programs: z.array(ProgramSchema).min(1),
});

const ProdMirrorSourceSchema = z.object({
  mongoUri: z.string().regex(/^mongodb(\+srv)?:\/\//),
  sagaDbName: z.string().min(1),
  arsDbName: z.string().min(1),
});

const DateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const FixtureDefinitionSchema = z.object({
  fixtureId: z.string().min(1),
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  prodMirrorSource: ProdMirrorSourceSchema,
  dateRange: DateRangeSchema,
  orgs: z.array(OrgSchema).min(1),
});

export type FixtureDefinition = z.infer<typeof FixtureDefinitionSchema>;
export type FixtureOrg = z.infer<typeof OrgSchema>;
export type FixtureProgram = z.infer<typeof ProgramSchema>;

export function fixtureDefinitionPath(fixtureId: string): string {
  return join(FIXTURES_SOURCE_DIR, fixtureId, 'definition.json');
}

export function loadFixtureDefinition(fixtureId: string): FixtureDefinition {
  const path = fixtureDefinitionPath(fixtureId);
  if (!existsSync(path)) {
    throw new Error(
      `Fixture definition not found: ${path}\n` +
        `Available fixtures live under ${FIXTURES_SOURCE_DIR}.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Fixture definition is not valid JSON: ${path}\n${(err as Error).message}`,
    );
  }
  const result = FixtureDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Fixture definition schema mismatch in ${path}:\n${result.error.message}`,
    );
  }
  if (result.data.fixtureId !== fixtureId) {
    throw new Error(
      `Fixture-id mismatch: requested '${fixtureId}', file declares '${result.data.fixtureId}' (${path})`,
    );
  }
  return result.data;
}

export function fixtureOrgIds(def: FixtureDefinition): string[] {
  return def.orgs.map((o) => o.id);
}

export function fixtureProgramIds(def: FixtureDefinition): string[] {
  return def.orgs.flatMap((o) => o.programs.map((p) => p.id));
}

/**
 * Fixed namespace UUID used to deterministically derive iam_local.User.id
 * UUIDs from prod-mirror numeric user_ids. Stable across seeders so that
 * iam-seed (rostering) + ads-adm-seed (student-data-system) write the
 * SAME UUID for the same prod-mirror user — making FK joins from
 * ads_adm_local.iam_user_id → iam_local.users.id resolve.
 *
 * Distinct from PR #77's `apps/node/fixtures/src/deterministic.ts`
 * namespace; this one belongs to the saga-mesh prod-mirror anchor.
 */
const PROD_MIRROR_USER_NAMESPACE = '4e6f9b8c-6e75-5e4d-b1a3-3c0e8f2c4d10';

/**
 * Derive a deterministic iam User UUID from a prod-mirror numeric user_id.
 *
 *   uuidForProdMirrorUser('287')  // always produces the same UUID
 *
 * Both rostering's iam-seed and student-data-system's ads-adm-seed call
 * this so adm_attendance.iam_user_id round-trips to iam_local.users.id.
 *
 * Originally lived in rostering/packages/node/iam-seed/src/uuid-derive.ts
 * (and still exists there for backward compat); promoted to this shared
 * library 2026-04-26 when ads-adm-seed needed the same conversion to
 * close the cross-seeder ID drift gap.
 */
export function uuidForProdMirrorUser(prodMirrorUserId: string): string {
  return uuidv5(`adm-combined/${prodMirrorUserId}`, PROD_MIRROR_USER_NAMESPACE);
}
