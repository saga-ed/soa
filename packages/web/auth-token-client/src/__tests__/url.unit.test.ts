import { describe, expect, it } from 'vitest';
import { buildLoginUrl, isAllowedNext } from '../url.js';

describe('buildLoginUrl', () => {
  it('uses the default host when no override or preview cookie is set', () => {
    const url = buildLoginUrl(
      { next: 'https://dash.wootdev.com/admin', reasons: ['unauthenticated'] },
      { cookieHeader: '' },
    );
    expect(url).toMatch(/^https:\/\/login\.wootdev\.com\/\?/);
    expect(decodeURIComponent(url)).toContain('next=https://dash.wootdev.com/admin');
    expect(url).toContain('reasons=unauthenticated');
  });

  it('honors the preview cookie when present', () => {
    const url = buildLoginUrl(
      { next: 'https://dash.wootdev.com/admin', reasons: ['jumpcloud_required'] },
      { cookieHeader: 'x-saga-preview-login=pr-2; other=foo' },
    );
    expect(url).toMatch(/^https:\/\/pr-2\.login\.wootdev\.com\//);
  });

  it('joins multiple reasons with commas', () => {
    const url = buildLoginUrl(
      {
        next: 'https://dash.wootdev.com/admin',
        reasons: ['jumpcloud_required', 'iam_required'],
      },
      { cookieHeader: '' },
    );
    expect(url).toContain('reasons=jumpcloud_required%2Ciam_required');
  });

  it('explicit hostOverride wins over the preview cookie', () => {
    const url = buildLoginUrl(
      { next: 'https://dash.wootdev.com/', reasons: [] },
      { cookieHeader: 'x-saga-preview-login=pr-2', hostOverride: 'login.wootdev.com' },
    );
    expect(url).toMatch(/^https:\/\/login\.wootdev\.com\//);
  });

  it('rejects unsafe preview cookie values silently', () => {
    const url = buildLoginUrl(
      { next: 'https://dash.wootdev.com/', reasons: [] },
      { cookieHeader: 'x-saga-preview-login=evil.example.com' },
    );
    expect(url).toMatch(/^https:\/\/login\.wootdev\.com\//);
  });
});

describe('isAllowedNext', () => {
  it('accepts wootdev hosts', () => {
    expect(isAllowedNext('https://dash.wootdev.com/admin')).toBe(true);
    expect(isAllowedNext('https://pr-5.dash.wootdev.com/admin')).toBe(true);
    expect(isAllowedNext('https://wootdev.com/')).toBe(true);
  });

  it('rejects non-wootdev hosts', () => {
    expect(isAllowedNext('https://evil.example.com/')).toBe(false);
    expect(isAllowedNext('https://wootdev.com.evil.example.com/')).toBe(false);
  });

  it('rejects http URLs', () => {
    expect(isAllowedNext('http://dash.wootdev.com/')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedNext('not-a-url')).toBe(false);
    expect(isAllowedNext('//dash.wootdev.com/')).toBe(false);
  });

  it('honors a custom allowlist', () => {
    expect(isAllowedNext('https://app.saga.org/', ['.saga.org'])).toBe(true);
    expect(isAllowedNext('https://dash.wootdev.com/', ['.saga.org'])).toBe(false);
  });
});
