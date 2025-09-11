import type { AnyTRPCRouter } from '@trpc/server';
import type { EventDefinition, EventEnvelope, ChannelConfig } from '@hipponot/pubsub-core';
import type { PubSubAdapter } from '../adapters/base-adapter.js';

export interface PubSubServerOptions {
  router: AnyTRPCRouter;
  events: Record<string, EventDefinition>;
  channels?: ChannelConfig[];
  adapter: PubSubAdapter;
  auth?: (ctx: ServerCtx) => Promise<User | null>;
  subscriptionPath?: string;
  ssePath?: string;
}

export interface ServerCtx {
  user?: User;
  requestId?: string;
  services: {
    db: any; // Will be properly typed when integrated
    cache?: any;
    logger: any;
    idempotency?: any;
  };
}

export interface User {
  id: string;
  roles: string[];
  email?: string;
}

export interface SendEventInput {
  name: string;
  payload: any;
  clientEventId?: string;
  correlationId?: string;
}

export interface SendEventResult {
  status: 'success' | 'error';
  result?: any;
  emittedEvents?: EventEnvelope[];
  error?: string;
}

export interface SubscribeInput {
  channel: string;
  filters?: Record<string, any>;
  cursor?: string;
}

export interface FetchHistoryInput {
  channel: string;
  since?: string;
  limit?: number;
}

export interface Logger {
  info(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
}

export interface IPubSubServer {
  router: AnyTRPCRouter;
  createSSEHandler: (req: any, res: any) => Promise<void>;
  shutdown: () => Promise<void>;
}

export const TYPES = {
  PubSubService: Symbol.for('PubSubService'),
  EventService: Symbol.for('EventService'),
  ChannelService: Symbol.for('ChannelService'),
  PubSubAdapter: Symbol.for('PubSubAdapter'),
  Logger: Symbol.for('Logger'),
} as const; 