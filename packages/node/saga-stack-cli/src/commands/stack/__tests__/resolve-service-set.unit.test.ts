/**
 * `resolveServiceSet` — the shared `--only`/`--with` resolution (saga-ed/soa#214).
 *
 * The exported helper backs `stack status` and `stack verify` (and mirrors
 * `stack up`'s resolution). It is pure over the real manifest — no IO — so these
 * cases pin the exact bundle semantics without an oclif/HTTP harness:
 *   requested = parseOnly(only) ∪ expandBundles(with);
 *   withPlaybackEff = with.includes('playback');
 *   empty requested ⇒ every non-optional; else computeClosure(requested).
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { ServiceId } from '../../../core/manifest/index.js';
import { resolveServiceSet } from '../status.js';

/** A `fail` that throws so the unknown-bundle path is observable. */
const throwFail = (msg: string): never => {
  throw new Error(msg);
};

const resolve = (only: string | undefined, withB: string[] | undefined): ServiceId[] =>
  resolveServiceSet(only, withB, throwFail);

describe('resolveServiceSet — --with is sugar over --only', () => {
  it('--with coach ⇒ closure {iam-api, coach-api, coach-web}', () => {
    expect(new Set(resolve(undefined, ['coach']))).toEqual(
      new Set(['iam-api', 'coach-api', 'coach-web']),
    );
  });

  it('--with playback ⇒ the 3 playback services (NOT the whole stack)', () => {
    const ids = resolve(undefined, ['playback']);
    expect(new Set(ids)).toEqual(new Set(['transcripts-api', 'insights-api', 'chat-api']));
    // narrowed — the full non-optional stack (saga-dash, connect-api, …) is absent.
    expect(ids).not.toContain('saga-dash');
    expect(ids).not.toContain('connect-api');
  });

  it('--only sessions-api --with playback ⇒ sessions closure ∪ the 3 playback services', () => {
    const ids = new Set(resolve('sessions-api', ['playback']));
    // sessions-api closure (iam + programs + sessions) …
    for (const id of computeClosure(manifest, ['sessions-api']).services) expect(ids).toContain(id);
    // … plus all three playback services survive (withPlayback set by --with playback).
    expect(ids).toContain('transcripts-api');
    expect(ids).toContain('insights-api');
    expect(ids).toContain('chat-api');
  });

  it('--with dash --with coach ⇒ the union of both closures', () => {
    const ids = new Set(resolve(undefined, ['dash', 'coach']));
    const dash = computeClosure(manifest, ['saga-dash']).services;
    const coach = computeClosure(manifest, ['coach-api', 'coach-web']).services;
    expect(ids).toEqual(new Set([...dash, ...coach]));
  });

  it('empty (no --only, no --with) ⇒ every NON-optional service (no playback)', () => {
    const ids = resolve(undefined, undefined);
    expect(ids).toHaveLength(13); // 10 core + rtsm-api + coach-api/coach-web
    expect(ids).not.toContain('transcripts-api');
  });

  it('--with qtf ⇒ seed-only, no services ⇒ requested empty ⇒ full non-optional stack', () => {
    // qtf contributes no services, so the set matches the default full stack.
    expect(resolve(undefined, ['qtf'])).toEqual(resolve(undefined, undefined));
  });

  it('--only sessions-api --with qtf ⇒ sessions closure only (qtf adds no services)', () => {
    expect(resolve('sessions-api', ['qtf'])).toEqual(
      computeClosure(manifest, ['sessions-api']).services,
    );
  });

  it('an unknown bundle name fails (expandBundles guards even past oclif options)', () => {
    expect(() => resolve(undefined, ['bogus'])).toThrow(/unknown bundle: bogus/);
  });

  it('an unknown service id in --only still fails', () => {
    expect(() => resolve('nope-api', undefined)).toThrow(/unknown service id/);
  });
});
