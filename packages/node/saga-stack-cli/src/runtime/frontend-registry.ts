/**
 * frontend-registry — the per-slot record of running `ss frontend` variants.
 *
 * `ss frontend up` upserts `<stateDir>/frontends.json` (label → {path,port,pid,slot})
 * so `ss frontend browser` can resolve a label to its `http://localhost:<port>` URL.
 * `ss stack down` clears it after reaping the `saga-dash@<label>` pidfiles. IO is
 * behind the injectable `FrontendRegistryIo` so the logic is unit-tested with no fs.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One running variant. */
export interface FrontendRecord {
  label: string;
  /** Absolute path to the variant's saga-dash checkout root. */
  path: string;
  port: number;
  pid: number;
  slot: number;
}

/** label → record. */
export type FrontendRegistry = Record<string, FrontendRecord>;

/** Injectable fs surface (defaulted to real `node:fs`). */
export interface FrontendRegistryIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
  remove(path: string): void;
}

/** Production fs surface. */
export function makeRealFrontendRegistryIo(): FrontendRegistryIo {
  return {
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    write: (p, c) => writeFileSync(p, c),
    remove: (p) => rmSync(p, { force: true }),
  };
}

/** Absolute path to a slot's registry file. */
export function frontendRegistryPath(stateDir: string): string {
  return join(stateDir, 'frontends.json');
}

/** Read the registry; `{}` when absent or unparseable (never throws). */
export function readRegistry(
  stateDir: string,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): FrontendRegistry {
  const raw = io.read(frontendRegistryPath(stateDir));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as FrontendRegistry) : {};
  } catch {
    return {};
  }
}

/** Insert/replace one label's record (2-space JSON + trailing newline). */
export function upsertRegistry(
  stateDir: string,
  record: FrontendRecord,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): void {
  const reg = readRegistry(stateDir, io);
  reg[record.label] = record;
  io.write(frontendRegistryPath(stateDir), `${JSON.stringify(reg, null, 2)}\n`);
}

/** Remove the registry file (idempotent). */
export function clearRegistry(
  stateDir: string,
  io: FrontendRegistryIo = makeRealFrontendRegistryIo(),
): void {
  io.remove(frontendRegistryPath(stateDir));
}
