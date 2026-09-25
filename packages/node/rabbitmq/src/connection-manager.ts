import 'dotenv/config';
import { connect, Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import { inject, injectable } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { QueueDefinition } from './queue';

/**
 * Render a thrown value for a log line.
 *
 * 🪤 `JSON.stringify(new Error('boom'))` is `"{}"` — an Error's `message`,
 * `name` and `stack` are all NON-ENUMERABLE, so stringify sees no own
 * enumerable properties and emits an empty object. Every connect failure
 * therefore logged `Error connecting to RabbitMQ: {}` and the actual cause was
 * invisible: an auth rejection, a DNS failure and a TLS handshake error were
 * indistinguishable. (Cost a full prod debugging session on authz-sync, where
 * the broker was reachable and the credentials were the open question.)
 *
 * Errors from `amqplib`/Node's net stack carry the diagnostically useful bits
 * as extra own properties — `code` (e.g. `ENOTFOUND`, `ECONNREFUSED`,
 * `ECONNRESET`), `errno`, `syscall` — so surface those explicitly alongside
 * the message.
 *
 * Deliberately does NOT include the stack: these lines are emitted once per
 * retry with backoff, and a stack per attempt buries the signal. The message +
 * code is what identifies the failure mode.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    // A non-Error throw (string, object). stringify is right here — and can
    // legitimately return undefined for e.g. a thrown symbol, so guard it.
    return typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
  }
  const extra = error as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
  const parts = [`${error.name}: ${error.message}`];
  if (extra.code !== undefined) parts.push(`code=${String(extra.code)}`);
  if (extra.errno !== undefined) parts.push(`errno=${String(extra.errno)}`);
  if (extra.syscall !== undefined) parts.push(`syscall=${String(extra.syscall)}`);
  // amqplib wraps the underlying socket/auth failure in `cause`; without it an
  // auth rejection reads only as a generic connection close.
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) parts.push(`cause=${describeError(cause)}`);
  return parts.join(' ');
}

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
   * Design rationale for pattern 3 ("non-fatal broker startup") not
   * written up; see `docs/history/soa_75/README.md#missing-decisions`.
   */
  failureMode?: 'fatal' | 'log-and-continue';
}

export interface ReconnectConfig {
  enabled: boolean;
  maxRetries?: number;
  initialDelay?: number; // ms
  maxDelay?: number; // ms
}

/**
 * Thrown by `connect()`/`ensureConnected()` on a manager that has been
 * `close()`d. A distinct class, not a bare Error, because the difference
 * matters to the two long-running callers: a broker outage is worth retrying,
 * a closed manager never is. A recovery loop that cannot tell them apart
 * retries a connection that can never come back — and its own retry timer then
 * holds the process open, which is the failure `close()` exists to remove.
 *
 * ```typescript
 * catch (err) {
 *     if (err instanceof ConnectionManagerClosedError) return; // shutting down
 *     this.scheduleReconnect();
 * }
 * ```
 */
