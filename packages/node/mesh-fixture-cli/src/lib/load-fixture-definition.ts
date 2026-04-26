/**
 * Fixture definition loader — single source of truth for fixture identity.
 *
 * A fixture-id (e.g., 'adm-combined') resolves to a definition.json under
 * mesh-fixture-cli/fixtures/<id>/ that declares the orgs, programs, date
 * range, and prod-mirror source. The 3 seeders (iam-seed, pgm-seed,
 * ads-adm-seed) import loadFixtureDefinition() from here instead of
 * duplicating hardcoded TARGETS arrays.
 *
 * Distinct from FixtureManifest in fixture-store.ts (snapshot metadata
 * under ~/.saga-mesh/fixtures/) and the per-service fixture.registry.*
 * tRPC surface in lib/registry.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
