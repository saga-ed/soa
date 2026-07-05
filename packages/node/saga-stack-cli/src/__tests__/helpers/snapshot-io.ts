/**
 * Shared fake `SnapshotIO` (M15-C test-harness consolidation).
 *
 * Unifies the two hand-rolled copies that lived in snapshot.int.test.ts and
 * checkpoint.int.test.ts: every call is recorded into the caller-owned
 * `ioCalls` array, and each "dump" writes a few canned bytes so the manifest /
 * sizes / validate gate stay REAL fs operations against the temp snapshots
 * root. No container, DB, or pg_dump/mongodump binary is ever touched.
 *
 * The load-bearing divergences between the old copies are EXPLICIT options —
 * pass them at every call site rather than leaning on the defaults:
 *
 * - `schemaRev` — what `readSchemaRev` reports for every migration DB.
 *   snapshot.int.test.ts passes its canned rev so the restore snapshot-ahead
 *   guard has a real rev to check; checkpoint.int.test.ts passes `null`,
 *   which keeps the schema-ahead guard INERT there (the guard has its own
 *   hard-guard coverage in snapshot.int.test.ts — the checkpoint suite owns
 *   the FLOW-level compat rules instead).
 * - `pgRestoreOk` — what `pgRestoreList` (validate --deep's per-dump check)
 *   answers; `false` simulates a corrupt dump.
 *
 * NOTE the fake captures the `ioCalls` ARRAY REFERENCE — reset it between
 * phases with `ioCalls.length = 0`, never by reassigning the variable.
 */

import { writeFileSync } from 'node:fs';
import type { SnapshotIO } from '../../runtime/index.js';

/** One recorded SnapshotIO call (superset of both suites' shapes). */
export interface SnapshotIOCall {
  op: string;
  db?: string;
  container?: string;
  ownerRole?: string;
  path?: string;
}

export function fakeSnapshotIO(opts: {
  /** Caller-owned recording array — the fake pushes every call into it. */
  ioCalls: SnapshotIOCall[];
  /** `readSchemaRev` answer; `null` (the default) keeps the schema-ahead guard inert. */
  schemaRev?: string | null;
  /** `pgRestoreList` answer (validate --deep); defaults to true (dump readable). */
  pgRestoreOk?: boolean;
}): SnapshotIO {
  const { ioCalls } = opts;
  return {
    async pgDump(db, container, ownerRole, outPath) {
      ioCalls.push({ op: 'pgDump', db, container, ownerRole, path: outPath });
      writeFileSync(outPath, `PGDUMP:${db}`);
    },
    async pgRestore(db, container, ownerRole, inPath) {
      ioCalls.push({ op: 'pgRestore', db, container, ownerRole, path: inPath });
    },
    async mongoDump(container, dbName, outPath) {
      ioCalls.push({ op: 'mongoDump', db: dbName, container, path: outPath });
      writeFileSync(outPath, `MONGO:${dbName}`);
    },
    async mongoRestore(container, dbName, inPath) {
      ioCalls.push({ op: 'mongoRestore', db: dbName, container, path: inPath });
    },
    async assertPgRunning(container) {
      ioCalls.push({ op: 'assertPgRunning', container });
    },
    async assertMongoRunning(container) {
      ioCalls.push({ op: 'assertMongoRunning', container });
    },
    async readSchemaRev(db, container) {
      ioCalls.push({ op: 'readSchemaRev', db, container });
      return opts.schemaRev ?? null;
    },
    async redisFlushdb(container) {
      ioCalls.push({ op: 'redisFlushdb', container });
    },
    async pgRestoreList(container, inPath) {
      ioCalls.push({ op: 'pgRestoreList', container, path: inPath });
      return opts.pgRestoreOk ?? true;
    },
  };
}
