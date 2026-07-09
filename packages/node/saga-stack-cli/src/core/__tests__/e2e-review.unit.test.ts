/**
 * `core/e2e-review` — pure helpers for the exploratory-review capture path
 * (docs/e2e-review.md): run ids, trace-dir → stage attribution, artifact
 * matching, and the printed review/listing blocks. No fs, no clock.
 */

import { describe, expect, it } from 'vitest';
import {
  isArtifactFile,
  newestReport,
  newestTrace,
  OTHER_STAGE_BUCKET,
  reviewBlockLines,
  runIdFrom,
  stageForTraceDir,
  tracesListingLines,
} from '../e2e-review.js';
import type { PreservedRunRecord, PreservedRunListing } from '../e2e-review.js';

describe('runIdFrom', () => {
  it('is filesystem-safe and lexically chronological (local time, second precision)', () => {
    expect(runIdFrom(new Date(2026, 6, 9, 14, 5, 3))).toBe('2026-07-09_14-05-03');
    const earlier = runIdFrom(new Date(2026, 6, 9, 9, 59, 59));
    const later = runIdFrom(new Date(2026, 6, 9, 10, 0, 0));
    expect(earlier < later).toBe(true);
  });
});

describe('stageForTraceDir', () => {
  const stages = [
    { id: 'ordering', project: 'periods-ordering' },
    { id: 'roster', project: 'stage-1-roster' },
  ];

  it('attributes by -<project> suffix', () => {
    expect(
      stageForTraceDir('scheduling-periods-orderin-1cd67-riod-without-re-creating-it-periods-ordering', stages),
    ).toBe('ordering');
    expect(stageForTraceDir('roster-csv-upload-view-ab123-fresh-upload-stage-1-roster', stages)).toBe('roster');
  });

  it('strips a -retryN suffix before matching (retried attempts)', () => {
    expect(stageForTraceDir('spec-ab123-title-periods-ordering-retry1', stages)).toBe('ordering');
  });

  it('prefers the LONGEST matching project (a project that suffixes another cannot steal)', () => {
    const overlapping = [
      { id: 'short', project: 'ordering' },
      { id: 'long', project: 'periods-ordering' },
    ];
    expect(stageForTraceDir('spec-ab-title-periods-ordering', overlapping)).toBe('long');
    expect(stageForTraceDir('spec-ab-title-ordering', overlapping)).toBe('short');
  });

  it('returns null for a project that is not a flow stage (dependency gates)', () => {
    expect(stageForTraceDir('sandbox-composition-coherence-ab-iam-serves-stage-0-coherence', stages)).toBeNull();
  });
});

describe('isArtifactFile', () => {
  it('keeps traces, videos, screenshots and the error context; drops the rest', () => {
    expect(isArtifactFile('trace.zip')).toBe(true);
    expect(isArtifactFile('trace-1.zip')).toBe(true);
    expect(isArtifactFile('video.webm')).toBe(true);
    expect(isArtifactFile('test-failed-1.png')).toBe(true);
    expect(isArtifactFile('error-context.md')).toBe(true);
    expect(isArtifactFile('anything.txt')).toBe(false);
  });
});

const record: PreservedRunRecord = {
  spaId: 'saga-dash',
  flowName: 'periods-ordering',
  root: '/state/e2e-runs/2026-07-09_14-05-03/saga-dash/periods-ordering',
  reports: ['/state/e2e-runs/2026-07-09_14-05-03/saga-dash/periods-ordering/playwright-report'],
  groups: [
    {
      stageId: 'ordering',
      artifacts: [
        { dirName: 'd1', file: 'trace.zip', absPath: '/state/…/ordering/d1/trace.zip' },
        { dirName: 'd1', file: 'video.webm', absPath: '/state/…/ordering/d1/video.webm' },
      ],
    },
    {
      stageId: OTHER_STAGE_BUCKET,
      artifacts: [{ dirName: 'd2', file: 'test-failed-1.png', absPath: '/state/…/_other/d2/test-failed-1.png' }],
    },
  ],
};

