import type { EventEnvelope, PubSubAdapter } from '../../adapters/base-adapter.js';

export class MockAdapter implements PubSubAdapter {
  private events: EventEnvelope[] = [];
  private subscribers = new Map<string, Set<(event: EventEnvelope) => Promise<void>>>();

  async publish(event: EventEnvelope): Promise<void> {
    this.events.push(event);
    
    // Notify subscribers
    const channelSubscribers = this.subscribers.get(event.channel);
    if (channelSubscribers) {
      for (const handler of channelSubscribers) {
        try {
          await handler(event);
        } catch (error) {
          console.error('Error in mock adapter subscriber:', error);
        }
      }
    }
  }

  async subscribe(channel: string, handler: (event: EventEnvelope) => Promise<void>): Promise<{ unsubscribe: () => Promise<void> }> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    
    const channelSubscribers = this.subscribers.get(channel)!;
    channelSubscribers.add(handler);

    return {
      unsubscribe: async () => {
        channelSubscribers.delete(handler);
        if (channelSubscribers.size === 0) {
          this.subscribers.delete(channel);
        }
      }
    };
  }

  async persist(event: EventEnvelope): Promise<void> {
    // Mock persistence - just store in memory
    this.events.push(event);
  }

  async fetchHistory(channel: string, opts: { since?: string; limit?: number } = {}): Promise<EventEnvelope[]> {
    let filtered = this.events.filter(e => e.channel === channel);
    
    if (opts.since) {
      const sinceDate = new Date(opts.since);
      filtered = filtered.filter(e => new Date(e.timestamp) >= sinceDate);
    }
    
    if (opts.limit) {
      filtered = filtered.slice(-opts.limit);
    }
    
    return filtered;
  }

  async health(): Promise<{ healthy: boolean; details?: any }> {
    return {
      healthy: true,
      details: {
        eventCount: this.events.length,
        subscriberCount: Array.from(this.subscribers.values()).reduce((sum, set) => sum + set.size, 0)
      }
    };
  }

  async shutdown(): Promise<void> {
    this.subscribers.clear();
    this.events = [];
  }

  // Test helper methods
  getEventCount(): number {
    return this.events.length;
  }

  getSubscriberCount(channel?: string): number {
    if (channel) {
      return this.subscribers.get(channel)?.size || 0;
    }
    return Array.from(this.subscribers.values()).reduce((sum, set) => sum + set.size, 0);
  }

  clearEvents(): void {
    this.events = [];
  }
} 