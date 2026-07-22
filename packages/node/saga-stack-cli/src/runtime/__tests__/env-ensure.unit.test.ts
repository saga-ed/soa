/**
 * env-ensure unit tests (cold-start).
 *
 * Pure classifier + prune predicate, and a fake-EnvFs discovery/copy pass. Cover: a missing .env
 * next to a template is SCAFFOLDED (copied), an existing .env is left present (never overwritten),
 * the walk PRUNES node_modules, `--dry-run` copies nothing, and a repo with no `.git` is skipped.
 */

import { describe, expect, it } from 'vitest';
import { classifyEnv, ensureEnv, parseEnvKeys, shouldPrune } from '../env-ensure.js';
import type { EnvFs } from '../env-ensure.js';
import type { EnsureRepo } from '../ensure-repos.js';

const repo = (name: string): EnsureRepo => ({
  name,
  path: `/dev/${name}`,
  url: `git@github.com:saga-ed/${name}.git`,
});

describe('pure helpers', () => {
  it('classifyEnv: target exists ⇒ present; else example ⇒ scaffolded; else missing-no-template', () => {
    expect(classifyEnv({ exampleExists: true, targetExists: true })).toBe('present');
    expect(classifyEnv({ exampleExists: true, targetExists: false })).toBe('scaffolded');
    expect(classifyEnv({ exampleExists: false, targetExists: false })).toBe('missing-no-template');
  });
  it('shouldPrune skips node_modules/.git/build output, not source dirs', () => {
    expect(shouldPrune('node_modules')).toBe(true);
    expect(shouldPrune('.git')).toBe(true);
    expect(shouldPrune('dist')).toBe(true);
    expect(shouldPrune('apps')).toBe(false);
  });
  it('parseEnvKeys: extracts KEY names, ignoring comments/blanks/export prefix; null ⇒ []', () => {
    expect(parseEnvKeys('A=1\n# c\n\nexport B=2\n  C = 3\nnot a line\n')).toEqual(['A', 'B', 'C']);
    expect(parseEnvKeys(null)).toEqual([]);
    expect(parseEnvKeys('')).toEqual([]);
  });
});

/** A fake EnvFs over an in-memory tree. `dirsChildren` maps a dir → its entries. */
function makeFakeEnvFs(
  files: Set<string>,
  dirsChildren: Record<string, { name: string; isDir: boolean }[]>,
  copies: Array<[string, string]>,
  contents: Record<string, string> = {},
): EnvFs {
  return {
    list: (dir) => dirsChildren[dir] ?? [],
    exists: (p) => files.has(p),
    copy: (from, to) => {
      copies.push([from, to]);
      files.add(to); // reflect the write so a later check sees it
    },
    read: (p) => contents[p] ?? null,
  };
}

describe('ensureEnv — fake-fs discovery + scaffold', () => {
  // rostering: root has .env.example (no .env → scaffold); apps/node/iam-api has BOTH (present);
  // node_modules has a stray .env.example that MUST be pruned.
  const tree = (): {
    files: Set<string>;
    children: Record<string, { name: string; isDir: boolean }[]>;
  } => ({
    files: new Set<string>([
      '/dev/rostering/.git',
      '/dev/rostering/.env.example',
      '/dev/rostering/apps/node/iam-api/.env.example',
      '/dev/rostering/apps/node/iam-api/.env',
      '/dev/rostering/node_modules/pkg/.env.example',
    ]),
    children: {
      '/dev/rostering': [
        { name: '.git', isDir: false },
        { name: '.env.example', isDir: false },
        { name: 'apps', isDir: true },
        { name: 'node_modules', isDir: true },
      ],
      '/dev/rostering/apps': [{ name: 'node', isDir: true }],
      '/dev/rostering/apps/node': [{ name: 'iam-api', isDir: true }],
      '/dev/rostering/apps/node/iam-api': [
        { name: '.env.example', isDir: false },
        { name: '.env', isDir: false },
      ],
      '/dev/rostering/node_modules': [{ name: 'pkg', isDir: true }],
      '/dev/rostering/node_modules/pkg': [{ name: '.env.example', isDir: false }],
    },
  });

  it('scaffolds the missing root .env, leaves the iam-api .env present, PRUNES node_modules', async () => {
    const { files, children } = tree();
    const copies: Array<[string, string]> = [];
    const res = ensureEnv([repo('rostering')], {
      fs: makeFakeEnvFs(files, children, copies),
    });

    // The node_modules template was never discovered (pruned).
    const paths = res.results.map((r) => r.relPath).sort();
    expect(paths).toEqual(['.env', 'apps/node/iam-api/.env']);

    const root = res.results.find((r) => r.relPath === '.env');
    expect(root?.action).toBe('scaffolded');
    const iam = res.results.find((r) => r.relPath === 'apps/node/iam-api/.env');
    expect(iam?.action).toBe('present');

    // Exactly one copy: the missing root .env from its example.
    expect(copies).toEqual([['/dev/rostering/.env.example', '/dev/rostering/.env']]);
    expect(res.ok).toBe(true);
  });

  it('--dry-run discovers + classifies but copies NOTHING', async () => {
    const { files, children } = tree();
    const copies: Array<[string, string]> = [];
    const res = ensureEnv([repo('rostering')], {
      fs: makeFakeEnvFs(files, children, copies),
      dryRun: true,
    });
    expect(copies).toEqual([]); // no write
    expect(res.results.find((r) => r.relPath === '.env')?.action).toBe('scaffolded'); // still reported
  });

  it('a repo with no .git is skipped entirely', async () => {
    const files = new Set<string>(); // no /dev/ghost/.git
    const copies: Array<[string, string]> = [];
    const res = ensureEnv([repo('ghost')], { fs: makeFakeEnvFs(files, {}, copies) });
    expect(res.results).toEqual([]);
    expect(copies).toEqual([]);
  });
});

