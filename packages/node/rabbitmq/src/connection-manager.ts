import 'dotenv/config';
import { connect, Channel, ChannelModel } from 'amqplib';
import { inject, injectable } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { QueueDefinition } from './queue';

export interface RabbitMQConfig {
  url: string; // eg. amqp://user:password@host:port
  
  reconnect?: ReconnectConfig;
  
  heartbeat?: number; // seconds
}

export interface ReconnectConfig {
  enabled: boolean;
  maxRetries?: number;
  initialDelay?: number; // ms
  maxDelay?: number; // ms
}

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "READY"
  | "DEGRADED"
  | "RECONNECTING"
  | "CIRCUIT_OPEN";

const DEFAULT_CONNECTION_CONFIG: Required<Omit<RabbitMQConfig, 'url'> & { reconnect: Required<ReconnectConfig> }> = {
  reconnect: {
    enabled: true,
    maxRetries: 10,
    initialDelay: 1000, // 1 second
    maxDelay: 30000, // 30 seconds
  },
  heartbeat: 60,
};

@injectable()
export class ConnectionManager {
  private config: Required<RabbitMQConfig & { reconnect: Required<ReconnectConfig> }>;
  private channelModel: ChannelModel | null = null;

  private currentState: ConnectionState = "DISCONNECTED";

  // Circuit breaker prameters
  private failureCount = 0;
  private circuitOpen = false;
  private circuitOpenTimestamp = 0;
  private readonly circuitOpenDuration = 30_000; // 30 seconds
  
  constructor(
    @inject('ILogger') private readonly logger: ILogger,
    @inject('RabbitMQConfig') config: RabbitMQConfig
  ) {
    this.logger = logger;
    this.config = {
      ...DEFAULT_CONNECTION_CONFIG,
      ...config,
      reconnect: {
        ...DEFAULT_CONNECTION_CONFIG.reconnect,
        ...config?.reconnect,
      },
    };
  }

  state() {
    return this.currentState;
  }

  private setState(state: ConnectionState) {
    this.currentState = state;
    this.logger.info(`[MQConnectionManager] State: ${state}`);
  }

  /**
   * We use a backoff strategy to reconnect to the RabbitMQ server without DDOSing our provider in a reconnect loop
   * 
   * @param attempt - The current attempt number
   * @returns The delay in milliseconds
   */
  private backoff(attempt: number) {
    const waitTime = Math.min(
      this.config.reconnect.maxDelay,
      this.config.reconnect.initialDelay * Math.pow(2, attempt), // Exponential backoff up to the max
    );

    // Add a little jitter to the wait time to avoid thundering herd effect incase we use autoscaling groups
    const jitter = Math.random() * 250;
    return waitTime + jitter;
  }

  async connect(): Promise<void> {
    if (this.isCircuitOpen()) {
      this.setState("CIRCUIT_OPEN");
      throw new Error("RabbitMQ circuit breaker is OPEN");
    }

    this.setState("CONNECTING");
    while (this.failureCount < this.config.reconnect.maxRetries) {
      try {
        const connectionOptions = {
          heartbeat: this.config.heartbeat,
        };

        this.channelModel = await connect(this.config.url, connectionOptions);
        this.setState("CONNECTED");
        this.handleChannelModelEvents(this.channelModel);

        // Mark ready and reset failure count
        this.failureCount = 0;
        this.setState("READY");
        return;
      } catch (error) {
        this.failureCount++;
        this.logger.error(`[MQConnectionManager] Error connecting to RabbitMQ: ${JSON.stringify(error)}`);

        const delay = this.backoff(this.failureCount);
        console.warn(`[ConnectionManager] Retry in ${delay}ms`);
        this.setState("RECONNECTING");
        await new Promise(res => setTimeout(res, delay));
      }
    }

    // If connection attempts have failed, open the circuit breaker
    this.tripCircuitBreaker();
  }

  async newChannel(): Promise<Channel> {
    if (!this.channelModel) {
      throw new Error('Channel model not initialized - ensure connection is established');
    }

    return this.channelModel.createChannel();
  }

  async assertQueues(queueDefinitions: QueueDefinition[]): Promise<void> {
    const channel = await this.newChannel();
    // Assert all queues in parallel
    await Promise.all(queueDefinitions.map(async (definition) => {
      await channel.assertQueue(definition.name, definition.options);
    }));
    await channel.close();
  }

  private handleChannelModelEvents(model: ChannelModel) {
    /**
     * Emitted if the connection closes for a reason other than #close being called or a graceful server-initiated close
     * This could be from a protocol transgression, a server error, a network error, a missed heartbeat, etc.
     * 'close' will be emitted immediately after this event
     */
    model.on("error", err => {
      this.logger.error(`[MQConnectionManager] Connection error: ${JSON.stringify(err)}`);
    });

    /**
     * Emitted once the closing handshake initiated by #close() has completed
     * or, if server closed the connection, once the client has sent the closing handshake
     * or, if the underlying stream (e.g., socket) has closed
     */
    model.on("close", () => {
      this.setState("DISCONNECTED");
      this.logger.warn("[MQConnectionManager] Connection closed – attempting reconnect");
      this.handleReconnection();
    });

    /**
     * Emitted when a RabbitMQ server (after version 3.2.0) decides to block the connection
     * Typically it will do this if there is some resource shortage, e.g., memory, and messages are published on the connection
     * See the RabbitMQ documentation for this extension for details: http://www.rabbitmq.com/docs/connection-blocked
     */
    model.on("blocked", reason => {
      this.logger.warn(`[MQConnectionManager] Connection blocked: ${reason}`);
      this.setState("DEGRADED");
    });

    /**
     * Emitted at some time after 'blocked', once the resource shortage has alleviated
     */
    model.on("unblocked", () => {
      this.logger.info(`[MQConnectionManager] Connection unblocked`);
      this.setState("READY");
    });
  }

  private async handleReconnection() {
    if (!this.config.reconnect.enabled) return;
    this.logger.warn("[MQConnectionManager] Attempting automatic reconnection...");
    try {
      await this.connect();
    } catch (err) {
      this.logger.error(`[MQConnectionManager] Failed to reconnect: ${err}`);
    }
  }

  /**
   * Repeated failures beyond a certain threshold will open the trip the circuit breaker
   */
  private isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;

    const diff = Date.now() - this.circuitOpenTimestamp;
    if (diff >= this.circuitOpenDuration) {
      this.circuitOpen = false;
      this.failureCount = 0;
      this.logger.warn(`[MQConnectionManager] Circuit closed (half-open).`);
      return false;
    }

    return true;
  }

  private tripCircuitBreaker() {
    this.circuitOpenTimestamp = Date.now();
    this.circuitOpen = true;
    this.setState("CIRCUIT_OPEN");
    throw new Error("RabbitMQ connection failed: circuit breaker opened");
  }
}