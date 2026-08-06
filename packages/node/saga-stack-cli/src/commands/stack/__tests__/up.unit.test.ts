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
import { combineRequested, effectiveWithPlayback } from '../../../core/bundles.js';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { ServiceId } from '../../../core/manifest/index.js';

const fail = (msg: string): never => {
  throw new Error(msg);
};

describe('stack up --dry-run — closure planning path', () => {
  it('plans the {scheduling-api, sessions-api} partial stack the command emits', () => {
    // Mirrors StackUp.run: parse --only → computeClosure(manifest, requested).
    const requested = 'scheduling-api,sessions-api'
      .split(',')
      .map((s) => s.trim()) as ServiceId[];
    const closure = computeClosure(manifest, requested);

    expect(closure.services).toEqual([
      'iam-api',
      'authz-api', // soa#402 — transitive through sessions-api
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
      'authz_local', // soa#402
    ]);
    expect(closure.mesh).toEqual(['postgres', 'redis', 'rabbitmq']); // redis via iam-api
  });

  it('full-stack dry-run (no --only) plans every non-optional service', () => {
    const fullRequest = Object.values(manifest.services)
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const closure = computeClosure(manifest, fullRequest);
    // 14 non-optional services (10 core + rtsm-api + coach-api/coach-web + authz-api,
    // soa#402); no playback.
    expect(closure.services).toHaveLength(14);
    expect(closure.services).not.toContain('transcripts-api');
    expect(closure.mesh).toContain('connect-mongo'); // connect-api in the full set
  });

  it('--with coach (dry-run) plans the {iam-api, coach-api, coach-web, programs-api} closure', () => {
    // Mirrors StackUp.run: requested = combineRequested(only, with) → computeClosure.
    const requested = combineRequested(undefined, ['coach'], fail);
    const closure = computeClosure(manifest, requested, {
      withPlayback: effectiveWithPlayback(['coach']),
    });
    // programs-api rides in on coach-web's `browser` edge (coach#329): the Reports
    // program filter fetches programs.list from the browser, so an interactive
    // `--with coach` that omitted it would hand coach-web a dead localhost:3006.
    expect(new Set(closure.services)).toEqual(
      new Set(['iam-api', 'coach-api', 'coach-web', 'programs-api']),
    );
    // …and the closure unions programs-api's own db + broker with it.
    expect(closure.databases).toContain('programs');
    expect(closure.mesh).toContain('rabbitmq');
  });

  it('--with playback (dry-run) plans the playback closure, not the full stack', () => {
    const requested = combineRequested(undefined, ['playback'], fail);
    const closure = computeClosure(manifest, requested, {
      withPlayback: effectiveWithPlayback(['playback']),
    });
    expect(new Set(closure.services)).toEqual(
      new Set(['transcripts-api', 'insights-api', 'chat-api']),
    );
    expect(closure.services).not.toContain('saga-dash');
  });

  it.todo('oclif harness: emit() stdout shape (--output-json / --porcelain / text)');
  it.todo('oclif harness: errors without --dry-run (live launch is M1+)');
});
