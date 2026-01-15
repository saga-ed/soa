import { injectable, inject } from 'inversify';
import type { ConnectionManager } from './connection-manager.js';
import { Channel, ConsumeMessage, Replies } from 'amqplib';

@injectable()
export class MessageConsumer {
  private channels: Map<string, Channel> = new Map();
  constructor(
    @inject('ConnectionManager') private connectionManager: ConnectionManager
  ) {}

  async requestChannel(channelName: string): Promise<boolean> {
    if (this.channels.has(channelName)) {
      return true;
    }

    const channel = await this.connectionManager.newChannel();
    this.channels.set(channelName, channel);
    return true;
  }

  async consumeFromQueue(channelName: string, queueName: string, consumer: (msg: ConsumeMessage) => Promise<boolean>): Promise<Replies.Consume> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel ${channelName} not found, request it first using MessagePublisher.requestChannel()`);
    }

    await channel.assertQueue(queueName);
    return channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
  
      consumer(msg).then((success: boolean) => {
        if (success) {
          channel.ack(msg);
        } else {
          channel.nack(msg, false, true);
        }
      });
    });
  }
}

