/**
 * The snapshot IO seam (plan §4.3 + §7.2 "M3 — Native snapshot fast-path").
 *
 * `stack snapshot store|restore|...` dump/restore the stack's databases through
 * the postgres/mongo client tools that already live INSIDE the mesh containers
 * (`docker exec soa-postgres-1 pg_dump …`), so the host needs neither pg_dump
 * nor mongodump installed. That container/process IO is the one thing the
 * snapshot commands can't keep pure, so it lives behind this injectable
 * `SnapshotIO` — mirroring the `Runner` process seam (exec.ts) and the
 * `HealthProber` HTTP seam (health.ts).
 *
 * Production wires `makeRealSnapshotIO()` (the ONLY place `docker exec
 * pg_dump/pg_restore/mongodump/mongorestore/psql/redis-cli` is launched); the
 * M3 snapshot TESTS substitute a fake (via `BaseCommand.prototype.getSnapshotIO`)
 * that records the calls and returns canned bytes/strings — so the
 * store/restore/list/validate logic is asserted WITHOUT a real container, DB, or
 * dump file. This logic is PORTED from mesh-fixture-cli's lib/postgres.ts
 * (custom-format dumps, stdin-streamed restores, ERROR/FATAL stderr scanning),
 * rebuilt to (a) drive the DB set from OUR manifest — all 9 pg app DBs + the
 * connectv3 mongo DB, not mesh-fixture's stale 6 — and (b) restore each pg DB AS
 * ITS OWNER (snapshot invariant: ledger_local's owner is `ledger`, NOT ads_adm).
 *
 * INVARIANT (plan hard constraint): process/container IO lives only in
 * `src/runtime/**`; `src/core/**` never imports this and stays pure. Container
 * names + storage layout are resolved in `./snapshot-store.ts` (env + manifest,
 * no spawning) and passed in here explicitly so a fake can assert on them.
 */

import { spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync } from 'node:fs';

/**
 * The postgres role `docker exec … psql/pg_isready` connect as for
 * ADMIN-level operations (readiness ping + the `_prisma_migrations` head query).
 * Per-DB dump/restore connect as the DB *owner* instead (restore invariant).
 * Overridable for non-default mesh provisioning.
 */
export const POSTGRES_ADMIN_USER =
  process.env.SAGA_MESH_POSTGRES_ADMIN_USER ?? 'postgres_admin';

/**
 * The injectable snapshot-IO seam. Every method names its target container
 * EXPLICITLY (resolved by the caller from the manifest + env in
 * `snapshot-store.ts`) so a fake can assert the exact container/db/role/path it
 * was handed — no hidden globals. A real implementation spawns `docker exec`;
 * a fake records the call.
 */
export interface SnapshotIO {
  /**
   * `docker exec <container> pg_dump -F c -U <ownerRole> <db>` → `outPath`
   * (custom format, so `pg_restore --clean --if-exists` can selectively drop
   * and reload). Dumps AS THE OWNER so the dump's OWNER TO directives match the
   * role that restore reconnects as. Rejects on a non-zero pg_dump exit.
   */
  pgDump(db: string, container: string, ownerRole: string, outPath: string): Promise<void>;

  /**
   * `docker exec -i <container> pg_restore -U <ownerRole> -d <db> --clean
   * --if-exists` with `inPath` streamed via stdin (no shared host↔container
   * volume needed). Connects AS THE DB OWNER (snapshot invariant — ledger_local
   * → `ledger`). pg_restore exits non-zero on benign warnings too, so a non-zero
   * exit is only treated as failure when stderr carries a real `ERROR:`/`FATAL:`.
   */
  pgRestore(db: string, container: string, ownerRole: string, inPath: string): Promise<void>;

  /**
   * `docker exec <container> mongodump --archive --db=<dbName>` → `outPath`
   * (single-file archive). Rejects on a non-zero exit.
   */
  mongoDump(container: string, dbName: string, outPath: string): Promise<void>;