describe('ensureEnv — soa#359 key reconcile', () => {
  /** A repo root holding `.env.example` + whatever root files are listed. */
  const rootTree = (
    rootFiles: string[],
  ): { files: Set<string>; children: Record<string, { name: string; isDir: boolean }[]> } => ({
    files: new Set<string>(['/dev/rostering/.git', '/dev/rostering/.env.example', ...rootFiles]),
    children: {
      '/dev/rostering': [
        { name: '.git', isDir: false },
        { name: '.env.example', isDir: false },
        ...rootFiles.map((f) => ({ name: f.split('/').pop() as string, isDir: false })),
      ],
    },
  });

  it('a PRESENT .env missing an example key (also absent from .env.local) is flagged, never copied', () => {
    const { files, children } = rootTree(['/dev/rostering/.env', '/dev/rostering/.env.local']);
    const copies: Array<[string, string]> = [];
    const res = ensureEnv([repo('rostering')], {
      fs: makeFakeEnvFs(files, children, copies, {
        '/dev/rostering/.env.example': 'DATABASE_URL=x\nAUTHZ_DATABASE_URL=y\n',
        '/dev/rostering/.env': 'DATABASE_URL=real\n',
        '/dev/rostering/.env.local': 'REDIS_URL=r\n',
      }),
    });
    const root = res.results.find((r) => r.relPath === '.env');
    expect(root?.action).toBe('present');
    expect(root?.missingKeys).toEqual(['AUTHZ_DATABASE_URL']);
    expect(root?.message).toContain('AUTHZ_DATABASE_URL');
    expect(copies).toEqual([]); // reported, never appended/overwritten
  });

  it('a key provided by .env.local (not .env) is NOT flagged — union of sources', () => {
    const { files, children } = rootTree(['/dev/rostering/.env', '/dev/rostering/.env.local']);
    const res = ensureEnv([repo('rostering')], {
      fs: makeFakeEnvFs(files, children, [], {
        '/dev/rostering/.env.example': 'AUTHZ_DATABASE_URL=y\n',
        '/dev/rostering/.env': '# nothing here\n',
        '/dev/rostering/.env.local': 'AUTHZ_DATABASE_URL=mine\n',
      }),
    });
    expect(res.results.find((r) => r.relPath === '.env')?.missingKeys).toEqual([]);
  });

  it('a freshly SCAFFOLDED .env is never key-checked (it is a verbatim copy of the template)', () => {
    const { files, children } = rootTree([]); // no .env yet ⇒ scaffold
    const res = ensureEnv([repo('rostering')], {
      fs: makeFakeEnvFs(files, children, [], {
        '/dev/rostering/.env.example': 'AUTHZ_DATABASE_URL=y\n',
      }),
    });
    const root = res.results.find((r) => r.relPath === '.env');
    expect(root?.action).toBe('scaffolded');
    expect(root?.missingKeys).toEqual([]);
  });
});
