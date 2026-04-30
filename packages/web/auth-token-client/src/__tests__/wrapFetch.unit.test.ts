import { describe, expect, it, vi } from 'vitest';
import { wrapFetchForJanus } from '../wrapFetch.js';

describe('wrapFetchForJanus', () => {
  it('passes 200 responses through untouched', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const navigate = vi.fn();
    const wrapped = wrapFetchForJanus(fetchImpl, { navigate });
    const res = await wrapped('https://api.wootdev.com/');
    expect(res.status).toBe(200);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('passes 401 responses without a Janus header through', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const navigate = vi.fn();
    const wrapped = wrapFetchForJanus(fetchImpl, { navigate });
    const res = await wrapped('https://api.wootdev.com/');
    expect(res.status).toBe(401);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates on 401 with a Janus WWW-Authenticate header', async () => {
    const headers = new Headers({
      'www-authenticate': 'Janus realm="wootdev", login="https://login.wootdev.com/?next=https%3A%2F%2Fdash.wootdev.com%2F&reasons=unauthenticated"',
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 401, headers }));
    const navigate = vi.fn();
    const wrapped = wrapFetchForJanus(fetchImpl, {
      navigate,
      currentUrl: () => 'https://dash.wootdev.com/admin',
    });
    await wrapped('https://api.wootdev.com/');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).toContain('login.wootdev.com');
  });

  it('falls back to current URL when server login URL lacks a next', async () => {
    const headers = new Headers({
      'www-authenticate': 'Janus realm="wootdev", login="https://login.wootdev.com/"',
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 401, headers }));
    const navigate = vi.fn();
    const wrapped = wrapFetchForJanus(fetchImpl, {
      navigate,
      currentUrl: () => 'https://dash.wootdev.com/admin',
    });
    await wrapped('https://api.wootdev.com/');
    expect(navigate).toHaveBeenCalledOnce();
    const url = navigate.mock.calls[0]?.[0] ?? '';
    expect(url).toContain('next=https%3A%2F%2Fdash.wootdev.com%2Fadmin');
    expect(url).toContain('reasons=unauthenticated');
  });

  it('suppressNavigation returns the response without redirecting', async () => {
    const headers = new Headers({
      'www-authenticate': 'Janus realm="wootdev", login="https://login.wootdev.com/"',
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 401, headers }));
    const navigate = vi.fn();
    const wrapped = wrapFetchForJanus(fetchImpl, { navigate, suppressNavigation: true });
    const res = await wrapped('https://api.wootdev.com/');
    expect(res.status).toBe(401);
    expect(navigate).not.toHaveBeenCalled();
  });
});
