import { describe, expect, it, vi } from 'vitest';
import { TIMEOUT } from '../readiness.js';
import { awsProbe } from '../aws.js';
import { openfgaProbe } from '../openfga.js';
import { httpProbe, mongoProbe, pgFreshProbe, rabbitProbe, redisProbe, sqlProbe } from '../deep/adapters.js';
import { classifyError } from '../deep/classify.js';

describe('adapters (fake clients)', () => {
  it('postgres: Prisma-like uses $queryRawUnsafe SELECT 1', async () => {
    const c = { $queryRawUnsafe: vi.fn(async () => []) };
    await sqlProbe(c);
    expect(c.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });
  it('postgres: pg-like uses query SELECT 1', async () => {
    const c = { query: vi.fn(async () => ({})) };
    await sqlProbe(c);
    expect(c.query).toHaveBeenCalledWith('SELECT 1');
  });
  it('postgres: rejects an unknown client shape', async () => {
    await expect(sqlProbe({})).rejects.toThrow(TypeError);
  });
  it('postgres: propagates driver rejection', async () => {
    await expect(sqlProbe({ query: async () => Promise.reject(new Error('x')) })).rejects.toThrow('x');
  });

  it('mongo: MongoClient-like pings the admin db', async () => {
    const command = vi.fn(async () => ({ ok: 1 }));
    const db = vi.fn(() => ({ command }));
    await mongoProbe({ db });
    expect(db).toHaveBeenCalledWith('admin');
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });
  it('mongo: Db-like', async () => {
    const command = vi.fn(async () => ({ ok: 1 }));
    await mongoProbe({ command });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('redis: PONG is ok, anything else is unexpected_response', async () => {
    expect(await redisProbe({ ping: async () => 'PONG' })).toEqual({ ok: true });
    expect(await redisProbe({ ping: async () => 'pong' })).toEqual({ ok: true });
    expect(await redisProbe({ ping: async () => 'LOADING' })).toEqual({ ok: false, reason: 'unexpected_response' });
  });

  it('rabbitmq: one dedicated channel per connection, reused, checkExchange on it', async () => {
    const ch = { checkExchange: vi.fn(async () => ({})), on: vi.fn() };
    const conn = { createChannel: vi.fn(async () => ch) };
    await rabbitProbe(conn, 'events');
    await rabbitProbe(conn, 'events');
    expect(conn.createChannel).toHaveBeenCalledTimes(1);
    expect(ch.checkExchange).toHaveBeenCalledTimes(2);
  });
  it('rabbitmq: a closed probe channel is dropped and recreated', async () => {
    const handlers: Record<string, () => void> = {};
    const ch = {
      checkExchange: vi.fn(async () => ({})),
      on: vi.fn((ev: string, cb: () => void) => void (handlers[ev] = cb)),
    };
    const conn = { createChannel: vi.fn(async () => ch) };
    await rabbitProbe(conn, 'x');
    handlers.close!();
    await rabbitProbe(conn, 'x');
    expect(conn.createChannel).toHaveBeenCalledTimes(2);
  });
  it('rabbitmq: a passive-check failure rejects (channel-level), createChannel failure is not cached', async () => {
    const conn = {
      createChannel: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue({ checkExchange: async () => ({}), on: () => undefined }),
    };
    await expect(rabbitProbe(conn)).rejects.toThrow('down');
    await rabbitProbe(conn);
    expect(conn.createChannel).toHaveBeenCalledTimes(2);
  });

  it('http: uses the raw probeFetch handle; 2xx ok, else unexpected_response', async () => {
    const signal = new AbortController().signal;
    const probeFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    expect(await httpProbe({ probeFetch }, 'http://up/health/live', signal)).toEqual({ ok: true });
    expect(probeFetch).toHaveBeenCalledWith('http://up/health/live', { method: 'GET', signal });
    expect(await httpProbe({ probeFetch: async () => ({ ok: false, status: 500 }) }, 'u', signal)).toEqual({
      ok: false,
      reason: 'unexpected_response',
    });
    await expect(httpProbe({ probeFetch }, undefined, signal)).rejects.toThrow(TypeError);
  });

  it('openfga: latest model present is ok, absent is unexpected_response', async () => {
    const signal = new AbortController().signal;
    expect(await openfgaProbe({ readLatestAuthorizationModel: async () => ({ authorization_model: {} }) }, signal)).toEqual({ ok: true });
    expect(await openfgaProbe({ readLatestAuthorizationModel: async () => ({}) }, signal)).toEqual({
      ok: false,
      reason: 'unexpected_response',
    });
    expect(await openfgaProbe({ readAuthorizationModels: async () => ({}) }, signal)).toEqual({ ok: true });
    await expect(openfgaProbe({}, signal)).rejects.toThrow(TypeError);
  });

  it('aws: wraps only the caller-supplied operation (no default)', async () => {
    const op = vi.fn(async () => ({}));
    const client = { send: vi.fn() };
    const signal = new AbortController().signal;
    expect(await awsProbe(op)(client, signal)).toEqual({ ok: true });
    expect(op).toHaveBeenCalledWith(client, signal);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('classifyError', () => {
  const e = (props: Record<string, unknown>, message = '') => Object.assign(new Error(message), props);
  it.each([
    [TIMEOUT, 'timeout'],
    [e({ code: 'ECONNREFUSED' }), 'connection_refused'],
    [e({ code: 'ENOTFOUND' }), 'dns'],
    [e({ code: 'CERT_HAS_EXPIRED' }), 'tls'],
    [e({ code: '28P01' }), 'auth'],
    [e({ code: '28000' }), 'auth'],
    [e({}, 'PAM authentication failed for user "app"'), 'auth'],
    [e({ name: 'AccessDeniedException' }), 'auth'],
    [e({}, 'password authentication failed for user x'), 'auth'],
    [e({ code: 'P2021' }), 'schema'],
    [e({ code: 'P2024' }), 'pool_exhausted'],
    [e({}, 'Timed out fetching a new connection from the connection pool'), 'pool_exhausted'],
    [e({ code: 'ETIMEDOUT' }), 'timeout'],
    [new Error('who knows'), 'error'],
  ])('%#', (err, reason) => {
    expect(classifyError(err)).toBe(reason);
  });
});

describe('pgFreshProbe', () => {
  const fake = (over: { connect?: () => Promise<unknown>; query?: () => Promise<unknown>; end?: () => Promise<unknown> } = {}) => ({
    connect: vi.fn(over.connect ?? (async () => undefined)),
    query: vi.fn(over.query ?? (async () => ({}))),
    end: vi.fn(over.end ?? (async () => undefined)),
  });

  it('connects, runs SELECT 1, ends', async () => {
    const c = fake();
    const factory = vi.fn(() => c);
    await pgFreshProbe(factory)(new AbortController().signal);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(c.connect).toHaveBeenCalledTimes(1);
    expect(c.query).toHaveBeenCalledWith('SELECT 1');
    expect(c.end).toHaveBeenCalledTimes(1);
  });

  it('builds a new client per call', async () => {
    const factory = vi.fn(() => fake());
    const probe = pgFreshProbe(factory);
    await probe(new AbortController().signal);
    await probe(new AbortController().signal);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('ends the client when query fails, and rethrows the query error', async () => {
    const err = Object.assign(new Error('boom'), { code: '28000' });
    const c = fake({ query: async () => Promise.reject(err) });
    await expect(pgFreshProbe(() => c)(new AbortController().signal)).rejects.toBe(err);
    expect(c.end).toHaveBeenCalledTimes(1);
  });

  it('ends the client when connect fails (PAM auth) and the error classifies as auth', async () => {
    const err = Object.assign(new Error('PAM authentication failed for user "app"'), { code: '28000' });
    const c = fake({ connect: async () => Promise.reject(err) });
    const got = await pgFreshProbe(() => c)(new AbortController().signal).catch((x: unknown) => x);
    expect(got).toBe(err);
    expect(c.query).not.toHaveBeenCalled();
    expect(c.end).toHaveBeenCalledTimes(1);
    expect(classifyError(got)).toBe('auth');
  });

  it('a failing end() does not mask success or the query error', async () => {
    const ok = fake({ end: async () => Promise.reject(new Error('end failed')) });
    await expect(pgFreshProbe(() => ok)(new AbortController().signal)).resolves.toBeUndefined();
    const qErr = new Error('query failed');
    const bad = fake({ query: async () => Promise.reject(qErr), end: async () => Promise.reject(new Error('end failed')) });
    await expect(pgFreshProbe(() => bad)(new AbortController().signal)).rejects.toBe(qErr);
  });

  it('abort ends the client while connect is pending', async () => {
    const c = fake({ connect: () => new Promise(() => undefined) });
    const ac = new AbortController();
    void pgFreshProbe(() => c)(ac.signal).catch(() => undefined);
    ac.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.end).toHaveBeenCalledTimes(1);
  });
});
