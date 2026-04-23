/**
 * fixture:* — snapshot lifecycle commands.
 *
 * Implements the round-trip:
 *   fixture:store    — pg_dump each of the 6 saga-mesh DBs into
 *                      ~/.saga-mesh/fixtures/<id>/<db>.dump + manifest.json
 *   fixture:restore  — pg_restore each dump + redis-cli FLUSHDB
 *   fixture:list     — read fixtures on disk, print summary (or JSON)
 *   fixture:delete   — rm -rf the fixture directory
 *
 * Expects saga-mesh-postgres + saga-mesh-redis to be running (from
 * ~/dev/soa/infra/projects/saga-mesh.yml).
 */

import {
  readdirSync,
  statSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  SAGA_MESH_DATABASES,
  type SagaMeshDatabase,
  isContainerRunning,
  POSTGRES_CONTAINER,
  REDIS_CONTAINER,
  pgDump,
  pgRestore,
  redisFlushdb,
  dumpPathFor,
  ensureDir,
  fileSize,
} from '../lib/postgres.js';

const FIXTURES_ROOT =
  process.env.SAGA_MESH_FIXTURES_DIR ?? join(homedir(), '.saga-mesh', 'fixtures');

interface FixtureManifest {
  /** Fixture identifier (= directory name under FIXTURES_ROOT). */
  fixtureId: string;
  /** Human description (optional, --description flag). */
  description?: string;
  /** ISO timestamp of the store operation. */
  createdAt: string;
  /** saga-mesh-postgres container name at the time of store. */
  container: string;
  /** SEED_PROFILE at store time (makes cross-profile restores fail-loud). */
  seedProfile?: string;
  /** Per-database dump metadata. */
  databases: Array<{
    name: SagaMeshDatabase;
    dumpFile: string;
    sizeBytes: number;
  }>;
  /** Tool version that wrote this manifest. */
  cliVersion: string;
}

interface FixtureEntry {
  fixtureId: string;
  path: string;
  sizeBytes: number;
  mtime: Date;
  manifest: FixtureManifest | null;
}

function fixtureDir(fixtureId: string): string {
  return join(FIXTURES_ROOT, fixtureId);
}

function readManifest(dir: string): FixtureManifest | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
  } catch {
    return null;
  }
}