describe('reviewBlockLines', () => {
  it('prints the preserved root + a paste-ready cd-prefixed show-trace line per trace', () => {
    const lines = reviewBlockLines(record, '/repo/apps/web/dash');
    expect(lines[0]).toContain('saga-dash/periods-ordering');
    expect(lines).toContain(`   preserved: ${record.root}`);
    expect(lines).toContain(
      '     cd /repo/apps/web/dash && pnpm exec playwright show-trace /state/…/ordering/d1/trace.zip',
    );
    // The whole-run HTML report leads the block with a show-report line.
    expect(lines).toContain(
      '     cd /repo/apps/web/dash && pnpm exec playwright show-report ' +
        '/state/e2e-runs/2026-07-09_14-05-03/saga-dash/periods-ordering/playwright-report',
    );
    // A group with artifacts but no trace says so instead of printing nothing.
    expect(lines.some((l) => l.includes('no trace.zip — screenshots/error context only'))).toBe(true);
  });

  it('caps the per-stage lines and points at the stage dir beyond the cap', () => {
    const many: PreservedRunRecord = {
      ...record,
      groups: [
        {
          stageId: 'ordering',
          artifacts: Array.from({ length: 10 }, (_, i) => ({
            dirName: `d${i}`,
            file: 'trace.zip',
            absPath: `/state/…/ordering/d${i}/trace.zip`,
          })),
        },
      ],
    };
    const lines = reviewBlockLines(many, '/repo');
    expect(lines.filter((l) => l.includes('show-trace'))).toHaveLength(8);
    expect(lines.some((l) => l.includes('… 2 more under'))).toBe(true);
  });
});

const listing: PreservedRunListing[] = [
  {
    runId: '2026-07-09_15-00-00',
    spaId: 'saga-dash',
    flowName: 'periods-ordering',
    stages: [{ stageId: 'ordering', traces: ['/runs/a/trace.zip'] }],
    reports: ['/runs/a/playwright-report'],
  },
  {
    runId: '2026-07-09_09-00-00',
    spaId: 'unknown-spa',
    flowName: 'journey',
    stages: [{ stageId: 'roster', traces: ['/runs/b/trace.zip'] }],
    reports: [],
  },
];

describe('tracesListingLines', () => {
  it('says how to produce a run when none are preserved', () => {
    expect(tracesListingLines([], () => null)[0]).toContain('--capture');
  });

  it('prints cd-prefixed lines for resolvable SPAs and a bare-path note otherwise', () => {
    const lines = tracesListingLines(listing, (spa) => (spa === 'saga-dash' ? '/repo/apps/web/dash' : null));
    expect(lines[0]).toContain('2026-07-09_15-00-00  saga-dash/periods-ordering  (1 trace(s), 1 report(s))');
    expect(lines[1]).toBe('    [report] cd /repo/apps/web/dash && pnpm exec playwright show-report /runs/a/playwright-report');
    expect(lines[2]).toBe('    [ordering] cd /repo/apps/web/dash && pnpm exec playwright show-trace /runs/a/trace.zip');
    expect(lines.some((l) => l.includes('spa repo not resolved'))).toBe(true);
  });
});

describe('newestReport', () => {
  it('prefers the newest run that preserved a whole-run report', () => {
    expect(newestReport(listing)).toEqual({ spaId: 'saga-dash', report: '/runs/a/playwright-report' });
  });

  it('returns null when no run preserved one (--open falls back to show-trace)', () => {
    expect(newestReport([listing[1]])).toBeNull();
    expect(newestReport([])).toBeNull();
  });
});

describe('newestTrace', () => {
  it('returns the first trace of the newest-first listing', () => {
    expect(newestTrace(listing)).toEqual({ spaId: 'saga-dash', trace: '/runs/a/trace.zip' });
  });

  it('skips runs without traces and returns null when nothing has one', () => {
    expect(newestTrace([{ ...listing[0], stages: [] }, listing[1]])).toEqual({
      spaId: 'unknown-spa',
      trace: '/runs/b/trace.zip',
    });
    expect(newestTrace([])).toBeNull();
  });
});
