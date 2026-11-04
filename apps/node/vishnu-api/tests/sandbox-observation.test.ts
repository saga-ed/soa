import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EventStats } from '@saga-ed/soa-event-stats';

// d9: the receiver's broker calls are recorded by a fake channel. It has no
// assertExchange, so any attempt to declare a publisher exchange fails (d1).
const calls: {
  checkExchange: string[];
  bindQueue: [string, string, string][];
  assertQueue: [string, unknown][];
} = {
  checkExchange: [],
  bindQueue: [],
  assertQueue: [],
};
vi.mock('amqplib', () => {
  const channel = {
    on: () => {},
    checkExchange: async (name: string) => void calls.checkExchange.push(name),
    assertQueue: async (name: string, options: unknown) =>
      void calls.assertQueue.push([name, options]),
    bindQueue: async (queue: string, exchange: string, key: string) =>
      void calls.bindQueue.push([queue, exchange, key]),
    prefetch: async () => {},
    consume: async () => ({ consumerTag: 'test' }),
  };
  const connection = { on: () => {}, createChannel: async () => channel, close: async () => {} };
  return { connect: vi.fn(async () => connection) };
});

const { loadConfig } = await import('../src/config.js');
const { EventStatsStore, REPORTERS, mqPreviewTag, reporterExchanges } =
  await import('../src/telemetry/event-stats-store.js');
const { EventStatsReceiver } = await import('../src/telemetry/event-stats-receiver.js');
const { createEventStatsRuntime, SANDBOX_QUEUE_EXPIRES_MS } =
  await import('../src/telemetry/event-stats-runtime.js');

const hosted = {
  VISHNU_ENVIRONMENT: 'dev',
  VISHNU_DATADOG_ENV: 'dev',
  VISHNU_DATADOG_SCOPE: 'environment',
  VISHNU_MQ_ENABLED: 'true',
  EVENT_STATS_ENVIRONMENT: 'dev',
  EVENT_STATS_DEPLOYMENT: 'main',
};
const sandbox = {
  ...hosted,
  EVENT_STATS_DEPLOYMENT: 'sandbox-gh537',
  VISHNU_MQ_PREVIEW_TAG: 'sandbox-gh537',
};
const scope = (deployment: string) => ({
  environment: 'dev',
  deployment,
  broker: 'shared-dev-mq',
  vhost: '/',
});
const report = (deployment: string, service = 'iam-api') =>
  new EventStats({
    identity: { ...scope(deployment), service, revision: 'r1', instance: 'one' },
    capabilities: ['producer'],
  }).snapshot();
/** A pool that proves a report passed every scope gate by reaching storage. */
const reachedStorage = new Error('reached storage');
const pool = { connect: async () => Promise.reject(reachedStorage) } as unknown as Pool;

afterEach(() => {
  calls.checkExchange.length = 0;
  calls.bindQueue.length = 0;
  calls.assertQueue.length = 0;
});

describe('sandbox observation config (d9)', () => {
  it('is absent by default and leaves the existing hosted config exactly as before', () => {
    expect(loadConfig(hosted)).toMatchObject({
      mqEnabled: true,
      mqDeployment: 'main',
      mqPreviewTag: null,
    });
    expect(loadConfig({ ...hosted, VISHNU_MQ_PREVIEW_TAG: '' })).toMatchObject({
      mqPreviewTag: null,
    });
    expect(loadConfig({ ...hosted, VISHNU_MQ_ENABLED: 'false' })).toMatchObject({
      mqDeployment: null,
      mqPreviewTag: null,
    });
  });
  it('observes one named sandbox with the tag as its exact MQ deployment', () => {
    expect(loadConfig(sandbox)).toMatchObject({
      mqEnabled: true,
      mqDeployment: 'sandbox-gh537',
      mqPreviewTag: 'sandbox-gh537',
      datadogScope: 'environment',
    });
  });
  it('fails closed on a malformed tag, a mismatched deployment, MQ off, or prod', () => {
    for (const env of [
      { ...sandbox, VISHNU_MQ_PREVIEW_TAG: 'gh537' },
      { ...sandbox, VISHNU_MQ_PREVIEW_TAG: 'sandbox-' },
      { ...sandbox, VISHNU_MQ_PREVIEW_TAG: 'sandbox-a.b' },
      { ...sandbox, VISHNU_MQ_PREVIEW_TAG: 'sandbox-other' },
      { ...sandbox, EVENT_STATS_DEPLOYMENT: 'main' },
      { ...sandbox, VISHNU_MQ_ENABLED: 'false' },
      {
        ...sandbox,
        VISHNU_ENVIRONMENT: 'prod',
        VISHNU_DATADOG_ENV: 'prod',
        EVENT_STATS_ENVIRONMENT: 'prod',
      },
    ])
      expect(() => loadConfig(env)).toThrow();
  });
});

