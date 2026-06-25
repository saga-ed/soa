import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { applyBaseMiddleware, buildSagaCorsOptions } from '../base-middleware.js';
import type { BootstrapLogger } from '../types.js';

function fakeLogger(): BootstrapLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function appWithBase() {
  const app = express();
  applyBaseMiddleware(app, {
    logger: fakeLogger(),
    cors: { devOrigins: ['http://localhost:5173'], env: { NODE_ENV: 'test' } },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/echo', (req, res) => res.json(req.body));
  return app;
}

describe('applyBaseMiddleware', () => {
  it('echoes/sets an x-request-id header', async () => {
    const res = await request(appWithBase()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('honours an inbound x-request-id', async () => {
    const res = await request(appWithBase())
      .get('/health')
      .set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('parses JSON bodies', async () => {
    const res = await request(appWithBase())
      .post('/echo')
      .send({ hello: 'world' });
    expect(res.body).toEqual({ hello: 'world' });
  });
});

describe('buildSagaCorsOptions', () => {
  const opts = buildSagaCorsOptions({
    devOrigins: ['http://localhost:5173'],
    env: { NODE_ENV: 'development' },
  });
  const originFn = opts.origin as (
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void,
  ) => void;

  it('allows a configured dev origin', () => {
    const cb = vi.fn();
    originFn('http://localhost:5173', cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('allows a *.wootdev.com subdomain', () => {
    const cb = vi.fn();
    originFn('https://pr-2.dash.wootdev.com', cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('allows no-origin (server-to-server) requests', () => {
    const cb = vi.fn();
    originFn(undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('rejects an unknown origin', () => {
    const cb = vi.fn();
    originFn('https://evil.example.com', cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('exposes WWW-Authenticate for the SagaAuth interceptor', () => {
    expect(opts.exposedHeaders).toContain('WWW-Authenticate');
  });
});
