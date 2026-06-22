import { describe, it, expect } from 'vitest';
import { buildIamLoginUrl, nextUrlFromReferer } from './saga-auth-url.js';

/**
 * @spec specs/contracts/saga-auth-signal.spec.md
 *
 * These primitives back the `WWW-Authenticate: SagaAuth …` challenge every
 * SagaAuth-emitting service builds. Ported from the byte-/behavior-identical
 * copies previously living in program-hub-service-kit and rostering's iam-api.
 */

describe('buildIamLoginUrl', () => {
  it('emits reasons=iam_required + next= when next is provided', () => {
    expect(
      buildIamLoginUrl({
        loginBaseUrl: 'https://login.wootdev.com',
        next: 'https://dash.wootdev.com/some/page',
      }),
    ).toBe(
      'https://login.wootdev.com/?reasons=iam_required&next=https%3A%2F%2Fdash.wootdev.com%2Fsome%2Fpage',
    );
  });

  it('omits next= when not provided', () => {
    expect(buildIamLoginUrl({ loginBaseUrl: 'https://login.wootdev.com' })).toBe(
      'https://login.wootdev.com/?reasons=iam_required',
    );
  });

  it('handles a trailing slash on loginBaseUrl idempotently', () => {
    expect(buildIamLoginUrl({ loginBaseUrl: 'https://login.wootdev.com/' })).toBe(
      'https://login.wootdev.com/?reasons=iam_required',
    );
  });

  it('collapses multiple trailing slashes idempotently', () => {
    expect(buildIamLoginUrl({ loginBaseUrl: 'https://login.wootdev.com///' })).toBe(
      'https://login.wootdev.com/?reasons=iam_required',
    );
  });

  it('preserves a non-root path on loginBaseUrl', () => {
    expect(buildIamLoginUrl({ loginBaseUrl: 'https://login.wootdev.com/auth' })).toBe(
      'https://login.wootdev.com/auth?reasons=iam_required',
    );
  });

  it('preserves a deep non-root path while dropping its trailing slash', () => {
    expect(buildIamLoginUrl({ loginBaseUrl: 'https://login.x.com/deep/path/' })).toBe(
      'https://login.x.com/deep/path?reasons=iam_required',
    );
  });

  it('url-encodes special characters in next=', () => {
    expect(
      buildIamLoginUrl({ loginBaseUrl: 'https://login.x.com', next: 'https://a/b&c=d e' }),
    ).toBe('https://login.x.com/?reasons=iam_required&next=https%3A%2F%2Fa%2Fb%26c%3Dd+e');
  });
});

describe('nextUrlFromReferer', () => {
  it('returns the Referer when it is a valid https URL', () => {
    expect(nextUrlFromReferer('https://dash.wootdev.com/foo')).toBe(
      'https://dash.wootdev.com/foo',
    );
  });

  it('returns undefined when undefined or empty', () => {
    expect(nextUrlFromReferer(undefined)).toBeUndefined();
    expect(nextUrlFromReferer('')).toBeUndefined();
  });

  it('rejects non-https Referer values (open-redirect prevention)', () => {
    expect(nextUrlFromReferer('http://attacker.example/')).toBeUndefined();
  });

  it('rejects malformed Referer values', () => {
    expect(nextUrlFromReferer('not a url')).toBeUndefined();
  });
});
