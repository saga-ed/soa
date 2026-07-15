/**
 * `runtime/trace-preserve` — copy Playwright artifacts out of the wiped-on-
 * next-run `test-results/` into the durable `<runsRoot>/<runId>/…` tree, and
 * scan that tree back for `e2e traces`. All fs through the injected seam —
 * no disk.
 */

import { describe, expect, it } from 'vitest';
import { preserveSpawnArtifacts, listPreservedRuns } from '../trace-preserve.js';
import type { PreserveFs } from '../trace-preserve.js';

/** An in-memory PreserveFs over a `{dir: files[]}` map + copy log. */
function fakeFs(tree: Record<string, string[]>): {
  fs: PreserveFs;
  copies: Array<[string, string]>;
  dirCopies: Array<[string, string]>;
  mkdirs: string[];
} {
  const copies: Array<[string, string]> = [];
  const dirCopies: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  const dirs = new Set(Object.keys(tree));
  const fs: PreserveFs = {
    existsDir: (p) => dirs.has(p) || [...dirs].some((d) => d.startsWith(`${p}/`)),
    listDirs: (dir) =>
      [...new Set(
        [...dirs]
          .filter((d) => d.startsWith(`${dir}/`))
          .map((d) => d.slice(dir.length + 1).split('/')[0]),
      )].sort(),
    listFiles: (dir) => (tree[dir] ?? []).sort(),
    mkdirp: (dir) => mkdirs.push(dir),
    copy: (src, dest) => {
      if (src.includes('unreadable')) throw new Error('EACCES');
      copies.push([src, dest]);
    },
    copyDir: (src, dest) => dirCopies.push([src, dest]),
  };
  return { fs, copies, dirCopies, mkdirs };
}

const FRAME = {
  appCwd: '/repo/apps/web/dash',
  spaId: 'saga-dash',
  flowName: 'periods-ordering',
  stages: [{ id: 'ordering', project: 'periods-ordering' }],
};

describe('preserveSpawnArtifacts', () => {
  it('copies artifact files into <runsRoot>/<runId>/<spa>/<flow>/<stage>/<dir>/ and groups by stage', () => {
    const { fs, copies } = fakeFs({
      '/repo/apps/web/dash/test-results/spec-ab-title-periods-ordering': ['trace.zip', 'video.webm', 'noise.txt'],
      '/repo/apps/web/dash/test-results/coherence-cd-x-stage-0-coherence': ['trace.zip'],
    });
    const record = preserveSpawnArtifacts(FRAME, { runsRoot: '/state/e2e-runs', runId: 'r1', fs });

    expect(record.root).toBe('/state/e2e-runs/r1/saga-dash/periods-ordering');
    expect(record.groups.map((g) => g.stageId)).toEqual(['ordering', '_other']);
    const ordering = record.groups[0];
    expect(ordering.artifacts.map((a) => a.file).sort()).toEqual(['trace.zip', 'video.webm']);
    expect(ordering.artifacts[0].absPath).toBe(
      '/state/e2e-runs/r1/saga-dash/periods-ordering/ordering/spec-ab-title-periods-ordering/trace.zip',
    );
    // noise.txt never copied; the coherence gate lands in _other.
    expect(copies.some(([src]) => src.endsWith('noise.txt'))).toBe(false);
    expect(copies.some(([, dest]) => dest.includes('/_other/'))).toBe(true);
    // no playwright-report/ in this tree -> no report preserved.
    expect(record.reports).toEqual([]);
  });

  it('preserves the whole-run HTML report beside the stage dirs (suffixing on collision)', () => {
    const { fs, dirCopies } = fakeFs({
      '/repo/apps/web/dash/playwright-report': ['index.html'],
      '/repo/apps/web/dash/playwright-report/data': ['a.zip'],
      // a previous spawn of the same run already preserved one:
      '/state/e2e-runs/r1/saga-dash/periods-ordering/playwright-report': ['index.html'],
    });
    const record = preserveSpawnArtifacts(FRAME, { runsRoot: '/state/e2e-runs', runId: 'r1', fs });
    expect(record.reports).toEqual(['/state/e2e-runs/r1/saga-dash/periods-ordering/playwright-report-2']);
    expect(dirCopies).toEqual([
      ['/repo/apps/web/dash/playwright-report', '/state/e2e-runs/r1/saga-dash/periods-ordering/playwright-report-2'],
    ]);
  });

  it('returns empty groups when test-results is missing or artifact-free (green non-capture run)', () => {
    const missing = preserveSpawnArtifacts(FRAME, { runsRoot: '/s', runId: 'r', fs: fakeFs({}).fs });
    expect(missing.groups).toEqual([]);
    const empty = preserveSpawnArtifacts(FRAME, {
      runsRoot: '/s',
      runId: 'r',
      fs: fakeFs({ '/repo/apps/web/dash/test-results/spec-x-periods-ordering': ['noise.txt'] }).fs,
    });
    expect(empty.groups).toEqual([]);
  });

  it('is best-effort per file: an unreadable file warns and the rest survive', () => {
    const { fs } = fakeFs({
      '/repo/apps/web/dash/test-results/unreadable-spec-periods-ordering': ['trace.zip'],
      '/repo/apps/web/dash/test-results/spec-ok-periods-ordering': ['trace.zip'],
    });
    const warnings: string[] = [];
    const record = preserveSpawnArtifacts(FRAME, {
      runsRoot: '/s',
      runId: 'r',
      fs,
      warn: (l) => warnings.push(l),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not copy');
    const all = record.groups.flatMap((g) => g.artifacts);
    expect(all).toHaveLength(1);
    expect(all[0].dirName).toBe('spec-ok-periods-ordering');
  });
});

describe('listPreservedRuns', () => {
  it('scans the tree back newest-first, keeping trace zips and whole-run reports', () => {
    const { fs } = fakeFs({
      '/state/e2e-runs/2026-07-09_09-00-00/saga-dash/journey/roster/d1': ['trace.zip', 'video.webm'],
      '/state/e2e-runs/2026-07-09_15-00-00/saga-dash/periods-ordering/ordering/d2': ['trace.zip'],
      '/state/e2e-runs/2026-07-09_15-00-00/saga-dash/periods-ordering/playwright-report': ['index.html'],
    });
    const runs = listPreservedRuns('/state/e2e-runs', fs);
    expect(runs.map((r) => r.runId)).toEqual(['2026-07-09_15-00-00', '2026-07-09_09-00-00']);
    expect(runs[0].stages).toEqual([
      {
        stageId: 'ordering',
        traces: ['/state/e2e-runs/2026-07-09_15-00-00/saga-dash/periods-ordering/ordering/d2/trace.zip'],
      },
    ]);
    expect(runs[0].reports).toEqual([
      '/state/e2e-runs/2026-07-09_15-00-00/saga-dash/periods-ordering/playwright-report',
    ]);
    expect(runs[1].spaId).toBe('saga-dash');
    expect(runs[1].reports).toEqual([]);
    expect(runs[1].stages[0].traces.every((t) => t.endsWith('.zip'))).toBe(true);
  });

  it('reads an empty/missing root as no runs', () => {
    expect(listPreservedRuns('/nowhere', fakeFs({}).fs)).toEqual([]);
  });
});
