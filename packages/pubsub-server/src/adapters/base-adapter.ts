import type { EventEnvelope } from '@hipponot/pubsub-core';

export interface PubSubAdapter {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(channel: string, handler: (event: EventEnvelope) => Promise<void>): Promise<{ unsubscribe: () => Promise<void> }>;
  persist?(event: EventEnvelope): Promise<void>; // optional history
  fetchHistory?(channel: string, opts: { since?: string, limit?: number }): Promise<EventEnvelope[]>;
  health?(): Promise<{ healthy: boolean; details?: any }>;
  shutdown?(): Promise<void>;
}

export interface AdapterConfig {
  name: string;
  type: 'in-memory' | 'redis' | 'kafka' | 'nats';
  options?: Record<string, any>;
}

export interface AdapterMetrics {
  publishCount: number;
  subscribeCount: number;
  errorCount: number;
  latency: {
    min: number;
    max: number;
    avg: number;
  };
}
