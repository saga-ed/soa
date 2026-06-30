/**
 * `stack up --dry-run` — planning-path coverage (plan §6.3, §6.4).
 *
 * The M0 command is a thin wrapper over the pure closure engine: it parses
 * `--only`, calls `computeClosure`, and `emit()`s the result. There is no IO to
 * mock. This suite asserts the exact closure the command would emit for the
 * canonical dry-run invocation, so the command's contract is pinned without a
 * docker/pnpm/oclif-harness dependency.
 *
 * MANUAL INVOCATION (no build required — bin/dev.js uses the tsx loader):
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run --output-json
 *
 * Expected (text): services in launch order iam-api -> programs-api ->
 * scheduling-api -> sessions-api; databases iam_local,iam_pii_local,programs,
 * scheduling,sessions; mesh postgres,rabbitmq.
 *
 * A full in-process oclif command test (capturing emit() stdout, asserting the
 * non-dry-run error path) lands once `@oclif/test`'s `runCommand` harness is on
 * devDeps — recorded below as `it.todo`.
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { ServiceId } from '../../../core/manifest/index.js';

describe('stack up --dry-run — closure planning path', () => {
  it('plans the {scheduling-api, sessions-api} partial stack the command emits', () => {
    // Mirrors StackUp.run: parse --only → computeClosure(manifest, requested).
    const requested = 'scheduling-api,sessions-api'
      .split(',')
      .map((s) => s.trim()) as ServiceId[];
    const closure = computeClosure(manifest, requested);

    expect(closure.services).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
    expect(closure.databases).toEqual([
      'iam_local',
      'iam_pii_local',
      'programs',
      'scheduling',
      'sessions',
    ]);
    expect(closure.mesh).toEqual(['postgres', 'rabbitmq']);
  });

  it('full-stack dry-run (no --only) plans every non-optional service', () => {
    const fullRequest = Object.values(manifest.services)
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const closure = computeClosure(manifest, fullRequest);
    // 11 non-optional services (10 core + rtsm-api); no playback.
    expect(closure.services).toHaveLength(11);
    expect(closure.services).not.toContain('transcripts-api');
    expect(closure.mesh).toContain('connect-mongo'); // connect-api in the full set
  });

  it.todo('oclif harness: emit() stdout shape (--output-json / --porcelain / text)');
  it.todo('oclif harness: errors without --dry-run (live launch is M1+)');
});
