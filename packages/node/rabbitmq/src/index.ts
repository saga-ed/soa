export {
  ConnectionManager,
  ConnectionManagerClosedError,
  DEFAULT_RECONNECT_BUDGET_MS,
  type ConnectionState,
  type ReconnectConfig,
  type RabbitMQConfig,
} from './connection-manager.js';
export { MessagePublisher } from './publisher.js';
export { MessageConsumer, type ConsumeOptions, type ConsumerState, type QueueOption } from './consumer.js';
export type { QueueDefinition } from './queue.js';
