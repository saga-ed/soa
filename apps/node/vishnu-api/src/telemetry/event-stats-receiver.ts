import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { EventEnvelopeSchema } from '@saga-ed/soa-event-envelope';
import { REPORT_EVENT_TYPE, REPORT_EVENT_VERSION, ReportSchema } from '@saga-ed/soa-event-stats';
import { EventStatsStore, REPORTERS } from './event-stats-store';

/** Local synthetic receiver: upstream exchanges are checked, never declared. */
export class EventStatsReceiver {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private connection?: ChannelModel;
  private channel?: Channel;
  private pending = new Set<Promise<void>>();
  private starting?: Promise<void>;
  private failures = 0;
  readonly diagnostics = {
    accepted: 0,
    ignored: 0,
    rejected: 0,
    storageFailures: 0,
    reconnects: 0,
  };
  constructor(
    private readonly options: {
      url: string;
      queue: string;
      store: EventStatsStore;
      /** Exchanges to check and bind; defaults to the untagged REPORTERS (d1: never declared). */
      exchanges?: readonly string[];
      /** Extra arguments for both Vishnu queues; only a sandbox observer sets x-expires (d9). */
      queueArguments?: Record<string, unknown>;
      onError: (kind: string) => void;
    }
  ) {}
  private reportError(kind: string) {
    try {
      this.options.onError(kind);
    } catch {
      /* diagnostics cannot break delivery */
    }
  }
  start(): void {
    if (!this.running) {
      this.running = true;
      this.schedule(0);
    }
  }
  status() {
    return { connected: Boolean(this.channel), ...this.diagnostics };
  }
  private schedule(delay: number) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.starting = this.open().finally(() => {
        this.starting = undefined;
      });
    }, delay);
    this.timer.unref?.();
  }
  private async open() {
    let connection: ChannelModel | undefined;
    try {
      connection = await connect(this.options.url, { timeout: 2000 });
      connection.on('error', () => {});
      if (!this.running) {
        await connection.close();
        return;
      }
      this.connection = connection;
      connection.on('close', () => {
        if (this.connection !== connection) return;
        this.channel = undefined;
        this.connection = undefined;
        this.schedule(1000);
      });
      const channel = await connection.createChannel();
      channel.on('error', () => {});
      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined;
          void connection?.close().catch(() => {});
        }
      });
      const exchanges = this.options.exchanges ?? Object.values(REPORTERS);
      for (const exchange of exchanges) await channel.checkExchange(exchange);
      const dlq = `${this.options.queue}.invalid`;
      await channel.assertQueue(dlq, {
        durable: true,
        arguments: {
          'x-max-length': 100,
          'x-message-ttl': 3600000,
          ...this.options.queueArguments,
        },
      });
      await channel.assertQueue(this.options.queue, {
        durable: true,
        arguments: {
          'x-max-length': 10000,
          'x-message-ttl': 3600000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': dlq,
          ...this.options.queueArguments,
        },
      });
      for (const exchange of exchanges)
        await channel.bindQueue(this.options.queue, exchange, REPORT_EVENT_TYPE);
      await channel.prefetch(10);
      if (!this.running) {
        await connection.close();
        return;
      }
      this.channel = channel;
      await channel.consume(this.options.queue, message => {
        if (!message) {
          void connection?.close().catch(() => {});
          return;
        }
        const operation = this.accept(channel, message);
        this.pending.add(operation);
        void operation.finally(() => this.pending.delete(operation));
      });
      this.failures = 0;
      this.diagnostics.reconnects++;
    } catch {
      this.reportError('connection');
      this.failures = Math.min(5, this.failures + 1);
      if (this.connection === connection) {
        this.channel = undefined;
        this.connection = undefined;
      }
      void connection?.close().catch(() => {});
      this.schedule(Math.min(30000, 1000 * 2 ** this.failures));
    }
  }
  private async accept(channel: Channel, message: ConsumeMessage): Promise<void> {
    const settle = (ack: boolean) => {
      try {
        if (ack) channel.ack(message);
        else channel.nack(message, false, false);
      } catch {
        /* reconnect redelivers unsettled reports */
      }
    };
    let payload: unknown;
    try {
      if (message.content.length > 1_048_576) throw new Error('size');
      const envelope = EventEnvelopeSchema.parse(JSON.parse(message.content.toString()));
      if (
        envelope.eventType !== REPORT_EVENT_TYPE ||
        envelope.eventVersion !== REPORT_EVENT_VERSION
      )
        throw new Error('version');
      payload = ReportSchema.parse(envelope.payload);
    } catch {
      this.diagnostics.rejected++;
      settle(false);
      return;
    }
    try {
      const result = await this.options.store.apply(payload, message.fields.exchange);
      if (result === 'accepted') this.diagnostics.accepted++;
      else if (result === 'ignored') this.diagnostics.ignored++;
      else this.diagnostics.rejected++;
      settle(result === 'accepted' || result === 'ignored');
    } catch {
      this.diagnostics.storageFailures++;
      this.reportError('storage');
      // Keep the report unacked; closing this connection redelivers after a bounded reconnect delay.
      if (this.connection) {
        const connection = this.connection;
        this.connection = undefined;
        this.channel = undefined;
        void connection.close().catch(() => {});
      }
      this.schedule(2000);
    }
  }
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.pending, this.starting, connection?.close()]),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, 2500);
      }),
    ]);
    clearTimeout(timer);
  }
}
