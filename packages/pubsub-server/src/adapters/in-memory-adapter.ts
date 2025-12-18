import type { EventEnvelope } from '@saga-ed/soa-pubsub-core';
import type { PubSubAdapter } from './base-adapter.js';

export interface InMemoryAdapterOptions {
  maxHistoryPerChannel?: number;
  enablePersistence?: boolean;
}

export class InMemoryAdapter implements PubSubAdapter {
  private events = new Map<string, EventEnvelope[]>();
  private subscribers = new Map<string, Set<(event: EventEnvelope) => Promise<void>>>();
  private maxHistory: number;
  private enablePersistence: boolean;

  constructor(options: InMemoryAdapterOptions = {}) {
    this.maxHistory = options.maxHistoryPerChannel ?? 100;
    this.enablePersistence = options.enablePersistence ?? true;
  }

  async publish(event: EventEnvelope): Promise<void> {
    // Store event in history if persistence is enabled
    if (this.enablePersistence) {
      if (!this.events.has(event.channel)) {
        this.events.set(event.channel, []);
      }
      
      const channelEvents = this.events.get(event.channel)!;
      channelEvents.push(event);
      
      // Maintain max history limit
      if (channelEvents.length > this.maxHistory) {
        channelEvents.shift(); // Remove oldest event
      }
    }

    // Notify all subscribers for this channel
    const channelSubscribers = this.subscribers.get(event.channel);
    if (channelSubscribers) {
      const promises = Array.from(channelSubscribers).map(handler => 
        handler(event).catch(error => {
          console.error(`Error in subscriber for channel ${event.channel}:`, error);
        })
      );
      
      await Promise.allSettled(promises);
    }
  }

  async subscribe(
    channel: string, 
    handler: (event: EventEnvelope) => Promise<void>
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    
    const channelSubscribers = this.subscribers.get(channel)!;
    channelSubscribers.add(handler);

    const unsubscribe = async () => {
      channelSubscribers.delete(handler);
      
      // Clean up empty channel subscriber sets
      if (channelSubscribers.size === 0) {
        this.subscribers.delete(channel);
      }
    };

    return { unsubscribe };
  }

  async persist(event: EventEnvelope): Promise<void> {
    // For in-memory adapter, persist is the same as storing in history
    // This is called by publish() if persistence is enabled
    if (!this.events.has(event.channel)) {
      this.events.set(event.channel, []);
    }
    
    const channelEvents = this.events.get(event.channel)!;
    channelEvents.push(event);
    
    if (channelEvents.length > this.maxHistory) {
      channelEvents.shift();
    }
  }

  async fetchHistory(
    channel: string, 
    opts: { since?: string; limit?: number } = {}
  ): Promise<EventEnvelope[]> {
    const channelEvents = this.events.get(channel) || [];
    
    let filteredEvents = channelEvents;
    
    // Filter by timestamp if 'since' is provided
    if (opts.since) {
      const sinceDate = new Date(opts.since);
      filteredEvents = channelEvents.filter(event => 
        new Date(event.timestamp) > sinceDate
      );
    }
    
    // Apply limit if provided
    if (opts.limit && opts.limit > 0) {
      filteredEvents = filteredEvents.slice(-opts.limit); // Get most recent events
    }
    
    return [...filteredEvents]; // Return a copy to prevent external mutation
  }

  async health(): Promise<{ healthy: boolean; details?: any }> {
    return {
      healthy: true,
      details: {
        channels: Array.from(this.events.keys()),
        totalEvents: Array.from(this.events.values()).reduce((sum, events) => sum + events.length, 0),
        totalSubscribers: Array.from(this.subscribers.values()).reduce((sum, subs) => sum + subs.size, 0),
        maxHistoryPerChannel: this.maxHistory,
        persistenceEnabled: this.enablePersistence
      }
    };
  }

  async shutdown(): Promise<void> {
    // Clear all data
    this.events.clear();
    this.subscribers.clear();
  }

  // Additional utility methods for testing and debugging
  getEventCount(channel?: string): number {
    if (channel) {
      return this.events.get(channel)?.length || 0;
    }
    return Array.from(this.events.values()).reduce((sum, events) => sum + events.length, 0);
  }

  getSubscriberCount(channel?: string): number {
    if (channel) {
      return this.subscribers.get(channel)?.size || 0;
    }
    return Array.from(this.subscribers.values()).reduce((sum, subs) => sum + subs.size, 0);
  }

  getChannels(): string[] {
    return Array.from(new Set([
      ...this.events.keys(),
      ...this.subscribers.keys()
    ]));
  }

  clear(channel?: string): void {
    if (channel) {
      this.events.delete(channel);
      this.subscribers.delete(channel);
    } else {
      this.events.clear();
      this.subscribers.clear();
    }
  }
}
