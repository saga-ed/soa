/**
 * `e2e-review` — PURE helpers for the exploratory-review capture path
 * (`e2e run --capture` + preserved run traces + `e2e traces`).
 *
 * Motivation (docs/e2e-review.md): flows set worlds up; traces explain them.
 * Playwright WIPES `test-results/` at the start of the next run, so any trace
 * a reviewer wanted to open is gone the moment they re-run — the observed
 * footgun. The runtime side (`runtime/trace-preserve.ts`) copies artifacts to
 * `<stateDir>/e2e-runs/<runId>/…` right after each Playwright spawn; this
 * module owns the pure math: run ids, trace-dir → stage attribution, and the
 * printed review block. Core purity rules apply: no clocks (the caller passes
 * `now`), no fs, no env.
 */

/** A flow stage's identity as the review path needs it. */
export interface StageRef {
  id: string;
  project: string;
}

/** One preserved artifact file (absolute destination path). */
export interface PreservedArtifact {
  /** The original Playwright test-results dir name (provenance: spec+test+project). */
  dirName: string;
  /** File name within the dir (trace.zip, video.webm, *.png, error-context.md). */
  file: string;
  /** Absolute preserved path. */
  absPath: string;
}

/** Preserved artifacts grouped under the flow stage that produced them. */
export interface PreservedStageGroup {
  /** The stage id, or `_other` for projects that are not flow stages (e.g. dependency gates). */
  stageId: string;
  artifacts: PreservedArtifact[];
}

/** One spawn's preservation record (what the review block prints). */
export interface PreservedRunRecord {
  spaId: string;
  flowName: string;
  /** Absolute root the artifacts were preserved under (`<runsRoot>/<runId>/<spa>/<flow>`). */
  root: string;
  groups: PreservedStageGroup[];
  /**
   * Preserved Playwright HTML report dirs (absolute) — ONE per spawn that
   * emitted `playwright-report/` (capture runs do; see the SPA stack config's
   * PLAYWRIGHT_CAPTURE reporter block). The default single-spawn path yields
   * one whole-run report; the per-stage ladder yields one per stage spawn
   * (suffixed to avoid collisions).
   */
  reports: string[];
}

/** Bucket id for trace dirs whose project is not one of the flow's stages. */
export const OTHER_STAGE_BUCKET = '_other';

/**
 * A filesystem-safe, lexically-sortable run id from the command's single
 * wall-clock read (`now = new Date()` at the command layer — core never reads
 * the clock). Local time, second precision: `2026-07-09_14-05-33`.
 */
export function runIdFrom(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  );
}

/**
 * Attribute a Playwright test-results dir to the flow stage that produced it.
 *
 * Playwright names result dirs `<spec-slug>-<hash>-<title-slug>-<project>`
 * (with an optional `-retryN` AFTER the project on retried attempts). The
 * PROJECT is the only stable stage key in the name, so we match stages by
 * `-<project>` suffix — LONGEST project first, so a project that is a suffix
 * of another (`ordering` vs `periods-ordering`) can never steal its dirs.
 * Returns the stage id, or null when no stage's project matches (dependency
 * gates like `stage-0-coherence` run in the same spawn but are not stages).
 */
export function stageForTraceDir(dirName: string, stages: readonly StageRef[]): string | null {
  const base = dirName.replace(/-retry\d+$/, '');
  const byLongestProject = [...stages].sort((a, b) => b.project.length - a.project.length);
  for (const stage of byLongestProject) {
    if (base === stage.project || base.endsWith(`-${stage.project}`)) return stage.id;
  }
  return null;
}

/**
 * Is this file worth preserving from a test-results dir? Traces are the
 * point; videos ride along when Playwright wrote one; failure screenshots and
 * the error-context markdown make a red run reviewable even when retries=0
 * left no trace.
 */
export function isArtifactFile(name: string): boolean {
  return (
    name === 'trace.zip' ||
    name.endsWith('.webm') ||
    name.endsWith('.png') ||
    name === 'error-context.md' ||
    /^trace.*\.zip$/.test(name)
  );
}

/** How many show-trace lines the review block prints per stage before eliding. */
const REVIEW_LINES_PER_STAGE = 8;

/**
 * The end-of-run "review this run" block. EVERY line is paste-safe: either a
 * COMPLETE runnable command (`cd <appCwd> && pnpm exec playwright …` —
 * show-trace/show-report must run where Playwright is installed) or a `#`
 * shell comment — never a bare path (pasting one earns "Permission denied",
 * the observed reviewer papercut).
 */
