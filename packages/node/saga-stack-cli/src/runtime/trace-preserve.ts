/**
 * `trace-preserve` — the IO side of the exploratory-review capture path
 * (docs/e2e-review.md): copy a Playwright spawn's artifacts OUT of the SPA's
 * `test-results/` (which Playwright wipes at the next run's start — the
 * observed footgun) into the durable per-run tree
 *
 *   <runsRoot>/<runId>/<spaId>/<flowName>/<stageId>/<original-dir-name>/<file>
 *
 * The pure math (run ids, dir→stage attribution, review-block lines) lives in
 * `core/e2e-review.ts`; this module only walks + copies through an injectable
 * fs seam so unit tests never touch the disk (house pattern: dash-defaults'
 * `DashFs`).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isArtifactFile,
  OTHER_STAGE_BUCKET,
  stageForTraceDir,
} from '../core/e2e-review.js';
import type {
  PreservedRunRecord,
  PreservedRunListing,
  PreservedStageGroup,
  StageRef,
} from '../core/e2e-review.js';

/** Injectable fs surface (defaulted to real `node:fs`). */
export interface PreserveFs {
  existsDir(path: string): boolean;
  /** Immediate subdirectory NAMES of `dir` ([] when missing/unreadable). */
  listDirs(dir: string): string[];
  /** Immediate file NAMES of `dir` ([] when missing/unreadable). */
  listFiles(dir: string): string[];
  mkdirp(dir: string): void;
  copy(src: string, dest: string): void;
}

/** The production fs seam. */
export function makeRealPreserveFs(): PreserveFs {
  const entries = (dir: string, wantDir: boolean): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => (wantDir ? e.isDirectory() : e.isFile()))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  return {
    existsDir: (p) => existsSync(p),
    listDirs: (dir) => entries(dir, true),
    listFiles: (dir) => entries(dir, false),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    copy: (src, dest) => copyFileSync(src, dest),
  };
}

/** What the executor tells the preserver about a finished Playwright spawn. */
export interface PreserveFrame {
  /** The SPA app dir the spawn ran in (test-results lives under it). */
  appCwd: string;
  spaId: string;
  flowName: string;
  /** The flow's stages (for dir→stage attribution). */
  stages: readonly StageRef[];
}

/**
 * Copy the spawn's artifacts out of `<appCwd>/test-results/` into the run
 * tree. Returns the preservation record (empty `groups` when nothing was
 * found — e.g. a green run without --capture and without retries). Copies are
 * best-effort per file: one unreadable file must not lose the rest.
 */
export function preserveSpawnArtifacts(
  frame: PreserveFrame,
  ctx: { runsRoot: string; runId: string; fs?: PreserveFs; warn?: (line: string) => void },
): PreservedRunRecord {
  const fs = ctx.fs ?? makeRealPreserveFs();
  const warn = ctx.warn ?? ((): void => {});
  const resultsDir = join(frame.appCwd, 'test-results');
  const root = join(ctx.runsRoot, ctx.runId, frame.spaId, frame.flowName);
  const record: PreservedRunRecord = { spaId: frame.spaId, flowName: frame.flowName, root, groups: [] };
  if (!fs.existsDir(resultsDir)) return record;

  const byStage = new Map<string, PreservedStageGroup>();
  for (const dirName of fs.listDirs(resultsDir)) {
    const files = fs.listFiles(join(resultsDir, dirName)).filter(isArtifactFile);
    if (files.length === 0) continue;
    const stageId = stageForTraceDir(dirName, frame.stages) ?? OTHER_STAGE_BUCKET;
    const group = byStage.get(stageId) ?? { stageId, artifacts: [] };
    byStage.set(stageId, group);
    const destDir = join(root, stageId, dirName);
    fs.mkdirp(destDir);
    for (const file of files) {
      const absPath = join(destDir, file);
      try {
        fs.copy(join(resultsDir, dirName, file), absPath);
        group.artifacts.push({ dirName, file, absPath });
      } catch (err) {
        warn(`⚠ trace-preserve: could not copy ${dirName}/${file}: ${(err as Error).message}`);
      }
    }
  }

  // Stage order follows the flow's stage order; the _other bucket sorts last.
  const order = new Map(frame.stages.map((s, i) => [s.id, i]));
  record.groups = [...byStage.values()].sort(
    (a, b) => (order.get(a.stageId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stageId) ?? Number.MAX_SAFE_INTEGER),
  );
  return record;
}

/**
 * Scan the preserved-run tree back off disk for `e2e traces`, NEWEST run
 * first (run ids are lexically chronological). Tolerates foreign files at any
 * level (they are simply skipped — the tree is user-visible scratch space).
 */
export function listPreservedRuns(runsRoot: string, fs: PreserveFs = makeRealPreserveFs()): PreservedRunListing[] {
  const runs: PreservedRunListing[] = [];
  for (const runId of [...fs.listDirs(runsRoot)].sort().reverse()) {
    for (const spaId of fs.listDirs(join(runsRoot, runId))) {
      for (const flowName of fs.listDirs(join(runsRoot, runId, spaId))) {
        const flowDir = join(runsRoot, runId, spaId, flowName);
        const stages: PreservedRunListing['stages'] = [];
        for (const stageId of fs.listDirs(flowDir)) {
          const traces: string[] = [];
          for (const dirName of fs.listDirs(join(flowDir, stageId))) {
            for (const file of fs.listFiles(join(flowDir, stageId, dirName))) {
              if (file.endsWith('.zip')) traces.push(join(flowDir, stageId, dirName, file));
            }
          }
          if (traces.length > 0) stages.push({ stageId, traces });
        }
        runs.push({ runId, spaId, flowName, stages });
      }
    }
  }
  return runs;
}
