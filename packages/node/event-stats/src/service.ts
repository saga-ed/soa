import { hostname } from 'node:os';
import { connect, type ChannelModel } from 'amqplib';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import type { EventConsumerOpts } from '@saga-ed/soa-event-consumer';
import type { OutboxRelayOpts } from '@saga-ed/soa-event-outbox';
import { EventStats } from './accumulator.js';
import { EventStatsReporter, type ReportTransport } from './reporter.js';
import { RabbitMqReportTransport } from './rabbitmq-transport.js';

/** Owns a short-lived reporting connection per flush; never borrows business resources. */
export class IsolatedRabbitMqReportTransport implements ReportTransport {
  constructor(
    private readonly url: string,
    private readonly exchange: string,
    private readonly timeoutMs = 2000
  ) {}
  async send(envelope: EventEnvelope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let connection: ChannelModel | undefined;
    const close = () => {
      void connection?.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      connection = await connect(this.url, { timeout: this.timeoutMs, signal });
      connection.on('error', () => {});
      signal.throwIfAborted();
      await new RabbitMqReportTransport({
        exchange: this.exchange,
        createChannel: () => connection!.createChannel(),
      }).send(envelope, signal);
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  }
}

export interface ServiceStatsOptions {
  service: string;
  capabilities: ReadonlyArray<'producer' | 'consumer'>;
  publisherExchange: string;
  env?: NodeJS.ProcessEnv;
  /** Independent local logger/metric. Never receives payloads, credentials or raw errors. */
  onError: (kind: string) => void;
}

/** Opt-in lifecycle wiring shared by adopters. Invalid enabled configuration fails before startup. */
export function createServiceEventStats(options: ServiceStatsOptions) {
  const env = options.env ?? process.env;
  const enabled = env.EVENT_STATS_ENABLED === 'true';
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required when EVENT_STATS_ENABLED=true`);
    return value;
  };
  const stats = enabled
    ? new EventStats({
        identity: {
          service: options.service,
          environment: required('EVENT_STATS_ENVIRONMENT'),
          deployment: required('EVENT_STATS_DEPLOYMENT'),
          revision: required('EVENT_STATS_REVISION'),
          instance: env.EVENT_STATS_INSTANCE ?? `${hostname()}:${process.pid}`,
          broker: required('EVENT_STATS_BROKER'),
          vhost: required('EVENT_STATS_VHOST'),
        },
        capabilities: options.capabilities,
      })
    : undefined;
  const reporter = stats
    ? new EventStatsReporter({
        stats,
        transport: new IsolatedRabbitMqReportTransport(
          required('RABBITMQ_URL'),
          options.publisherExchange
        ),
        intervalMs: Number(env.EVENT_STATS_INTERVAL_MS ?? 30_000),
        timeoutMs: 2000,
        onError: options.onError,
      })
    : undefined;
  function consumer<T extends EventConsumerOpts>(config: T): T {
    if (!stats) return config;
    // Register exact handler identities, not wildcard strings, for explicit idle zeros.
    for (const binding of config.bindings)
      for (const handler of config.handlers) {
        const pattern = binding.routingKey.split('.');
        const words = handler.eventType.split('.');
        const matches =
          pattern.every((word, i) => word === '#' || word === '*' || word === words[i]) &&
          (pattern.includes('#') || pattern.length === words.length);
        if (matches)
          stats.register({
            role: 'consumer',
            exchange: binding.exchange,
            queue: config.queue,
            consumer: config.consumerName,
            eventType: handler.eventType,
            eventVersion: handler.eventVersion,
          });
      }
    return {
      ...config,
      observe: observation => {
        stats.observeConsumer(observation);
        return config.observe?.(observation);
      },
    };
  }
  function outbox<T extends OutboxRelayOpts>(config: T): T {
    if (!stats) return config;
    return {
      ...config,
      observe: observation => {
        stats.observeOutbox(observation);
        return config.observe?.(observation);
      },
    };
  }
  return {
    enabled,
    stats,
    consumer,
    outbox,
    start: () => reporter?.start(),
    stop: async () => {
      await reporter?.stop({ flush: true });
    },
  };
}
