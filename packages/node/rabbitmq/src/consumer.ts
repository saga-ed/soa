import { injectable, inject } from 'inversify';
import { ConnectionManagerClosedError, type ConnectionManager } from './connection-manager.js';
import { Channel, ConsumeMessage, Options, Replies } from 'amqplib';

/** 'auto' handlers resolve true to ack, false to requeue-nack. */
type AutoHandler = (msg: ConsumeMessage) => Promise<boolean>;
/** 'manual' handlers receive the channel the message arrived on and own ack/nack. */
type ManualHandler = (msg: ConsumeMessage, channel: Channel) => Promise<void>;
type Handler = AutoHandler | ManualHandler;

export type QueueOption = { args?: Options.AssertQueue } | { passive: true };

export interface ConsumeOptions {
  /**
   * How the queue is declared on every (re)subscribe. Default: `assertQueue(name)`.
   * `{ args }` asserts with those options (must match the existing queue, e.g. quorum
   * `x-delivery-limit` / `x-dead-letter-exchange`); `{ passive: true }` only checks it exists.
   */
  queue?: QueueOption;
  /**
   * 'auto' (default): MessageConsumer acks when the handler resolves true, nacks with requeue
   * on false. 'manual': the handler owns ack/nack; MessageConsumer never acks or nacks, even
   * when the handler throws (the message stays unacked and is redelivered when the channel closes).
   */
  ackMode?: 'auto' | 'manual';
  /** `channel.prefetch(n)` on each (re)subscribe channel. Channel-wide: the last subscription wins. */
  prefetch?: number;
  /** Called when a handler throws. Default: console.error. */
  onError?: (err: unknown, msg: ConsumeMessage) => void;
}

/** Resubscribe status for one named channel. */
export interface ConsumerState {
  channelName: string;
  status: 'subscribed' | 'resubscribing';
  /** Consecutive failed resubscribe attempts since the channel was lost. */
  attempts: number;
  lastError?: string;
}

interface Subscription {
  queueName: string;
  consumer: Handler;
  options: ConsumeOptions;
}

const RESUBSCRIBE_INITIAL_DELAY_MS = 1_000;
const RESUBSCRIBE_MAX_DELAY_MS = 30_000;

@injectable()
export class MessageConsumer {
  private channels: Map<string, Channel> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map();
  private resubscribeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private resubscribeState: Map<string, { attempts: number; lastError?: string }> = new Map();
  private stopped = false;

  constructor(
    @inject('ConnectionManager') private connectionManager: ConnectionManager
  ) {}

  async requestChannel(channelName: string): Promise<boolean> {
    if (this.channels.has(channelName)) {
      return true;
    }

    const channel = await this.connectionManager.newChannel();
    this.adopt(channelName, channel);
    return true;
  }

