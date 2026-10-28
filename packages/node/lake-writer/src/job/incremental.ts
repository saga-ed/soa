// Cursor-driven incremental export: lag keeps the window behind in-flight
// commits, overlap re-covers late-arriving rows. The cursor advances only
// after exportKeys resolves, so a failed run is retried over the same window.

import { deterministicRunId } from './run-id.js';
import type { ExportCursor, ExportCursorStore } from './cursor.js';

export interface ExportWindow {
  since: Date;
  until: Date;
}

export interface RunIncrementalExportArgs<K> {
  job: string;
  cursorStore: ExportCursorStore;
  now?: Date;
  /** Default 10 minutes. */
  lagMs?: number;
  /** Default 10 minutes. */
  overlapMs?: number;
  initialSince: Date;
  runId?: string;
  collectKeys(window: ExportWindow): Promise<K[]>;
  exportKeys(
    keys: K[],
    ctx: { runId: string; ingestedAt: Date; window: ExportWindow },
  ): Promise<unknown>;
  logger?: { info(obj: object, msg: string): void };
}

export interface IncrementalExportResult {
  runId: string;
  window: ExportWindow;
  keyCount: number;
  skipped: boolean;
  cursorBefore: ExportCursor | null;
  cursorAfter: ExportCursor | null;
}

const TEN_MINUTES_MS = 10 * 60_000;

export async function runIncrementalExport<K>(
  args: RunIncrementalExportArgs<K>,
): Promise<IncrementalExportResult> {
  const now = args.now ?? new Date();
  const lagMs = args.lagMs ?? TEN_MINUTES_MS;
  const overlapMs = args.overlapMs ?? TEN_MINUTES_MS;
  const runId = args.runId ?? deterministicRunId(args.job, now);

  const cursorBefore = await args.cursorStore.read(args.job);
  const until = new Date(now.getTime() - lagMs);
  const since = new Date((cursorBefore?.watermark ?? args.initialSince).getTime() - overlapMs);
  const window = { since, until };

  if (until.getTime() <= since.getTime()) {
    args.logger?.info({ job: args.job, runId, window }, 'incremental export skipped: empty window');
    return { runId, window, keyCount: 0, skipped: true, cursorBefore, cursorAfter: cursorBefore };
  }

  const keys = await args.collectKeys(window);
  if (keys.length > 0) {
    await args.exportKeys(keys, { runId, ingestedAt: now, window });
  }

  await args.cursorStore.write(args.job, { watermark: until, runId });
  const cursorAfter = await args.cursorStore.read(args.job);
  args.logger?.info(
    { job: args.job, runId, window, keyCount: keys.length },
    'incremental export complete',
  );
  return { runId, window, keyCount: keys.length, skipped: false, cursorBefore, cursorAfter };
}
