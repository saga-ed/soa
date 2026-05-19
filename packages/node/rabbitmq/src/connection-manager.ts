import 'dotenv/config';
import { connect, Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import { inject, injectable } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { QueueDefinition } from './queue';

export interface RabbitMQConfig {
  url: string; // eg. amqp://user:password@host:port

  reconnect?: ReconnectConfig;

  heartbeat?: number; // seconds

  /**
   * What to do when initial `connect()` exhausts retries and trips the
   * circuit breaker:
   *
   * - `'fatal'`: throw, so the host process can crash and surface a clear
   *   alert. Correct in production — a service that "soft fails" event
   *   publication accumulates outbox debt invisibly until alerting catches
   *   it.
   * - `'log-and-continue'`: log a warning and return without throwing, so
   *   the service can still serve request-path traffic while the broker is
   *   unreachable. The outbox table absorbs the writes; the relay reconnects
   *   when the broker returns. Correct in dev/test where the broker is more
   *   flaky than the service itself.
   *
   * Default: `'fatal'` when `process.env.NODE_ENV === 'production'`,
   * `'log-and-continue'` otherwise. Set explicitly to override that default
   * — e.g. a CI/staging environment where you want fail-loud behavior.
   *
   * See `claude/projects/soa_75/decisions/d-consumer-resilience.md` pattern
   * 3 ("non-fatal broker startup") for the rationale.
   */
  failureMode?: 'fatal' | 'log-and-continue';
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

const DEFAULT_CONNECTION_CONFIG: Required<Omit<RabbitMQConfig, 'url' | 'failureMode'> & { reconnect: Required<ReconnectConfig> }> = {
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
  private config: Required<Omit<RabbitMQConfig, 'failureMode'> & { reconnect: Required<ReconnectConfig> }> & { failureMode?: 'fatal' | 'log-and-continue' };
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

  /**
   * Open a publisher-confirms channel. Use this when the caller needs broker
   * acknowledgement that a published message has been routed and persisted
   * before considering it durable. Compared to `newChannel()`:
   *
   *   - publish() / sendToQueue() take an additional callback that fires
   *     once the broker confirms (ack) or rejects (nack) the message.
   *   - waitForConfirms() resolves only after the broker has confirmed every
   *     message published on the channel since the last waitForConfirms().
   *   - confirms add ~1 broker round-trip per publish (or per batch when
   *     pipelining + waitForConfirms()), so plain newChannel() is preferable
   *     when the caller doesn't need the durability signal.
   *
   * Typical use: outbox relays that mark a row "published" only after the
   * broker confirms — without confirms, an async broker rejection (e.g. 404
   * on an unknown exchange, mandatory-flag failure) silently leaves the
   * row marked published and the message lost.
   */
  async newConfirmChannel(): Promise<ConfirmChannel> {
    if (!this.channelModel) {
      throw new Error('Channel model not initialized - ensure connection is established');
    }

    return this.channelModel.createConfirmChannel();
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
    const mode = this.resolveFailureMode();
    const message = "RabbitMQ connection failed: circuit breaker opened";
    if (mode === 'log-and-continue') {
      this.logger.warn(
        `[MQConnectionManager] ${message} — failureMode='log-and-continue', not throwing. ` +
          'Outbox writes will accumulate; the relay will reconnect on the next attempt.',
      );
      return;
    }
    throw new Error(message);
  }

  private resolveFailureMode(): 'fatal' | 'log-and-continue' {
    if (this.config.failureMode) return this.config.failureMode;
    return process.env.NODE_ENV === 'production' ? 'fatal' : 'log-and-continue';
  }
}