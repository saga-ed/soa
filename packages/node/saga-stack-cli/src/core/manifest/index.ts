/**
 * The service manifest — assembled, deep-frozen, and exported as the one source
 * of truth for the stack topology (plan §2.2, saga-ed/soa#214).
 *
 * Consumers (`closure.ts`, `launch-order.ts`, `core/seed/`, the command layer)
 * import `manifest` and the helper getters from here. This module is PURE.
 */

import { DATABASES } from './databases.js';
import { MESH } from './mesh.js';
import { SERVICES } from './services.js';
import type { DatabaseDef, DbId, Manifest, MeshDef, MeshId, ServiceDef, ServiceId } from './types.js';

export type {
  DatabaseDef,
  DbId,
  DepKind,
  Engine,
  Lane,
  LaneTemplates,
  Manifest,
  MeshDef,
  MeshId,
  MigrateSpec,
  RepoKey,
  SeedStepRef,
  ServiceDef,
  ServiceId,
} from './types.js';
export { DATABASES } from './databases.js';
export { MESH } from './mesh.js';
export { SERVICES } from './services.js';

/** Recursively freeze an object graph so the manifest is immutable at runtime. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** The frozen, fully-populated manifest. */
export const manifest: Manifest = deepFreeze({
  services: SERVICES,
  databases: DATABASES,
  mesh: MESH,
});

/** Look up a service by id; throws on an unknown id (the union makes that a compile error for literals). */
export function getService(id: ServiceId, m: Manifest = manifest): ServiceDef {
  const svc = m.services[id];
  if (!svc) throw new Error(`unknown service id: ${id}`);
  return svc;
}

/** Look up a database by id; throws on an unknown id. */
export function getDb(id: DbId, m: Manifest = manifest): DatabaseDef {
  const db = m.databases[id];
  if (!db) throw new Error(`unknown database id: ${id}`);
  return db;
}

/** Look up a mesh unit by id; throws on an unknown id. */
export function getMesh(id: MeshId, m: Manifest = manifest): MeshDef {
  const unit = m.mesh[id];
  if (!unit) throw new Error(`unknown mesh id: ${id}`);
  return unit;
}

/** All service defs (declaration order). */
export function allServices(m: Manifest = manifest): ServiceDef[] {
  return Object.values(m.services);
}

/** All database defs (declaration order). */
export function allDatabases(m: Manifest = manifest): DatabaseDef[] {
  return Object.values(m.databases);
}

/** All mesh-unit defs (declaration order). */
export function allMesh(m: Manifest = manifest): MeshDef[] {
  return Object.values(m.mesh);
}
