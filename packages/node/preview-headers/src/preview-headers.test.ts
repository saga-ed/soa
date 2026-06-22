import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER_PREFIX,
  extractPreviewHeaders,
  parseOriginateMap,
  toPreviewHeaderName,
  toServiceKey,
} from './index.js';

afterEach(() => {
  vi.resetModules();
  delete process.env.PREVIEW_ORIGINATE_MAP;
});

/** Re-import store/forward with PREVIEW_ORIGINATE_MAP set (parsed at load). */
async function loadWithEnv(raw: string | undefined) {
  vi.resetModules();
  if (raw === undefined) delete process.env.PREVIEW_ORIGINATE_MAP;
  else process.env.PREVIEW_ORIGINATE_MAP = raw;
  return import('./index.js');
}

describe('header-key transforms', () => {
  it('prefix is the canonical x-saga-preview-', () => {
    expect(HEADER_PREFIX).toBe('x-saga-preview-');
  });

  it('toPreviewHeaderName accepts short and full forms, lowercases', () => {
    expect(toPreviewHeaderName('iam-api')).toBe('x-saga-preview-iam-api');
    expect(toPreviewHeaderName('X-Saga-Preview-Iam-Api')).toBe('x-saga-preview-iam-api');
    expect(toServiceKey('x-saga-preview-iam-api')).toBe('iam-api');
  });

  it('extractPreviewHeaders keeps only string x-saga-preview-* entries (lowercased)', () => {
    expect(
      extractPreviewHeaders({
        'X-Saga-Preview-Iam-Api': 'sandbox-a',
        'content-type': 'application/json',
        'x-saga-preview-multi': ['a', 'b'], // array-valued → skipped
      }),
    ).toEqual({ 'x-saga-preview-iam-api': 'sandbox-a' });
  });
});

describe('parseOriginateMap', () => {
  it('parses short + full forms, ignores malformed/empty pairs', () => {
    expect(
      parseOriginateMap(',iam-api=sandbox-a,=sandbox-x, , x-saga-preview-scheduling-api=sandbox-b ,'),
    ).toEqual({
      'x-saga-preview-iam-api': 'sandbox-a',
      'x-saga-preview-scheduling-api': 'sandbox-b',
    });
  });

  it('empty/undefined → empty map', () => {
    expect(parseOriginateMap(undefined)).toEqual({});
    expect(parseOriginateMap('')).toEqual({});
  });
});

describe('getPreviewHeaders origination map', () => {
  it('is empty (forward-only) when no map is configured', async () => {
    const { getPreviewHeaders } = await loadWithEnv(undefined);
    expect(getPreviewHeaders()).toEqual({});
  });

  it('originates a header for a sandbox downstream with no inbound request', async () => {
    const { getPreviewHeaders } = await loadWithEnv('iam-api=sandbox-alice');
    expect(getPreviewHeaders()).toEqual({ 'x-saga-preview-iam-api': 'sandbox-alice' });
  });

  it('lets an inbound header win its own key while the map fills the others', async () => {
    const { getPreviewHeaders, runWithPreviewHeaders } = await loadWithEnv(
      'iam-api=sandbox-map,scheduling-api=sandbox-map',
    );
    runWithPreviewHeaders({ 'x-saga-preview-iam-api': 'pr-42' }, () => {
      expect(getPreviewHeaders()).toEqual({
        'x-saga-preview-iam-api': 'pr-42', // inbound wins its key
        'x-saga-preview-scheduling-api': 'sandbox-map', // map fills the gap
      });
    });
  });
});

describe('withPreviewHeaders forward helper', () => {
  it('merges preview headers under the caller bag (caller wins per-key)', async () => {
    const { withPreviewHeaders, runWithPreviewHeaders } = await loadWithEnv(undefined);
    runWithPreviewHeaders({ 'x-saga-preview-iam-api': 'pr-7' }, () => {
      expect(withPreviewHeaders({ 'x-service-token': 'tok' })).toEqual({
        'x-saga-preview-iam-api': 'pr-7',
        'x-service-token': 'tok',
      });
    });
  });

  it('a caller header never gets clobbered by a same-named preview header', async () => {
    const { withPreviewHeaders, runWithPreviewHeaders } = await loadWithEnv(undefined);
    runWithPreviewHeaders({ 'x-saga-preview-iam-api': 'pr-7' }, () => {
      // contrived collision: caller explicitly overrides → caller wins
      expect(withPreviewHeaders({ 'x-saga-preview-iam-api': 'forced' })).toEqual({
        'x-saga-preview-iam-api': 'forced',
      });
    });
  });
});