  async consumeFromQueue(channelName: string, queueName: string, consumer: AutoHandler): Promise<Replies.Consume>;
  async consumeFromQueue(
    channelName: string,
    queueName: string,
    consumer: ManualHandler,
    options: ConsumeOptions & { ackMode: 'manual' },
  ): Promise<Replies.Consume>;
  async consumeFromQueue(
    channelName: string,
    queueName: string,
    consumer: AutoHandler,
    options: ConsumeOptions & { ackMode?: 'auto' },
  ): Promise<Replies.Consume>;
  async consumeFromQueue(
    channelName: string,
    queueName: string,
    consumer: Handler,
    options: ConsumeOptions = {},
  ): Promise<Replies.Consume> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel ${channelName} not found, request it first using MessagePublisher.requestChannel()`);
    }

    const res = await this.subscribe(channel, queueName, consumer, options);
    const subs = this.subscriptions.get(channelName) ?? [];
    if (!subs.some((s) => s.queueName === queueName && s.consumer === consumer)) {
      subs.push({ queueName, consumer, options });
    }
    this.subscriptions.set(channelName, subs);
    return res;
  }

  /** Stops resubscribing; does not close channels. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.resubscribeTimers.values()) clearTimeout(timer);
    this.resubscribeTimers.clear();
  }

  /** Resubscribe status per channel that has subscriptions. */
  state(): ConsumerState[] {
    return [...this.subscriptions.keys()].map((channelName) => {
      const st = this.resubscribeState.get(channelName);
      const live = this.channels.has(channelName);
      return {
        channelName,
        status: live ? 'subscribed' : 'resubscribing',
        attempts: st?.attempts ?? 0,
        ...(st?.lastError ? { lastError: st.lastError } : {}),
      };
    });
  }

  /** True when every channel with subscriptions is live. Suitable for soa-health `isConsuming`. */
  isConsuming(): boolean {
    return !this.stopped && this.state().every((s) => s.status === 'subscribed');
  }

  private async subscribe(
    channel: Channel,
    queueName: string,
    consumer: Handler,
    options: ConsumeOptions,
  ): Promise<Replies.Consume> {
    const q = options.queue;
    if (q && 'passive' in q) {
      await channel.checkQueue(queueName);
    } else if (q?.args) {
      await channel.assertQueue(queueName, q.args);
    } else {
      await channel.assertQueue(queueName);
    }
    if (options.prefetch !== undefined) await channel.prefetch(options.prefetch);
    const manual = options.ackMode === 'manual';
    const onError =
      options.onError ??
      ((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[MessageConsumer] handler for ${queueName} threw`, err);
      });
    return channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      if (manual) {
        // The handler owns ack/nack. A throw leaves the message unacked (redelivered on channel close).
        (consumer as ManualHandler)(msg, channel).catch((err: unknown) => onError(err, msg));
        return;
      }
      (consumer as AutoHandler)(msg)
        .then((success: boolean) => {
          if (success) {
            channel.ack(msg);
          } else {
            channel.nack(msg, false, true);
          }
        })
        .catch(() => {
          // Channel died mid-handler: the broker redelivers the unacked message.
        });
    });
  }

  // A channel dies with its connection. Evict it, then re-create it and
  // re-subscribe every registered consumer once the connection is back.
  private adopt(channelName: string, channel: Channel): void {
    this.channels.set(channelName, channel);
    channel.on?.('error', () => {
      // 'close' follows and drives recovery; this only keeps 'error' from crashing the process.
    });
    channel.on?.('close', () => {
      if (this.channels.get(channelName) !== channel) return;
      this.channels.delete(channelName);
      if (!this.stopped && this.subscriptions.has(channelName)) this.scheduleResubscribe(channelName, 0);
    });
  }

  private scheduleResubscribe(channelName: string, attempt: number): void {
    if (this.stopped || this.resubscribeTimers.has(channelName)) return;
    const delay = Math.min(RESUBSCRIBE_MAX_DELAY_MS, RESUBSCRIBE_INITIAL_DELAY_MS * 2 ** attempt);
    const timer = setTimeout(() => {
      this.resubscribeTimers.delete(channelName);
      this.resubscribe(channelName).catch((err: unknown) => {
        if (err instanceof ConnectionManagerClosedError) return; // shutting down
        // Includes non-retryable declare errors (406 inequivalent args): back off and surface via state().
        this.resubscribeState.set(channelName, {
          attempts: attempt + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
        this.scheduleResubscribe(channelName, attempt + 1);
      });
    }, delay);
    this.resubscribeTimers.set(channelName, timer);
  }

  private async resubscribe(channelName: string): Promise<void> {
    if (this.stopped) return;
    await this.connectionManager.ensureConnected();
    const channel = await this.connectionManager.newChannel();
    let closedDuringSetup = false;
    channel.on?.('close', () => {
      closedDuringSetup = true;
    });
    try {
      for (const sub of this.subscriptions.get(channelName) ?? []) {
        await this.subscribe(channel, sub.queueName, sub.consumer, sub.options);
      }
      if (closedDuringSetup) throw new Error('channel closed during resubscribe');
    } catch (err) {
      void Promise.resolve().then(() => channel.close()).catch(() => {});
      throw err;
    }
    this.resubscribeState.delete(channelName);
    this.adopt(channelName, channel);
  }
}
