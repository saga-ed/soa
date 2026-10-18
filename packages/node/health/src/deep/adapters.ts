import type { Decl } from './manifest.js';
import type { ProbeOutcome } from './types.js';

type Probe = (client: never, signal: AbortSignal) => Promise<ProbeOutcome | void>;

// Structural client shapes: no runtime or type dependency on pg/prisma/redis/mongodb/amqplib.
interface PrismaLike {
  $queryRawUnsafe(sql: string): Promise<unknown>;
}
interface PgLike {
  query(sql: string): Promise<unknown>;
}
interface MongoClientLike {
  db(name?: string): { command(cmd: Record<string, unknown>): Promise<unknown> };
}
interface MongoDbLike {
  command(cmd: Record<string, unknown>): Promise<unknown>;
}
interface RedisLike {
  ping(): Promise<unknown>;
}
interface AmqpChannelLike {
  checkExchange(name: string): Promise<unknown>;
  on?(event: string, cb: () => void): unknown;
}
interface AmqpConnectionLike {
  createChannel(): Promise<AmqpChannelLike>;
}
export interface ProbeFetchLike {
  /** RAW fetch sharing the app's agent/CA/DNS but bypassing its circuit breaker and retries. */
  probeFetch(url: string, init: { method: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number }>;
}

const has = (o: unknown, k: string): boolean => typeof (o as Record<string, unknown>)?.[k] === 'function';

export async function sqlProbe(client: unknown): Promise<void> {
  if (has(client, '$queryRawUnsafe')) {
    await (client as PrismaLike).$queryRawUnsafe('SELECT 1');
  } else if (has(client, 'query')) {
    await (client as PgLike).query('SELECT 1');
  } else {
    throw new TypeError('postgres client is neither Prisma-like nor pg-like');
  }
}

export async function mongoProbe(client: unknown): Promise<void> {
  if (has(client, 'db')) await (client as MongoClientLike).db('admin').command({ ping: 1 });
  else if (has(client, 'command')) await (client as MongoDbLike).command({ ping: 1 });
  else throw new TypeError('mongo client has neither db() nor command()');
}

export async function redisProbe(client: unknown): Promise<ProbeOutcome> {
  const reply = await (client as RedisLike).ping();
  return String(reply).toUpperCase() === 'PONG' ? { ok: true } : { ok: false, reason: 'unexpected_response' };
}

// One dedicated probe channel per connection. A channel error closes the channel, so the app's
// publish/consume channels are never used. A dead cached channel is dropped and recreated.
const probeChannels = new WeakMap<object, Promise<AmqpChannelLike>>();

export async function rabbitProbe(conn: unknown, exchange?: string): Promise<void> {
  const c = conn as AmqpConnectionLike;
  let pending = probeChannels.get(c);
  if (!pending) {
    pending = c.createChannel().then((ch) => {
      const drop = (): void => void probeChannels.delete(c);
      ch.on?.('error', drop);
      ch.on?.('close', drop);
      return ch;
    });
    probeChannels.set(c, pending);
    pending.catch(() => probeChannels.delete(c));
  }
  const ch = await pending;
  if (exchange) await ch.checkExchange(exchange);
}

export async function httpProbe(client: unknown, url: string | undefined, signal: AbortSignal): Promise<ProbeOutcome> {
  if (!url) throw new TypeError('http dependency needs `target` (URL)');
  const res = await (client as ProbeFetchLike).probeFetch(url, { method: 'GET', signal });
  return res.ok ? { ok: true } : { ok: false, reason: 'unexpected_response' };
}

export function defaultProbe(d: Decl): Probe | undefined {
  switch (d.kind) {
    case 'postgres':
    case 'prisma':
      return (async (c: unknown) => sqlProbe(c)) as Probe;
    case 'mongo':
      return (async (c: unknown) => mongoProbe(c)) as Probe;
    case 'redis':
      return (async (c: unknown) => redisProbe(c)) as Probe;
    case 'rabbitmq':
      return (async (c: unknown) => rabbitProbe(c, d.target)) as Probe;
    case 'http':
      return (async (c: unknown, signal: AbortSignal) => httpProbe(c, d.target, signal)) as Probe;
    default:
      return undefined;
  }
}
