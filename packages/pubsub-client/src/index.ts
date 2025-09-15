// Export the main client class
export { TRPCPubSubClient } from './trpc-pubsub-client.js';

// Export types and interfaces
export type {
  EventHandler,
  Subscription,
  TRPCPubSubClientConfig,
  PublishResult
} from './trpc-pubsub-client.js';

// Re-export core pubsub types for convenience
export type {
  EventEnvelope,
  EventName,
  EventDefinition
} from '@hipponot/soa-pubsub-core';