export class ConnectionManagerClosedError extends Error {
  constructor(
    message = "RabbitMQ connection manager was closed; construct a new ConnectionManager to reconnect",
  ) {
    super(message);
    this.name = "ConnectionManagerClosedError";
  }
}

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "READY"
  | "DEGRADED"
  | "RECONNECTING"
  | "CIRCUIT_OPEN"
  /**
   * Deliberately closed by `close()`. TERMINAL — distinct from DISCONNECTED,
   * which means "the link dropped and a reconnect is expected". Nothing here
   * will reconnect, and `connect()` throws rather than reviving.
   */
  | "CLOSED";

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

  /**
   * Single-flight guard: concurrent connect()/ensureConnected() callers all
   * await the same underlying attempt instead of racing parallel connection
   * loops (each channel holder — outbox relay, event consumers — recovers
   * independently, so concurrent calls are the norm after a drop).
   */
  private connectPromise: Promise<void> | null = null;

  /**
   * Set by `close()` BEFORE it awaits anything. Everything that could bring the
   * connection back — the model's 'close' handler, `handleReconnection()`, the
   * retry loop in `doConnect()`, `connect()` itself — reads this, so a close
   * cannot be undone by work that was already in flight when it was called.
   */
  private closed = false;

  /** Set by the first `close()`; later calls await the same teardown. */
  private closePromise: Promise<void> | null = null;

  /**
   * Cancels the pending `doConnect()` retry sleep, which is a plain
   * `setTimeout` — deliberately NOT unref'd, because a service reconnecting in
   * the background should keep its process alive. `close()` has to cancel it;
   * see the README's "Shutting down" section for why.
   */
  private cancelRetryWait: (() => void) | null = null;

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
    // A deliberate close is terminal. Late events — a socket we already dropped
    // emitting 'close', an attempt that was mid-flight reaching CONNECTED —
    // must not report the manager as live again.
    if (this.closed && state !== "CLOSED") return;
    if (state === this.currentState) return;
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

  /**
   * Open the connection (single-flight — see `connectPromise`).
   *
   * Throws `ConnectionManagerClosedError` once `close()` has been called: a
   * closed manager is NOT revived. Reviving would mean a stray recovery tick
   * could resurrect the socket during shutdown and hold the process open — the
   * failure this exists to prevent. A caller that genuinely wants a new
   * connection constructs a new manager.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new ConnectionManagerClosedError();
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  /**
   * Reconnect if (and only if) the connection is not currently usable.
   * Channel holders call this from their recovery paths before requesting a
   * fresh channel — it covers the gap where an automatic reconnect after
   * 'close' exhausted its retries and nothing else would ever try again.
   * No-op when READY (or DEGRADED, i.e. connected but flow-blocked).
   * Throws when the connection is not usable afterwards — including in
   * `log-and-continue` mode, where connect() itself resolves after a
   * circuit-breaker trip. Callers are expected to retry on their own
   * cadence (poll tick, backoff timer).
   */
  async ensureConnected(): Promise<void> {
    if (this.currentState === "READY" || this.currentState === "DEGRADED") {
      return;
    }
    await this.connect();
    const state = this.state();
    if (state !== "READY" && state !== "DEGRADED") {
      throw new Error(
        `RabbitMQ connection unavailable after connect attempt (state=${state})`,
      );
    }
  }

  /**
   * Shut the connection down and stop reconnecting.
   *
   * For processes that are meant to END — a one-shot operator CLI, a migration,
   * a test — rather than for services, which hold their connection for their
   * whole lifetime. The README's "Shutting down" section has the why and the
   * full contract; in short it is terminal (a later `connect()` throws
   * `ConnectionManagerClosedError` rather than reviving), idempotent, never
   * throws, and leaves nothing holding the event loop — no socket, and no
   * pending retry timer. (The circuit breaker needs no handling here: it is a
   * timestamp compared on read, not a timer.)
   *
   * Reconnection is suppressed at every point that could undo it: this method,
   * the model's own 'close' event, `handleReconnection()`, `connect()` and the
   * `doConnect()` retry loop all read the same `closed` flag.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Set before anything can await, so an in-flight attempt cannot land a
    // usable connection behind our back.
    this.closed = true;
    this.setState("CLOSED");
    this.cancelRetryWait?.();
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    // An attempt in flight owns a socket this method cannot see yet. Wait for
    // it to settle — it either hands the socket over via `channelModel` or,
    // seeing `closed`, drops it itself. Either way nothing is orphaned. Its
    // failure is not this call's failure, so swallow it; and the retry loop
    // exits promptly because the sleep above was already cancelled.
    const inFlight = this.connectPromise;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // A connect that failed leaves nothing to close.
      }
    }

    const model = this.channelModel;
    this.channelModel = null;
    if (model) await this.closeQuietly(model);
    this.logger.info("[MQConnectionManager] Connection closed");
  }

  /** Close one channel model, reporting rather than throwing on failure. */
  private async closeQuietly(model: ChannelModel): Promise<void> {
    try {
      await model.close();
    } catch (error) {
      // Closing a socket the broker already dropped throws, and there is
      // nothing left to do about it — the connection is gone either way.
      this.logger.warn(
        `[MQConnectionManager] Error closing connection (ignored): ${describeError(error)}`,
      );
    }
  }

  private async doConnect(): Promise<void> {
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

        const model = await connect(this.config.url, connectionOptions);
        // close() ran while this attempt was in flight. It cannot see a socket
        // that did not exist when it looked, so drop it here — otherwise the
        // connection close() was called to stop is left open and holding the
        // event loop.
        if (this.closed) {
          await this.closeQuietly(model);
          return;
        }
        this.channelModel = model;
        this.setState("CONNECTED");
        this.handleChannelModelEvents(this.channelModel);

        // Mark ready and reset failure count
        this.failureCount = 0;
        this.setState("READY");
        return;
      } catch (error) {
        this.failureCount++;
        this.logger.error(`[MQConnectionManager] Error connecting to RabbitMQ: ${describeError(error)}`);

        // Checked BEFORE the timer is armed, not only after the sleep.
        // close() can only cancel a wait that already exists; if it landed
        // while this attempt was still in amqplib's hands, arming a fresh
        // timer here would hold the event loop for a whole backoff AND keep
        // close() itself pending behind `await inFlight` — the exact hang a
        // one-shot CLI calls close() to avoid.
        if (this.closed) return;

        const delay = this.backoff(this.failureCount);
        this.logger.warn(`[MQConnectionManager] Retry in ${Math.round(delay)}ms`);
        this.setState("RECONNECTING");
        await this.waitBeforeRetry(delay);
        this.cancelRetryWait = null;
        // The wait ends early when close() cancels it. Stop retrying rather
        // than opening another socket nobody is going to use.
        if (this.closed) return;
      }
    }

    // If connection attempts have failed, open the circuit breaker
    this.tripCircuitBreaker();
  }

  /**
   * Sleep between connection attempts, interruptibly.
   *
   * Resolves either when the delay elapses or when `close()` cancels it, and
   * leaves no timer behind in either case.
   */
  private waitBeforeRetry(delay: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, delay);
      this.cancelRetryWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
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
      this.logger.error(`[MQConnectionManager] Connection error: ${describeError(err)}`);
    });

    /**
     * Emitted once the closing handshake initiated by #close() has completed
     * or, if server closed the connection, once the client has sent the closing handshake
     * or, if the underlying stream (e.g., socket) has closed
     */
    model.on("close", () => {
      // close() closed it on purpose; this event is the confirmation, not a
      // failure. Reconnecting here would defeat the whole point of close().
      if (this.closed) return;
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
    // Belt and braces with the 'close' handler's own guard. The handler's
    // guard is what keeps a deliberate shutdown out of the operator's log;
    // this one is on the only line that actually reconnects, so a future
    // second trigger cannot reintroduce the bug by forgetting to check.
    if (this.closed) return;
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