export function reviewBlockLines(record: PreservedRunRecord, appCwd: string): string[] {
  const lines: string[] = [
    `# ── review this run ─ ${record.spaId}/${record.flowName}`,
    `# preserved: ${record.root}`,
  ];
  for (const report of record.reports) {
    lines.push(`# whole-run report (all scenarios, named steps, embedded traces):`);
    lines.push(`cd ${appCwd} && pnpm exec playwright show-report ${report}`);
  }
  for (const group of record.groups) {
    const traces = group.artifacts.filter((a) => a.file.endsWith('.zip'));
    const extras = group.artifacts.length - traces.length;
    lines.push(`# stage ${group.stageId} — ${traces.length} trace(s)${extras > 0 ? ` + ${extras} other artifact(s)` : ''}:`);
    for (const t of traces.slice(0, REVIEW_LINES_PER_STAGE)) {
      lines.push(`cd ${appCwd} && pnpm exec playwright show-trace ${t.absPath}`);
    }
    if (traces.length > REVIEW_LINES_PER_STAGE) {
      lines.push(`ls ${record.root}/${group.stageId}/  # … ${traces.length - REVIEW_LINES_PER_STAGE} more trace(s)`);
    }
    if (traces.length === 0 && group.artifacts.length > 0) {
      lines.push(`ls ${record.root}/${group.stageId}/  # no trace.zip — screenshots/error context only`);
    }
  }
  lines.push(`ss e2e traces  # list preserved runs any time`);
  return lines;
}

/** A preserved run as `e2e traces` lists it (scanned back off disk). */
export interface PreservedRunListing {
  runId: string;
  spaId: string;
  flowName: string;
  /** Absolute per-stage trace paths, in stage order as found. */
  stages: { stageId: string; traces: string[] }[];
  /** Preserved whole-run HTML report dirs (absolute). */
  reports: string[];
}

/**
 * The `e2e traces` listing lines, newest run first (run ids are lexically
 * chronological by construction). `appCwdOf` supplies the `cd` prefix per spa
 * (null ⇒ the spa's repo could not be resolved; the line says so once).
 */
export function tracesListingLines(
  runs: readonly PreservedRunListing[],
  appCwdOf: (spaId: string) => string | null,
): string[] {
  if (runs.length === 0) {
    return ['# no preserved e2e runs found — produce one with: ss e2e run <flow> --capture (or any failing run)'];
  }
  // Paste-safety contract (same as the review block): every line is either a
  // complete runnable command or a `#` comment — never a bare path.
  const lines: string[] = [];
  for (const run of runs) {
    const total = run.stages.reduce((n, s) => n + s.traces.length, 0);
    lines.push(
      `# ${run.runId}  ${run.spaId}/${run.flowName}  (${total} trace(s)${run.reports.length > 0 ? `, ${run.reports.length} report(s)` : ''})`,
    );
    const appCwd = appCwdOf(run.spaId);
    for (const report of run.reports) {
      lines.push(
        appCwd === null
          ? `# ${report}  (report; spa repo not resolved — run show-report from a playwright install)`
          : `cd ${appCwd} && pnpm exec playwright show-report ${report}  # report`,
      );
    }
    for (const stage of run.stages) {
      for (const t of stage.traces) {
        lines.push(
          appCwd === null
            ? `# ${t}  (${stage.stageId}; spa repo not resolved — run show-trace from a playwright install)`
            : `cd ${appCwd} && pnpm exec playwright show-trace ${t}  # ${stage.stageId}`,
        );
      }
    }
  }
  return lines;
}

/**
 * The newest preserved HTML report across a listing — `e2e traces --open`
 * PREFERS this over a single trace (one browsable page for the whole run).
 * Null when no run preserved a report.
 */
export function newestReport(runs: readonly PreservedRunListing[]): { spaId: string; report: string } | null {
  for (const run of runs) {
    const [first] = run.reports;
    if (first !== undefined) return { spaId: run.spaId, report: first };
  }
  return null;
}

/** The newest trace zip across a listing (the `--open` fallback when no report exists). Null when none. */
export function newestTrace(runs: readonly PreservedRunListing[]): { spaId: string; trace: string } | null {
  // Listings arrive newest-first; take the first run that actually has a trace.
  for (const run of runs) {
    for (const stage of run.stages) {
      const [first] = stage.traces;
      if (first !== undefined) return { spaId: run.spaId, trace: first };
    }
  }
  return null;
}