describe('reporter exchanges (d9)', () => {
  it('is REPORTERS itself without a tag, and never reads EVENT_PREVIEW_TAG from the process', () => {
    vi.stubEnv('EVENT_PREVIEW_TAG', 'sandbox-leak');
    try {
      expect(reporterExchanges()).toBe(REPORTERS);
      expect(reporterExchanges('')).toBe(REPORTERS);
      expect(mqPreviewTag(undefined, 'main')).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('tags every reporter exchange the way sandboxed publishers do', () => {
    expect(reporterExchanges('sandbox-gh537')).toEqual({
      'iam-api': 'iam.events.sandbox-gh537',
      'programs-api': 'programs.events.sandbox-gh537',
      'scheduling-api': 'scheduling.events.sandbox-gh537',
      'sessions-api': 'sess.events.sandbox-gh537',
      'content-api': 'content.events.sandbox-gh537',
      'chat-api': 'chat.events.sandbox-gh537',
      'insights-api': 'insights.events.sandbox-gh537',
      'transcripts-api': 'transcripts.events.sandbox-gh537',
    });
  });
});

describe('sandbox store keeps exact scope and exchange binding (d3/d9)', () => {
  const sandboxStore = () =>
    new EventStatsStore(
      pool,
      scope('sandbox-gh537'),
      undefined,
      reporterExchanges('sandbox-gh537')
    );
  it('accepts a sandbox report only on its own tagged exchange', async () => {
    await expect(
      sandboxStore().apply(report('sandbox-gh537'), 'iam.events.sandbox-gh537')
    ).rejects.toBe(reachedStorage);
    await expect(
      sandboxStore().apply(
        report('sandbox-gh537', 'scheduling-api'),
        'scheduling.events.sandbox-gh537'
      )
    ).rejects.toBe(reachedStorage);
    expect(await sandboxStore().apply(report('sandbox-gh537'), 'iam.events')).toBe('scope');
    expect(
      await sandboxStore().apply(report('sandbox-gh537'), 'programs.events.sandbox-gh537')
    ).toBe('scope');
    expect(await sandboxStore().apply(report('sandbox-gh537'), 'iam.events.sandbox-other')).toBe(
      'scope'
    );
  });
  it('rejects reports from the dev mesh, another sandbox, or an unknown service', async () => {
    expect(await sandboxStore().apply(report('main'), 'iam.events.sandbox-gh537')).toBe('scope');
    expect(await sandboxStore().apply(report('sandbox-other'), 'iam.events.sandbox-gh537')).toBe(
      'scope'
    );
    expect(
      await sandboxStore().apply(report('sandbox-gh537', 'constructor'), 'iam.events.sandbox-gh537')
    ).toBe('scope');
    expect(
      await sandboxStore().apply(
        report('sandbox-gh537', 'sessions-api'),
        'iam.events.sandbox-gh537'
      )
    ).toBe('scope');
  });
  it('leaves the default store on the untagged exchanges', async () => {
    const store = new EventStatsStore(pool, scope('main'));
    await expect(store.apply(report('main'), 'iam.events')).rejects.toBe(reachedStorage);
    expect(await store.apply(report('main'), 'iam.events.sandbox-gh537')).toBe('scope');
  });
});

describe('receiver topology (d1/d9)', () => {
  const run = async (options: Partial<ConstructorParameters<typeof EventStatsReceiver>[0]>) => {
    const receiver = new EventStatsReceiver({
      url: 'amqp://test',
      queue: 'q',
      store: new EventStatsStore(pool, scope('main')),
      onError: () => {},
      ...options,
    });
    receiver.start();
    await vi.waitFor(() => expect(receiver.status().connected).toBe(true));
    await receiver.stop();
  };
  it('defaults to checking and binding the untagged exchanges with unchanged queue arguments', async () => {
    await run({});
    expect(calls.checkExchange).toEqual([
      'iam.events',
      'programs.events',
      'scheduling.events',
      'sess.events',
      'content.events',
      'chat.events',
      'insights.events',
      'transcripts.events',
    ]);
    expect(calls.bindQueue.map(([, exchange]) => exchange)).toEqual(calls.checkExchange);
    expect(calls.assertQueue).toEqual([
      [
        'q.invalid',
        { durable: true, arguments: { 'x-max-length': 100, 'x-message-ttl': 3600000 } },
      ],
      [
        'q',
        {
          durable: true,
          arguments: {
            'x-max-length': 10000,
            'x-message-ttl': 3600000,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'q.invalid',
          },
        },
      ],
    ]);
  });
  it('checks (never declares) and binds only the sandbox exchanges, on report events only', async () => {
    await run({
      exchanges: Object.values(reporterExchanges('sandbox-gh537')),
      queueArguments: { 'x-expires': SANDBOX_QUEUE_EXPIRES_MS },
    });
    const tagged = [
      'iam.events.sandbox-gh537',
      'programs.events.sandbox-gh537',
      'scheduling.events.sandbox-gh537',
      'sess.events.sandbox-gh537',
      'content.events.sandbox-gh537',
      'chat.events.sandbox-gh537',
      'insights.events.sandbox-gh537',
      'transcripts.events.sandbox-gh537',
    ];
    expect(calls.checkExchange).toEqual(tagged);
    expect(calls.bindQueue).toEqual(
      tagged.map(e => ['q', e, 'observability.event_stats.reported'])
    );
    for (const [, options] of calls.assertQueue)
      expect((options as { arguments: Record<string, unknown> }).arguments['x-expires']).toBe(
        86_400_000
      );
  });
});

describe('runtime wiring (d9)', () => {
  const runtimeEnv = {
    VISHNU_DATABASE_URL: 'postgres://vishnu@127.0.0.1:1/vishnu',
    RABBITMQ_URL: 'amqp://test',
    EVENT_STATS_ENVIRONMENT: 'dev',
    EVENT_STATS_BROKER: 'shared-dev-mq',
    EVENT_STATS_VHOST: '/',
  };
  it('refuses a sandbox tag that does not equal the MQ deployment', () => {
    expect(() =>
      createEventStatsRuntime({
        ...runtimeEnv,
        EVENT_STATS_DEPLOYMENT: 'main',
        VISHNU_MQ_PREVIEW_TAG: 'sandbox-gh537',
      })
    ).toThrow();
  });
  it('builds untagged and sandbox runtimes without connecting', async () => {
    for (const env of [
      { ...runtimeEnv, EVENT_STATS_DEPLOYMENT: 'main' },
      {
        ...runtimeEnv,
        EVENT_STATS_DEPLOYMENT: 'sandbox-gh537',
        VISHNU_MQ_PREVIEW_TAG: 'sandbox-gh537',
      },
    ])
      await createEventStatsRuntime(env).close();
  });
});
