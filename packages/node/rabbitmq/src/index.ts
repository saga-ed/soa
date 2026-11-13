export {
  ConnectionManager,
  ConnectionManagerClosedError,
  DEFAULT_RECONNECT_BUDGET_MS,
  type ConnectionState,
  type ReconnectConfig,
  type RabbitMQConfig,
} from './connection-manager.js';
export { MessagePublisher } from './publisher.js';
export { MessageConsumer } from './consumer.js';
export type { QueueDefinition } from './queue.js';
