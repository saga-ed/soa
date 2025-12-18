import { inject, injectable } from 'inversify';
import { TYPES } from '../types/index.js';
import type { ChannelConfig, EventEnvelope } from '@saga-ed/soa-pubsub-core';
import type { Logger } from '../types/index.js';

@injectable()
export class ChannelService {
  private channels = new Map<string, ChannelConfig>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {}

  registerChannels(configs: ChannelConfig[]): void {
    for (const config of configs) {
      this.channels.set(config.name, config);
      this.logger.info('Channel registered', { 
        channelName: config.name, 
        family: config.family 
      });
    }
  }

  getChannelConfig(channelName: string): ChannelConfig | undefined {
    return this.channels.get(channelName);
  }

  getAllChannels(): ChannelConfig[] {
    return Array.from(this.channels.values());
  }

  validateChannelAccess(
    channelName: string,
    user: any,
    operation: 'read' | 'write'
  ): { allowed: boolean; error?: string } {
    const config = this.channels.get(channelName);
    if (!config) {
      return { allowed: false, error: `Unknown channel: ${channelName}` };
    }

    // Check if user has access to this channel
    if (config.authScope) {
      if (typeof config.authScope === 'string') {
        if (!user || !user.roles.includes(config.authScope)) {
          return { 
            allowed: false, 
            error: `User does not have required scope: ${config.authScope}` 
          };
        }
      }
    }

    return { allowed: true };
  }

  async checkChannelLimits(
    channelName: string,
    operation: 'subscribe' | 'publish'
  ): Promise<{ allowed: boolean; error?: string }> {
    const config = this.channels.get(channelName);
    if (!config) {
      return { allowed: false, error: `Unknown channel: ${channelName}` };
    }

    // Check subscriber limits
    if (operation === 'subscribe' && config.maxSubscribers) {
      // This would need to be implemented with actual subscriber tracking
      // For now, we'll assume it's allowed
    }

    // Check event size limits
    if (operation === 'publish' && config.maxEventSize) {
      // This would be checked when the actual event is published
      // For now, we'll assume it's allowed
    }

    return { allowed: true };
  }

  getChannelFamily(channelName: string): string | undefined {
    const config = this.channels.get(channelName);
    return config?.family;
  }

  isChannelOrdered(channelName: string): boolean {
    const config = this.channels.get(channelName);
    return config?.ordered ?? false;
  }

  getChannelRetention(channelName: string): number | undefined {
    const config = this.channels.get(channelName);
    return config?.historyRetentionMs;
  }

  async validateEventForChannel(
    event: EventEnvelope,
    channelName: string
  ): Promise<{ valid: boolean; error?: string }> {
    const config = this.channels.get(channelName);
    if (!config) {
      return { valid: false, error: `Unknown channel: ${channelName}` };
    }

    // Check event size limit
    if (config.maxEventSize) {
      const eventSize = JSON.stringify(event).length;
      if (eventSize > config.maxEventSize) {
        return { 
          valid: false, 
          error: `Event size ${eventSize} exceeds limit ${config.maxEventSize}` 
        };
      }
    }

    return { valid: true };
  }
} 