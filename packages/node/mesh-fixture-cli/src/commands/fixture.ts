/**
 * fixture:* — snapshot lifecycle commands.
 *
 * First-pass implementation: `fixture:list` works (pure filesystem read of
 * the fixtures directory). `fixture:store`, `fixture:restore`, and
 * `fixture:delete` are stubs that print a not-yet-implemented message;
 * they become real in Phase 3 D3.3 (volume snapshot mechanism).
 */

import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

// Where snapshot tarballs (+ manifest.json) live on disk. One subdirectory
// per fixture-id. Kept outside any repo so multiple laptops sharing a
// checkout don't fight over the same files.
const FIXTURES_ROOT = process.env.SAGA_MESH_FIXTURES_DIR ?? join(homedir(), '.saga-mesh', 'fixtures');

function ensureFixturesRoot(): void {
  if (!existsSync(FIXTURES_ROOT)) {
    mkdirSync(FIXTURES_ROOT, { recursive: true });
  }
}

interface FixtureEntry {
  fixtureId: string;
  path: string;
  sizeBytes: number;
  mtime: Date;
}

function scanFixtures(): FixtureEntry[] {
  ensureFixturesRoot();
  const entries: FixtureEntry[] = [];
  for (const name of readdirSync(FIXTURES_ROOT)) {
    const path = join(FIXTURES_ROOT, name);
    const st = statSync(path);
    if (!st.isDirectory()) continue;
    // Directory size — sum of immediate children (good enough for display).
    let sizeBytes = 0;
    try {
      for (const child of readdirSync(path)) {
        sizeBytes += statSync(join(path, child)).size;
      }
    } catch {
      // Permission error or similar — list entry anyway but with size=0.
    }
    entries.push({ fixtureId: name, path, sizeBytes, mtime: st.mtime });
  }
  return entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

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
          console.log(`  Create one: mesh-fixture fixture:store --fixture-id <name>`);
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
        console.log('  ID'.padEnd(30) + 'SIZE'.padEnd(12) + 'MODIFIED');
        console.log('  ' + '─'.repeat(70));
        for (const e of entries) {
          console.log(
            '  ' +
              e.fixtureId.padEnd(28) +
              formatBytes(e.sizeBytes).padEnd(12) +
              e.mtime.toISOString(),
          );
        }
      }
    });

  fixture
    .command('store')
    .description('Snapshot the current mesh state to a fixture tarball.')
    .requiredOption('--fixture-id <id>', 'fixture identifier (e.g. "demo-small")')
    .option('--description <text>', 'optional human description')
    .action((opts: { fixtureId: string; description?: string }) => {
      console.error(
        `mesh-fixture fixture:store — not yet implemented (D3.3). Will pg_dump each of the six DBs from saga-mesh-postgres into ${join(FIXTURES_ROOT, opts.fixtureId)}.`,
      );
      process.exitCode = 2;
    });

  fixture
    .command('restore')
    .description('Restore a named fixture onto the current mesh.')
    .requiredOption('--fixture-id <id>', 'fixture identifier to restore')
    .action((opts: { fixtureId: string }) => {
      console.error(
        `mesh-fixture fixture:restore — not yet implemented (D3.3). Will pg_restore each *.dump under ${join(FIXTURES_ROOT, opts.fixtureId)} and FLUSHDB saga-mesh-redis.`,
      );
      process.exitCode = 2;
    });

  fixture
    .command('delete')
    .description('Delete a named fixture from disk.')
    .requiredOption('--fixture-id <id>', 'fixture identifier to delete')
    .action((opts: { fixtureId: string }) => {
      console.error(
        `mesh-fixture fixture:delete — not yet implemented. Will rm -rf ${join(FIXTURES_ROOT, opts.fixtureId)}.`,
      );
      process.exitCode = 2;
    });
}