  /**
   * `docker exec -i <container> mongorestore --archive --drop
   * --nsInclude=<dbName>.*` with `inPath` streamed via stdin. `--drop` clears the
   * target collections first (idempotent restore-over). Rejects on a non-zero exit.
   */
  mongoRestore(container: string, dbName: string, inPath: string): Promise<void>;

  /**
   * Best-effort readiness ping: throws a clear, actionable error if the postgres
   * container isn't up (so store/restore fail fast with a "bring the mesh up"
   * hint rather than a cryptic docker error mid-dump).
   */
  assertPgRunning(container: string): Promise<void>;

  /** Best-effort readiness ping for the connect mongo container (see assertPgRunning). */
  assertMongoRunning(container: string): Promise<void>;

  /**
   * The head of `_prisma_migrations` (latest applied `migration_name`) for the
   * snapshot-ahead guard. Connects as the admin role. Returns `null` when the
   * table is absent — i.e. db-push DBs with no migration history (iam_pii_local)
   * or any query failure — so the caller treats "no rev" as "skip the guard"
   * rather than an error. Callers SKIP this entirely for db-push/mongo DBs.
   */
  readSchemaRev(db: string, container: string): Promise<string | null>;

  /**
   * `docker exec <container> redis-cli FLUSHDB` — optional post-restore cache
   * invalidation (rostering caches in redis; see mesh-fixture PR #82). Gated by a
   * command flag, NOT run unconditionally. Rejects on a non-zero exit.
   */
  redisFlushdb(container: string): Promise<void>;