function scanFixtures(): FixtureEntry[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  const entries: FixtureEntry[] = [];
  for (const name of readdirSync(FIXTURES_ROOT)) {
    const path = join(FIXTURES_ROOT, name);
    const st = statSync(path);
    if (!st.isDirectory()) continue;
    let sizeBytes = 0;
    try {
      for (const child of readdirSync(path)) {
        sizeBytes += statSync(join(path, child)).size;
      }
    } catch {
      // ignore
    }
    entries.push({
      fixtureId: name,
      path,
      sizeBytes,
      mtime: st.mtime,
      manifest: readManifest(path),
    });
  }
  return entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

async function assertPostgresRunning(): Promise<void> {
  if (!(await isContainerRunning(POSTGRES_CONTAINER))) {
    throw new Error(
      `saga-mesh postgres container '${POSTGRES_CONTAINER}' is not running.\n` +
        `  Bring it up: (cd ~/dev/soa/infra && make up PROJECT=saga-mesh PROFILE=empty)`,
    );
  }
}

async function assertRedisRunning(): Promise<void> {
  if (!(await isContainerRunning(REDIS_CONTAINER))) {
    throw new Error(
      `saga-mesh redis container '${REDIS_CONTAINER}' is not running.\n` +
        `  Bring it up: (cd ~/dev/soa/infra && make up PROJECT=saga-mesh PROFILE=empty)`,
    );
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

export function registerFixtureCommands(program: Command): void {
  const fixture = program
    .command('fixture')
    .description('Fixture snapshot lifecycle (list, store, restore, delete).');

  fixture
    .command('list')
    .description('List all fixtures on disk under SAGA_MESH_FIXTURES_DIR.')
    .action((_opts, cmd) => {
      const { porcelain, outputJson } = cmd.optsWithGlobals<{
        porcelain: boolean;
        outputJson: boolean;
      }>();
      const entries = scanFixtures();

      if (outputJson) {
        console.log(
          JSON.stringify(
            entries.map((e) => ({
              fixtureId: e.fixtureId,
              path: e.path,
              sizeBytes: e.sizeBytes,
              modifiedAt: e.mtime.toISOString(),
              manifest: e.manifest,
            })),
            null,
            2,
          ),
        );
        return;
      }

      if (entries.length === 0) {
        if (!porcelain) {
          console.log(`No fixtures found under ${FIXTURES_ROOT}.`);
          console.log(`  Create one: mesh-fixture fixture store --fixture-id <name>`);
        }
        return;
      }

      if (porcelain) {
        for (const e of entries) {
          console.log(`${e.fixtureId}\t${e.sizeBytes}\t${e.mtime.toISOString()}`);
        }
      } else {
        console.log(`Fixtures under ${FIXTURES_ROOT}:`);
        console.log('');
        console.log('  ' + 'ID'.padEnd(28) + 'SIZE'.padEnd(12) + 'MODIFIED');
        console.log('  ' + '─'.repeat(70));
        for (const e of entries) {
          console.log(
            '  ' +
              e.fixtureId.padEnd(28) +
              formatBytes(e.sizeBytes).padEnd(12) +
              e.mtime.toISOString(),
          );
          if (e.manifest?.description) {
            console.log('    ' + e.manifest.description);
          }
        }
      }
    });

  fixture
    .command('store')
    .description('pg_dump all saga-mesh databases into ~/.saga-mesh/fixtures/<id>/.')
    .requiredOption('--fixture-id <id>', 'fixture identifier (e.g. "demo-small")')
    .option('--description <text>', 'human description stored in manifest.json')
    .option('--force', 'overwrite an existing fixture with the same id', false)
    .action(async (opts: { fixtureId: string; description?: string; force: boolean }) => {
      await assertPostgresRunning();

      const dir = fixtureDir(opts.fixtureId);
      if (existsSync(dir) && !opts.force) {
        throw new Error(
          `fixture '${opts.fixtureId}' already exists at ${dir}. Use --force to overwrite.`,
        );
      }
      ensureDir(dir);

      console.log(`Storing fixture '${opts.fixtureId}' → ${dir}`);
      const databases: FixtureManifest['databases'] = [];
      for (const db of SAGA_MESH_DATABASES) {
        const dumpFile = dumpPathFor(dir, db);
        process.stdout.write(`  dumping ${db.padEnd(18)} `);
        await pgDump(db, dumpFile);
        const size = fileSize(dumpFile);
        console.log(`${formatBytes(size)}`);
        databases.push({ name: db, dumpFile: `${db}.dump`, sizeBytes: size });
      }

      const manifest: FixtureManifest = {
        fixtureId: opts.fixtureId,
        description: opts.description,
        createdAt: new Date().toISOString(),
        container: POSTGRES_CONTAINER,
        seedProfile: process.env.SEED_PROFILE,
        databases,
        cliVersion: '0.0.1',
      };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

      const total = databases.reduce((n, d) => n + d.sizeBytes, 0);
      console.log(`\nstored ${databases.length} database(s), total ${formatBytes(total)}.`);
      console.log(`manifest: ${join(dir, 'manifest.json')}`);
    });

  fixture
    .command('restore')
    .description('pg_restore a named fixture over the running saga-mesh, then FLUSHDB redis.')
    .requiredOption('--fixture-id <id>', 'fixture identifier to restore')
    .action(async (opts: { fixtureId: string }) => {
      await assertPostgresRunning();
      await assertRedisRunning();

      const dir = fixtureDir(opts.fixtureId);
      const manifest = readManifest(dir);
      if (!manifest) {
        throw new Error(
          `no manifest found at ${dir}/manifest.json (run fixture:list to see what exists).`,
        );
      }

      console.log(`Restoring fixture '${opts.fixtureId}' from ${dir}`);
      console.log(`  stored: ${manifest.createdAt}`);
      if (manifest.description) console.log(`  desc:   ${manifest.description}`);

      for (const db of manifest.databases) {
        const dumpPath = join(dir, db.dumpFile);
        if (!existsSync(dumpPath)) {
          throw new Error(`missing dump file: ${dumpPath}`);
        }
        process.stdout.write(`  restoring ${db.name.padEnd(18)} `);
        await pgRestore(db.name, dumpPath);
        console.log('ok');
      }

      console.log('\n  FLUSHDB saga-mesh-redis (rostering cache invalidation)');
      await redisFlushdb();

      console.log(`\nrestored ${manifest.databases.length} database(s).`);
      console.log(
        `  note: apps (pnpm dev) may hold stale prisma clients — bounce them if reads look odd.`,
      );
    });

  fixture
    .command('delete')
    .description('rm -rf ~/.saga-mesh/fixtures/<id>/.')
    .requiredOption('--fixture-id <id>', 'fixture identifier to delete')
    .option('--yes', 'skip confirmation prompt', false)
    .action((opts: { fixtureId: string; yes: boolean }) => {
      const dir = fixtureDir(opts.fixtureId);
      if (!existsSync(dir)) {
        console.log(`fixture '${opts.fixtureId}' not found at ${dir}`);
        return;
      }
      if (!opts.yes) {
        throw new Error(
          `Refusing to delete ${dir} without --yes. Pass --yes to confirm.`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
      console.log(`removed ${dir}`);
    });
}
