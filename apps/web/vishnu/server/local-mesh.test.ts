import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { localMeshMiddleware } from './local-mesh';
import { createFixture } from '../src/lib/fixtures/mesh';

function request(url: string, overrides = {}) {
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost:8930' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as IncomingMessage;
}
function response() {
  let status = 200;
  let value: unknown;
  const res = {
    set statusCode(code: number) {
      status = code;
    },
    setHeader() {},
    end(body: string) {
      value = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, value }) };
}

describe('synthetic-dev HTTP bridge', () => {
  it('keeps live mode explicit and disabled APIs never return fixtures', async () => {
    const middleware = localMeshMiddleware({});
    const res = response();
    await middleware(request('/api/mesh'), res.res, () => {});
    expect(res.result().status).toBe(503);
    expect(res.result().value).not.toHaveProperty('systems');
  });
  it('uses configured slot and state directory and coalesces requests', async () => {
    const snapshot = { ...createFixture(), mode: 'live' as const, slot: 3 };
    const collect = vi.fn(async () => snapshot);
    const create = vi.fn(() => collect);
    const loader = vi.fn(async () => create);
    const middleware = localMeshMiddleware(
      {
        VISHNU_MODE: 'synthetic',
        VISHNU_SLOT: '3',
        VISHNU_SOA_ROOT: '/checkout',
        VISHNU_STATE_DIR: '/custom-state',
      },
      loader
    );
    const a = response(),
      b = response();
    await Promise.all([
      middleware(request('/api/mesh'), a.res, () => {}),
      middleware(request('/api/mesh'), b.res, () => {}),
    ]);
    expect(loader).toHaveBeenCalledWith('/checkout');
    expect(create).toHaveBeenCalledWith({ slot: 3, stateDir: '/custom-state' });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(a.result()).toEqual({ status: 200, value: snapshot });
    expect(b.result()).toEqual(a.result());
  });
  it('rejects remote access, cross-origin reads, arbitrary targets, and mutations', async () => {
    const loader = vi.fn();
    const middleware = localMeshMiddleware({ VISHNU_MODE: 'synthetic' }, loader);
    for (const route of ['/api/mesh', '/api/event-stats']) {
    for (const req of [
      request(route, { socket: { remoteAddress: '192.0.2.1' } }),
      request(route, { headers: { host: 'evil.example' } }),
      request(route, { headers: { host: 'localhost:8930', origin: 'https://evil.example' } }),
      request(`${route}?target=https://example.com`),
      request(route, { method: 'POST' }),
    ]) {
      const res = response();
      await middleware(req, res.res, () => {});
      expect(res.result().status).toBeGreaterThanOrEqual(400);
    }
    }
    expect(loader).not.toHaveBeenCalled();
  });
  it('refuses invalid slots and does not disclose initialization errors', async () => {
    const middleware = localMeshMiddleware(
      { VISHNU_MODE: 'synthetic', VISHNU_SLOT: 'bad' },
      async () => {
        throw new Error('secret local path');
      }
    );
    const res = response();
    await middleware(request('/api/health'), res.res, () => {});
    expect(res.result().status).toBe(503);
    expect(JSON.stringify(res.result())).not.toContain('secret');
  });
});
