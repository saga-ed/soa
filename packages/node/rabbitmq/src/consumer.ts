import { injectable, inject } from 'inversify';
import { ConnectionManagerClosedError, type ConnectionManager } from './connection-manager.js';
import { Channel, ConsumeMessage, Replies } from 'amqplib';

type Handler = (msg: ConsumeMessage) => Promise<boolean>;

interface Subscription {
  queueName: string;
  consumer: Handler;
}

const RESUBSCRIBE_INITIAL_DELAY_MS = 1_000;
const RESUBSCRIBE_MAX_DELAY_MS = 30_000;

@injectable()
export class MessageConsumer {
  private channels: Map<string, Channel> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map();
  private resubscribeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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

  async consumeFromQueue(channelName: string, queueName: string, consumer: Handler): Promise<Replies.Consume> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel ${channelName} not found, request it first using MessagePublisher.requestChannel()`);
    }

    const res = await this.subscribe(channel, queueName, consumer);
    const subs = this.subscriptions.get(channelName) ?? [];
    if (!subs.some((s) => s.queueName === queueName && s.consumer === consumer)) {
      subs.push({ queueName, consumer });
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

  private async subscribe(channel: Channel, queueName: string, consumer: Handler): Promise<Replies.Consume> {
    await channel.assertQueue(queueName);
    return channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      consumer(msg)
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
        await this.subscribe(channel, sub.queueName, sub.consumer);
      }
      if (closedDuringSetup) throw new Error('channel closed during resubscribe');
    } catch (err) {
      void Promise.resolve().then(() => channel.close()).catch(() => {});
      throw err;
    }
    this.adopt(channelName, channel);
  }
}