  /**
   * `docker exec -i <container> pg_restore --list` with `inPath` streamed via
   * stdin — the `validate --deep` structural check. Returns `true` iff pg_restore
   * could parse the archive's table-of-contents (i.e. the dump is a readable,
   * well-formed custom-format archive), `false` on any failure. NEVER throws: a
   * corrupt dump is a `false` verdict, not an error. Needs the postgres container
   * running (for the pg_restore binary); the command asserts that under `--deep`.
   */
  pgRestoreList(container: string, inPath: string): Promise<boolean>;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `docker <args>`, optionally streaming a file in (stdin) or out (stdout).
 * stderr (and stdout when not file-bound) are captured to strings. The single
 * choke-point through which every real container process is launched.
 */
function runDocker(
  args: string[],
  opts: { stdoutToFile?: string; stdinFromFile?: string; captureStdout?: boolean } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdoutFd: number | undefined;
    let stdoutMode: 'ignore' | 'pipe' | number = opts.captureStdout ? 'pipe' : 'ignore';
    if (opts.stdoutToFile) {
      stdoutFd = openSync(opts.stdoutToFile, 'w');
      stdoutMode = stdoutFd;
    }

    const proc = spawn('docker', args, {
      stdio: [opts.stdinFromFile ? 'pipe' : 'ignore', stdoutMode, 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const closeFd = (): void => {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
    };

    if (opts.stdinFromFile && proc.stdin) {
      const src = createReadStream(opts.stdinFromFile);
      src.on('error', (err) => {
        closeFd();
        reject(err);
      });
      src.pipe(proc.stdin);
    }

    proc.on('error', (err) => {
      closeFd();
      reject(err);
    });
    proc.on('exit', (code) => {
      closeFd();
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** True iff a container of EXACTLY this name is running (docker ps name filter). */
async function isContainerRunning(container: string): Promise<boolean> {
  try {
    const { stdout } = await runDocker(
      ['ps', '--filter', `name=^${container}$`, '--format', '{{.Names}}'],
      { captureStdout: true },
    );
    return stdout.trim() === container;
  } catch {
    return false;
  }
}

/**
 * The production SnapshotIO: every method shells out via `docker exec`. This is
 * the one place real container/DB processes are launched. Tests never call this
 * — they inject a fake through `BaseCommand.getSnapshotIO()`.
 */
export function makeRealSnapshotIO(): SnapshotIO {
  return {
    async pgDump(db, container, ownerRole, outPath): Promise<void> {
      const { exitCode, stderr } = await runDocker(
        ['exec', container, 'pg_dump', '-U', ownerRole, '-d', db, '-F', 'c'],
        { stdoutToFile: outPath },
      );
      if (exitCode !== 0) {
        throw new Error(`pg_dump ${db} → ${outPath} failed (exit=${exitCode}).\n${stderr}`);
      }
    },

    async pgRestore(db, container, ownerRole, inPath): Promise<void> {
      const { exitCode, stderr } = await runDocker(
        ['exec', '-i', container, 'pg_restore', '-U', ownerRole, '-d', db, '--clean', '--if-exists'],
        { stdinFromFile: inPath },
      );
      // pg_restore returns non-zero on benign warnings too (e.g. "object didn't
      // exist, skipping" under --if-exists). Only a real ERROR:/FATAL: in stderr
      // is a failure; otherwise surface warnings and continue.
      if (exitCode !== 0 && /^\s*(ERROR|FATAL):/m.test(stderr)) {
        throw new Error(`pg_restore ${db} failed (exit=${exitCode}).\n${stderr}`);
      }
      if (stderr) process.stderr.write(stderr);
    },

    async mongoDump(container, dbName, outPath): Promise<void> {
      const { exitCode, stderr } = await runDocker(
        ['exec', container, 'mongodump', '--archive', `--db=${dbName}`],
        { stdoutToFile: outPath },
      );
      if (exitCode !== 0) {
        throw new Error(`mongodump ${dbName} → ${outPath} failed (exit=${exitCode}).\n${stderr}`);
      }
    },

    async mongoRestore(container, dbName, inPath): Promise<void> {
      const { exitCode, stderr } = await runDocker(
        ['exec', '-i', container, 'mongorestore', '--archive', '--drop', `--nsInclude=${dbName}.*`],
        { stdinFromFile: inPath },
      );
      if (exitCode !== 0) {
        throw new Error(`mongorestore ${dbName} failed (exit=${exitCode}).\n${stderr}`);
      }
    },

    async assertPgRunning(container): Promise<void> {
      if (!(await isContainerRunning(container))) {
        throw new Error(
          `postgres container '${container}' is not running.\n` +
            `  Bring the mesh up first (e.g. saga-stack stack up), then retry.`,
        );
      }
    },

    async assertMongoRunning(container): Promise<void> {
      if (!(await isContainerRunning(container))) {
        throw new Error(
          `connect mongo container '${container}' is not running.\n` +
            `  Bring the mesh up first (e.g. saga-stack stack up), then retry.`,
        );
      }
    },

    async readSchemaRev(db, container): Promise<string | null> {
      try {
        const { exitCode, stdout } = await runDocker(
          [
            'exec',
            container,
            'psql',
            '-U',
            POSTGRES_ADMIN_USER,
            '-d',
            db,
            '-tAc',
            'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
          ],
          { captureStdout: true },
        );
        if (exitCode !== 0) return null; // table absent (db-push) / query failed
        const rev = stdout.trim();
        return rev.length > 0 ? rev : null;
      } catch {
        return null;
      }
    },

    async redisFlushdb(container): Promise<void> {
      const { exitCode, stderr } = await runDocker(['exec', container, 'redis-cli', 'FLUSHDB'], {
        captureStdout: true,
      });
      if (exitCode !== 0) {
        throw new Error(`redis-cli FLUSHDB on '${container}' failed (exit=${exitCode}).\n${stderr}`);
      }
    },

    async pgRestoreList(container, inPath): Promise<boolean> {
      try {
        const { exitCode } = await runDocker(
          ['exec', '-i', container, 'pg_restore', '--list'],
          { stdinFromFile: inPath, captureStdout: true },
        );
        return exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}
