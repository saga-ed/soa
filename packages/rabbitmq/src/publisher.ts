import { injectable, inject } from 'inversify';
import type { ConnectionManager } from './connection-manager.js';
import { Channel } from 'amqplib';

@injectable()
export class MessagePublisher {
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

  async publishToQueue<T>(channelName: string, queueName: string, message: T): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel ${channelName} not found, request it first using MessagePublisher.requestChannel()`);
    }

    await channel.assertQueue(queueName, { durable: false });
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)));
  }
}

