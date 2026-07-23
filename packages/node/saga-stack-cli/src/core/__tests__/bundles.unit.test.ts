/**
 * Service-bundle registry + resolution helpers (saga-ed/soa#214).
 *
 * `--with <bundle>` is pure sugar over `--only`: `expandBundles` unions a
 * bundle's service-ids (deduped, registry-ordered), `combineRequested` unions
 * that with `--only`, and `effectiveWithPlayback` reports whether the optional
 * playback trio should survive the closure's optional filter. All PURE.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLES,
  BUNDLE_NAMES,
  BUNDLE_SEED_ADDONS,
  SERVICE_BUNDLES,
  combineRequested,
  effectiveWithPlayback,
  expandBundles,
  seedAddOnsFor,
} from '../bundles.js';

/** A `fail` that throws so a test can assert the unknown-name path. */
const throwFail = (msg: string): never => {
  throw new Error(msg);
};

describe('bundle registry', () => {
  it('exposes the six bundle names in registry order', () => {
    expect(BUNDLE_NAMES).toEqual(['dash', 'connect', 'coach', 'playback', 'qtf', 'authz']);
  });

  it('every bundle carries a non-empty description', () => {
    for (const name of BUNDLE_NAMES) {
      expect(BUNDLES[name].description.length).toBeGreaterThan(0);
    }
  });

  it('derives SERVICE_BUNDLES → service-ids (qtf is seed-only, no services)', () => {
    expect(SERVICE_BUNDLES.dash).toEqual(['saga-dash']);
    expect(SERVICE_BUNDLES.connect).toEqual(['connect-api', 'connect-web']);
    expect(SERVICE_BUNDLES.coach).toEqual(['coach-api', 'coach-web']);
    expect(SERVICE_BUNDLES.playback).toEqual(['transcripts-api', 'insights-api', 'chat-api']);
    expect(SERVICE_BUNDLES.qtf).toEqual([]);
    expect(SERVICE_BUNDLES.authz).toEqual(['authz-sync', 'authz-api']);
  });

  it('derives BUNDLE_SEED_ADDONS only for the seed-bearing bundles', () => {
    expect(BUNDLE_SEED_ADDONS).toEqual({ playback: 'playback', qtf: 'qtf', authz: 'authz' });
  });
});

describe('expandBundles', () => {
  it('expands a single bundle to its ids', () => {
    expect(expandBundles(['coach'], throwFail)).toEqual(['coach-api', 'coach-web']);
  });

  it('unions multiple bundles', () => {
    expect(expandBundles(['dash', 'coach'], throwFail)).toEqual([
      'saga-dash',
      'coach-api',
      'coach-web',
    ]);
  });

  it('dedups overlapping / repeated bundles', () => {
    expect(expandBundles(['coach', 'coach'], throwFail)).toEqual(['coach-api', 'coach-web']);
  });

  it('preserves registry order regardless of arg order (dash before coach)', () => {
    expect(expandBundles(['coach', 'dash'], throwFail)).toEqual(
      expandBundles(['dash', 'coach'], throwFail),
    );
    expect(expandBundles(['coach', 'dash'], throwFail)).toEqual([
      'saga-dash',
      'coach-api',
      'coach-web',
    ]);
  });

  it('a seed-only bundle (qtf) contributes no services', () => {
    expect(expandBundles(['qtf'], throwFail)).toEqual([]);
    expect(expandBundles(['coach', 'qtf'], throwFail)).toEqual(['coach-api', 'coach-web']);
  });

  it('empty input ⇒ empty output', () => {
    expect(expandBundles([], throwFail)).toEqual([]);
  });

  it('calls fail (listing valid names) on an unknown bundle', () => {
    const fail = vi.fn(throwFail);
    expect(() => expandBundles(['bogus'], fail)).toThrow(/unknown bundle: bogus/);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][0]).toContain('dash, connect, coach, playback');
  });
});

describe('combineRequested — parseOnly(only) ∪ expandBundles(with)', () => {
  it('only alone', () => {
    expect(combineRequested('sessions-api,scheduling-api', undefined, throwFail)).toEqual([
      'sessions-api',
      'scheduling-api',
    ]);
  });

  it('with alone', () => {
    expect(combineRequested(undefined, ['coach'], throwFail)).toEqual(['coach-api', 'coach-web']);
  });

  it('unions only + with (only ids first, then bundle ids)', () => {
    expect(combineRequested('sessions-api', ['playback'], throwFail)).toEqual([
      'sessions-api',
      'transcripts-api',
      'insights-api',
      'chat-api',
    ]);
  });

  it('dedups an id present in both only and a bundle', () => {
    expect(combineRequested('saga-dash', ['dash'], throwFail)).toEqual(['saga-dash']);
  });

  it('a seed-only bundle (qtf) adds no services — requested is only', () => {
    expect(combineRequested('sessions-api', ['qtf'], throwFail)).toEqual(['sessions-api']);
    expect(combineRequested(undefined, ['qtf'], throwFail)).toEqual([]);
  });

  it('neither ⇒ empty', () => {
    expect(combineRequested(undefined, undefined, throwFail)).toEqual([]);
  });
});

describe('effectiveWithPlayback', () => {
  it('true iff the playback bundle is requested', () => {
    expect(effectiveWithPlayback(['playback'])).toBe(true);
    expect(effectiveWithPlayback(['dash', 'playback'])).toBe(true);
  });

  it('false for other bundles / empty / undefined', () => {
    expect(effectiveWithPlayback(['coach'])).toBe(false);
    expect(effectiveWithPlayback(['qtf'])).toBe(false);
    expect(effectiveWithPlayback([])).toBe(false);
    expect(effectiveWithPlayback(undefined)).toBe(false);
  });
});

describe('seedAddOnsFor', () => {
  it('maps playback/qtf features to their seed add-ons', () => {
    expect(seedAddOnsFor(['playback'])).toEqual(['playback']);
    expect(seedAddOnsFor(['qtf'])).toEqual(['qtf']);
    expect(seedAddOnsFor(['playback', 'qtf'])).toEqual(['playback', 'qtf']);
  });

  it('service-only bundles contribute no seed add-on', () => {
    expect(seedAddOnsFor(['dash', 'coach'])).toEqual([]);
    expect(seedAddOnsFor([])).toEqual([]);
    expect(seedAddOnsFor(undefined)).toEqual([]);
  });

  it('dedups a repeated add-on', () => {
    expect(seedAddOnsFor(['qtf', 'qtf'])).toEqual(['qtf']);
  });
});
