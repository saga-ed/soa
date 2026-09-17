import type { Channel } from 'amqplib';
import type { Pool, PoolClient } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import {
    SpanKind,
    SpanStatusCode,
    context,
    propagation,
    trace,
} from '@opentelemetry/api';
import { assertOutboxIndexHealth, type IndexAssertMode } from './create-pool.js';
import { OutboxRetention, type OutboxRetentionOptions } from './retention.js';

export interface OutboxMetrics {
    /** Called after a row is successfully published. */
    onPublished: (eventType: string, eventVersion: number) => void;
    /** Called when publishing a row throws. */
    onPublishFailed: (eventType: string, eventVersion: number, reason: string) => void;
    /**
     * Called when this instance becomes the single leader that polls
     * outbox_event. `instance` is the caller's `instanceLabel` opt (e.g. a
     * blue/green deployment color), when set.
     */
    onLeaderAcquired?: (instance?: string) => void;
    /**
     * Called when this instance loses leadership (connection lost, a
     * watchdog yield, or stop()).
     */
    onLeaderLost?: (instance?: string) => void;
    /**
     * Called each time a non-leader instance fails to acquire the lock and
     * schedules a retry. Lets ops distinguish "lock held elsewhere, working
     * as intended" from low event volume on the graph — a wedged leader
     * looks identical to a quiet one without this.
     */
    onLeaderWaiting?: (instance?: string) => void;
    /**
     * Called when this instance voluntarily gives up leadership because it
     * could no longer make progress: `'failures'` (a sustained tick-failure
     * streak past `leaderYieldAfterMs`) or `'tick-timeout'` (a single tick
     * in flight past `leaderTickTimeoutMs`). Distinguishes a stale leader
     * that ops had to force off the lock from an ordinary connection-loss
     * `onLeaderLost`.
     */
    onLeaderYielded?: (reason: 'failures' | 'tick-timeout', instance?: string) => void;
}

export interface OutboxRelayOpts {
    /** Dedicated pg pool for the relay (separate from the service's Prisma client). */
    pool: Pool;
    /** Connection manager from @saga-ed/soa-rabbitmq for resilient AMQP. */
    connectionManager: ConnectionManager;
    /** Topic exchange to publish into (e.g., "identity.events"). */
    exchange: string;
    /** Polling cadence. Defaults to 500ms (matches ledger-api). */
    pollIntervalMs?: number;
    /** Max rows per poll. Defaults to 100. */
    batchSize?: number;
    /**
     * Max time to wait for a `'drain'` event when the AMQP channel buffer is
     * full. Without a cap, a silently-dropped TCP socket (NAT timeout, network
     * blackhole) can wedge the relay because none of `drain`/`error`/`close`
     * fires until amqplib's heartbeat eventually closes the connection.
     * Defaults to 30s.
     */
    drainTimeoutMs?: number;
    /**
     * Per-transaction `idle_in_transaction_session_timeout` (ms) for the relay's
     * drain transaction. The relay holds ONE transaction open across the whole
     * publish loop (BEGIN → SELECT … FOR UPDATE SKIP LOCKED → publish each row →
     * UPDATE → COMMIT), so the connection sits *idle in transaction* during
     * broker I/O — by design (the row locks are the multi-relay claim). If the
     * pool carries a server-side `idle_in_transaction_session_timeout` (e.g.
     * `@saga-ed/soa-postgres` >=0.1.3 defaults it ON at 30s as the gh-186
     * ack'd-but-not-durable guard), that timer would terminate the relay
     * mid-batch under broker backpressure. The relay therefore overrides it for
     * its own transaction via `SET LOCAL`. Defaults to 300_000 (5 min): a
     * generous backstop that clears any healthy or moderately-backpressured
     * batch while still bounding a truly-wedged relay. Set 0 to disable the
     * timeout entirely for the relay tx (rely solely on `drainTimeoutMs`).
     */
    txIdleTimeoutMs?: number;
    /**
     * Called when the relay encounters an unrecoverable pg error
     * (auth failure, missing role, missing database, missing table). Default
     * behavior: rethrow out of `tick()` so the parent process surfaces it via
     * `process.on('uncaughtException')` and the orchestrator restarts.
     * Override to e.g. trigger a graceful shutdown.
     */
    onFatalError?: (err: Error) => void;
    /** Optional Prometheus hooks. No-op when undefined. */
    metrics?: OutboxMetrics;
    logger: ILogger;
    /**
     * Startup check that outbox_event has a valid partial index on
     * (occurred_at) WHERE published_at IS NULL (see assertOutboxIndexHealth).
     * 'throw' (default) fails `start()` when the index is missing or broken —
     * every consumer must run the index migration BEFORE upgrading to a
     * version of this package with this default, or boot will fail until it
     * does. 'warn' logs at error level and starts anyway. 'off' skips the
     * check entirely.
     */
    indexAssert?: IndexAssertMode;
    /**
     * Retry cadence for the single-relay leader-lock acquisition attempt
     * while this instance is not currently the leader. Default: 5000.
     */
    leaderPollIntervalMs?: number;
    /**
     * Wall-clock duration a leader may spend with every `tick()` failing
     * (e.g. a dead channel that never recovers, a poisoned client, pool
     * exhaustion) before it yields leadership rather than sitting on the
     * lock forever while every sibling task idles. The streak clock starts
     * at the first failure and resets on the next successful `drainBatch`.
     * Does NOT apply to the fatal-pg-error path (`isFatalPgError`) — that
     * already halts the relay outright. Default: 60_000. Set 0 to disable.
     */
    leaderYieldAfterMs?: number;
    /**
     * Wall-clock duration a single leader tick may be in flight before a
     * watchdog treats it as wedged and yields leadership — covers a loop
     * that never returns at all (as opposed to `leaderYieldAfterMs`, which
     * covers a loop that returns but keeps failing). The in-flight tick
     * itself cannot be aborted; when it eventually settles it runs through
     * the ordinary `scheduleNext` → `tick` → `isLeader` check and, finding
     * leadership already yielded, does not drain again on its own. Default:
     * `(txIdleTimeoutMs ?? 300_000) + (drainTimeoutMs ?? 30_000)` — long
     * enough that a healthy batch under normal backpressure never trips it.
     * Set 0 to disable the watchdog.
     */
    leaderTickTimeoutMs?: number;
    /**
     * Backoff before re-pursuing the lock after `yieldLeadership()`, so a
     * healthy sibling task (if any) has time to win it first instead of the
     * same stale-but-recovering instance immediately re-acquiring its own
     * lock. Default: `2 * (leaderPollIntervalMs ?? 5000)`. If no sibling is
     * running, this task re-acquires after the backoff — that is the
     * intended fallback, not a bug.
     */
    leaderYieldBackoffMs?: number;
    /**
     * Opaque label (e.g. the blue/green deployment color) passed through
     * unexamined to every `OutboxMetrics` leader hook, so dashboards can
     * tell a dark color idling by design from a live color that cannot get
     * the lock. The relay never parses or infers this — callers own reading
     * it from their own env/config.
     */
    instanceLabel?: string;
    /**
     * Opt-in retention sweep for published rows, run only by the elected
     * leader on its own timer. Omit to disable — outbox_event then keeps
     * every published row forever (see OUTBOX_EVENT_ARCHIVE_SQL).
     */
    retention?: Pick<
        OutboxRetentionOptions,
        'retentionDays' | 'batchSize' | 'intervalMs' | 'maxRowsPerSweep' | 'maxSweepDurationMs'
    >;
}

interface OutboxRow {
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: number;
    payload: unknown;
    meta: Record<string, unknown> | null;
    occurred_at: Date;
    attempts: number;
}

const tracer = trace.getTracer('@saga-ed/soa-event-outbox');

/**
 * Polling outbox relay. Selects unpublished rows with FOR UPDATE SKIP LOCKED
 * (multi-relay safe), publishes each to RabbitMQ, then marks them published in
 * a single batched UPDATE before commit. Errors leave rows unpublished for the
 * next tick. Per-row retry budgets + DLQ wiring are not yet implemented.
 */
export class OutboxRelay {
    private channel: Channel | null = null;
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private consecutiveFailures = 0;
    private lastFailureMessage: string | null = null;
    /** Wall-clock start of the current unbroken tick-failure streak, or null between streaks. */
    private firstFailureAt: number | null = null;
    private leaderClient: PoolClient | null = null;
    private leaderClientErrorHandler: ((err: Error) => void) | null = null;
    private isLeader = false;
    private leaderTimer: NodeJS.Timeout | null = null;
    /** Wall-clock start of the currently in-flight leader tick, or null when none is running. */
    private tickStartedAt: number | null = null;
    private leaderWatchdogTimer: NodeJS.Timeout | null = null;
    private retention: OutboxRetention | null = null;
    private retentionTimer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: OutboxRelayOpts) {}

    async start(): Promise<void> {
        // `running` flips on BEFORE the first channel acquisition so
        // ensureChannel's stop-race guard can see a concurrent stop().
        this.running = true;
        try {
            await this.ensureChannel();
            await assertOutboxIndexHealth(
                this.opts.pool,
                this.opts.logger,
                this.opts.indexAssert ?? 'throw',
                this.opts.retention !== undefined,
            );
        } catch (err) {
            this.running = false;
            this.opts.logger.error(
                '[OutboxRelay] startup failed',
                err instanceof Error ? err : undefined,
            );
            // ensureChannel() may have already opened a channel before the
            // index assert threw — don't leak it on a failed start().
            if (this.channel) {
                try {
                    await this.channel.close();
                } catch {
                    // Already closed/dead — nothing to clean up.
                }
                this.channel = null;
            }
            throw err;
        }
        // Publishes use `persistent: true` for durability but do NOT wait for
        // publisher confirms — `@saga-ed/soa-rabbitmq` exposes only a plain
        // Channel today, not a ConfirmChannel. A broker crash between
        // `channel.publish` and disk persistence could drop messages. Widen
        // soa-rabbitmq with `newConfirmChannel()` to restore strict
        // at-least-once.

        if (this.opts.retention) {
            this.retention = new OutboxRetention({
                pool: this.opts.pool,
                logger: this.opts.logger,
                ...this.opts.retention,
            });
            this.startRetentionTimer();
        }

        this.opts.logger.info(`[OutboxRelay] started (exchange=${this.opts.exchange})`);
        this.startLeaderWatchdog();
        void this.pursueLeadership();
        this.scheduleNext();
    }

    /**
     * Return a live channel, creating one if the previous channel died.
     * The ConnectionManager auto-reconnects the *connection* after a socket
     * drop, but channels are not resurrected with it — without this, the
     * relay would keep publishing into the dead channel from the old
     * connection forever (one IllegalOperationError per tick until the task
     * restarts, with outbox rows backing up the whole time).
     */
    private async ensureChannel(): Promise<Channel> {
        if (this.channel) {
            return this.channel;
        }
        // Covers the case where the manager's own post-'close' reconnect
        // exhausted its retries — nothing else would retry the connection.
        // Older soa-rabbitmq versions predate ensureConnected(); the relay
        // then falls through to newChannel(), which fails descriptively on a
        // dead connection and is retried next tick.
        if (typeof this.opts.connectionManager.ensureConnected === 'function') {
            await this.opts.connectionManager.ensureConnected();
        }
        const channel = await this.opts.connectionManager.newChannel();
        // 'error' must have a listener (an unhandled EventEmitter 'error'
        // crashes the process); the terminal signal is the 'close' that
        // follows, where the channel is dropped for next-tick re-acquisition.
        channel.on('error', (err: Error) => {
            this.opts.logger.warn(`[OutboxRelay] channel error: ${err.message}`);
        });
        let closed = false;
        channel.on('close', () => {
            closed = true;
            if (this.channel === channel) {
                this.channel = null;
                if (this.running) {
                    this.opts.logger.warn(
                        '[OutboxRelay] channel lost; re-acquiring on next poll',
                    );
                }
            }
        });
        await channel.assertExchange(this.opts.exchange, 'topic', { durable: true });
        this.channel = channel;
        // Setup can race a channel death ('close' fired before the
        // assignment above, so the listener's identity guard missed it) or
        // a concurrent stop(). Either way this channel must not be cached.
        if (closed || !this.running) {
            this.channel = null;
            void Promise.resolve()
                .then(() => channel.close())
                .catch(() => {});
            throw new Error(
                closed
                    ? 'channel closed during setup'
                    : 'relay stopped during channel setup',
            );
        }
        return channel;
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.leaderTimer) {
            clearTimeout(this.leaderTimer);
            this.leaderTimer = null;
        }
        if (this.leaderWatchdogTimer) {
            clearInterval(this.leaderWatchdogTimer);
            this.leaderWatchdogTimer = null;
        }
        if (this.retentionTimer) {
            clearInterval(this.retentionTimer);
            this.retentionTimer = null;
        }
        if (this.leaderClient) {
            await this.releaseLeadership(this.leaderClient);
            this.leaderClient = null;
            this.isLeader = false;
        }
        if (this.channel) {
            try {
                await this.channel.close();
            } catch {
                // Already closed by connection manager
            }
            this.channel = null;
        }
        this.opts.logger.info('[OutboxRelay] stopped');
    }

    private scheduleNext(): void {
        if (!this.running) return;
        const interval = this.opts.pollIntervalMs ?? 500;
        this.timer = setTimeout(() => {
            void this.tick();
        }, interval);
    }

    private async tick(): Promise<void> {
        // Every task ticks on the same pollIntervalMs — cheap when not
        // leader (an in-memory flag check, no DB round-trip). Leadership
        // acquisition itself runs on its own slower loop (pursueLeadership),
        // decoupled from this one.
        if (!this.isLeader) {
            this.scheduleNext();
            return;
        }
        this.tickStartedAt = Date.now();
        try {
            await this.drainBatch();
            this.consecutiveFailures = 0;
            this.lastFailureMessage = null;
            this.firstFailureAt = null;
        } catch (err) {
            // A tick interrupted by stop() isn't a failure worth reporting.
            if (!this.running) return;
            const e = err instanceof Error ? err : new Error(String(err));
            if (isFatalPgError(e)) {
                // Configuration / permission errors aren't going to fix
                // themselves on the next tick — log loudly and stop the loop
                // so the orchestrator notices instead of burying 2 errors/sec
                // in Sentry forever. Never yield here: the relay is halting
                // outright, not handing the lock to a sibling that would hit
                // the same fatal error immediately.
                this.opts.logger.error(
                    '[OutboxRelay] fatal pg error; halting',
                    e,
                );
                this.running = false;
                if (this.opts.onFatalError) {
                    this.opts.onFatalError(e);
                } else {
                    throw e;
                }
                return;
            }
            // Throttle repeat failures: a persistent fault (broker outage,
            // wedged channel) would otherwise emit a multi-line error log
            // every poll tick until someone intervenes. Log each NEW error
            // (first of a streak, or the failure mode changing mid-outage)
            // immediately, then one heartbeat per ~60s of poll ticks.
            this.consecutiveFailures++;
            if (this.firstFailureAt === null) {
                this.firstFailureAt = Date.now();
            }
            const ticksPerHeartbeat = Math.max(
                1,
                Math.round(60_000 / (this.opts.pollIntervalMs ?? 500)),
            );
            const newError = e.message !== this.lastFailureMessage;
            this.lastFailureMessage = e.message;
            if (newError || this.consecutiveFailures % ticksPerHeartbeat === 0) {
                this.opts.logger.error(
                    `[OutboxRelay] poll failed (${this.consecutiveFailures} consecutive)`,
                    e,
                );
            }
            // A wedged leader (dead channel that never recovers, poisoned
            // client, pool exhaustion) would otherwise sit on the advisory
            // lock forever while every sibling idles. `isLeader` re-checked
            // here (not just at tick()'s top) because a concurrent watchdog
            // yield (leaderTickTimeoutMs, below) can flip it mid-tick.
            const yieldAfterMs = this.opts.leaderYieldAfterMs ?? 60_000;
            if (
                this.isLeader &&
                yieldAfterMs > 0 &&
                this.firstFailureAt !== null &&
                Date.now() - this.firstFailureAt >= yieldAfterMs
            ) {
                void this.yieldLeadership('failures');
            }
        } finally {
            this.tickStartedAt = null;
        }
        this.scheduleNext();
    }

    /**
     * pg emits 'error' on a checked-out client unconditionally when its
     * socket dies mid-use — a fresh connection from pool.connect() has no
     * listener yet, and Node's EventEmitter throws SYNCHRONOUSLY when
     * 'error' fires with nothing attached, crashing the process outright
     * (the surrounding try/catch on the query call doesn't help; the throw
     * happens inside pg's own event dispatch, not in our code). Attaches a
     * logging no-op guard for the duration of `fn`, removed in `finally`.
     * Callers that need to react to the error themselves (the leader
     * client's permanent handler) attach their own listener separately.
     */
    private async withErrorGuard<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
        const guard = (err: Error): void => {
            this.opts.logger.warn(`[OutboxRelay] client error while checked out: ${err.message}`);
        };
        client.on('error', guard);
        try {
            return await fn();
        } finally {
            client.removeListener('error', guard);
        }
    }

    private async drainBatch(): Promise<void> {
        // Re-acquire the channel BEFORE opening the pg transaction: broker
        // recovery can take seconds-to-minutes and must not run while row
        // locks are held. No-op when the channel is live.
        const channel = await this.ensureChannel();
        const batchSize = this.opts.batchSize ?? 100;
        const client = await this.opts.pool.connect();
        let clientPoisoned = false;
        try {
            await this.withErrorGuard(client, async () => {
                await client.query('BEGIN');
                // The relay holds this transaction open across the publish loop
                // (idle-in-transaction during broker I/O). Override any pool-level
                // idle_in_transaction_session_timeout for THIS tx so a server-side
                // guard (e.g. soa-postgres' default-ON 30s gh-186 guard) can't
                // terminate the relay mid-batch under backpressure. SET LOCAL is
                // scoped to this transaction and reverts on COMMIT/ROLLBACK.
                await client.query(
                    `SET LOCAL idle_in_transaction_session_timeout = ${this.opts.txIdleTimeoutMs ?? 300_000}`,
                );
                const result = await client.query<OutboxRow>(
                    `SELECT event_id, aggregate_type, aggregate_id, event_type,
                            event_version, payload, meta, occurred_at, attempts
                     FROM outbox_event
                     WHERE published_at IS NULL
                     ORDER BY occurred_at
                     LIMIT $1
                     FOR UPDATE SKIP LOCKED`,
                    [batchSize],
                );

                if (result.rows.length === 0) {
                    await client.query('COMMIT');
                    return;
                }

                const publishedIds: string[] = [];
                for (const row of result.rows) {
                    await this.publishRow(channel, row);
                    publishedIds.push(row.event_id);
                }

                // Batch the published_at update — one round-trip instead of N.
                await client.query(
                    `UPDATE outbox_event SET published_at = NOW() WHERE event_id = ANY($1::uuid[])`,
                    [publishedIds],
                );

                await client.query('COMMIT');
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                // Mid-tx connection loss can fail both ops. The pg client is
                // in unknown state and must NOT be recycled — `release(err)`
                // tells node-postgres to destroy it.
                clientPoisoned = true;
                this.opts.logger.error(
                    '[OutboxRelay] ROLLBACK failed; destroying client',
                    rollbackErr instanceof Error ? rollbackErr : undefined,
                );
            }
            throw err;
        } finally {
            if (clientPoisoned) {
                client.release(new Error('rollback failed; client destroyed'));
            } else {
                client.release();
            }
        }
    }

    /**
     * Fixed namespace for the leader lock, combined with `current_schema()`
     * so per-PR preview schemas on a shared Postgres instance each contend
     * for their OWN lock instead of one lock across every preview (mirrors
     * createOutboxPool's search_path-based isolation).
     */
    private static readonly LEADER_LOCK_NAMESPACE = 'soa-event-outbox:outbox_event';

    /** Checks out a client and attempts the lock once. Releases it immediately on failure. */
    private async tryAcquireLeadership(): Promise<PoolClient | null> {
        const client = await this.opts.pool.connect();
        return this.withErrorGuard(client, async () => {
            try {
                const { rows } = await client.query<{ locked: boolean }>(
                    'SELECT pg_try_advisory_lock(hashtext($1)::int, hashtext(current_schema())::int) AS locked',
                    [OutboxRelay.LEADER_LOCK_NAMESPACE],
                );
                if (rows[0]?.locked) {
                    return client;
                }
                client.release();
                return null;
            } catch (err) {
                client.release(err instanceof Error ? err : new Error(String(err)));
                throw err;
            }
        });
    }

    private async releaseLeadership(client: PoolClient): Promise<void> {
        // Only strip the listener that pursueLeadership() attached to THIS
        // client — a client passed in before that attachment (the
        // stop()-raced-acquisition path below) never had one. Removed
        // BEFORE the unlock query starts (not after) and replaced in the
        // same synchronous span by withErrorGuard's own listener below — a
        // real 'error' event can't land in a gap with no `await` in it, so
        // this ordering never leaves the client briefly listener-less.
        // Leaving the old handler attached instead (removing it only once
        // the unlock settles) would double up: the handler itself calls
        // client.release(err), and this method's own finally would then
        // call client.release() again on an already-released client.
        if (this.leaderClient === client && this.leaderClientErrorHandler) {
            client.removeListener('error', this.leaderClientErrorHandler);
            this.leaderClientErrorHandler = null;
        }
        let unlockErr: Error | undefined;
        try {
            // Guard against the leader client itself being the wedged one
            // (e.g. mid-yieldLeadership on a client whose socket is silently
            // dead): without a bound, this query could hang as long as the
            // dead TCP connection, keeping the advisory lock held the whole
            // time. Postgres drops session-level advisory locks on
            // disconnect, so destroying the client on timeout is enough —
            // the unlock query itself is then moot. The real query is left
            // to settle on its own (still under withErrorGuard for the whole
            // span so a late 'error' event doesn't crash the process); we
            // just stop waiting on it.
            const timeoutMs = this.opts.leaderPollIntervalMs ?? 5000;
            await this.withErrorGuard(client, () => {
                const unlockQuery = client.query(
                    'SELECT pg_advisory_unlock(hashtext($1)::int, hashtext(current_schema())::int)',
                    [OutboxRelay.LEADER_LOCK_NAMESPACE],
                );
                return new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        reject(
                            new Error(
                                `advisory unlock timed out after ${timeoutMs}ms; destroying client`,
                            ),
                        );
                    }, timeoutMs);
                    timer.unref?.();
                    unlockQuery.then(
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        (err: unknown) => {
                            clearTimeout(timer);
                            reject(err);
                        },
                    );
                });
            });
        } catch (err) {
            // Either the unlock query itself failed (connection likely
            // already dead — Postgres releases session-level advisory locks
            // on disconnect, so the lock is gone either way) or it timed
            // out. Capture the error so `release()` below destroys the
            // client instead of recycling a connection that just failed, or
            // may still be wedged, back into the pool.
            unlockErr = err instanceof Error ? err : new Error(String(err));
        } finally {
            client.release(unlockErr);
        }
    }

    /**
     * Try once to become the single relay leader. On failure, retry every
     * `leaderPollIntervalMs` without running the outbox query — the losing
     * task(s) (e.g. every green-color ECS task during a blue/green deploy)
     * sit idle instead of all polling the same table.
     */
    private async pursueLeadership(): Promise<void> {
        if (!this.running) return;
        let client: PoolClient | null;
        try {
            client = await this.tryAcquireLeadership();
        } catch (err) {
            this.opts.logger.warn(
                `[OutboxRelay] leader-lock attempt failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            this.scheduleLeaderPoll();
            return;
        }
        if (!client) {
            this.opts.metrics?.onLeaderWaiting?.(this.opts.instanceLabel);
            this.opts.logger.debug('[OutboxRelay] leader lock held elsewhere; waiting');
            this.scheduleLeaderPoll();
            return;
        }
        if (!this.running) {
            // stop() raced the acquisition.
            await this.releaseLeadership(client);
            return;
        }
        this.leaderClient = client;
        this.isLeader = true;
        // Fresh leadership cycle — don't carry a failure streak from a
        // *previous* stint (e.g. right after yieldLeadership('failures')
        // backed off and this task re-acquired) into this one.
        this.consecutiveFailures = 0;
        this.lastFailureMessage = null;
        this.firstFailureAt = null;
        // Must have a listener — an unhandled EventEmitter 'error' crashes the
        // process. A dead connection also drops the session-level advisory
        // lock on the Postgres side, so re-pursuing here is correct, not
        // just a log-and-continue.
        //
        // Named (not inline-anonymous) so it can remove itself: pg-pool only
        // frees a client's pool slot via `client.release(err)`, and a
        // listener left attached after release/stop() could otherwise fire
        // later and null out a NEWER leader's state — hence the `leaderClient
        // === client` guard below rather than clearing unconditionally.
        const onLeaderClientError = (err: Error): void => {
            client.removeListener('error', onLeaderClientError);
            if (this.leaderClientErrorHandler === onLeaderClientError) {
                this.leaderClientErrorHandler = null;
            }
            client.release(err);
            if (this.leaderClient !== client) return;
            this.opts.logger.warn(`[OutboxRelay] leader connection lost: ${err.message}; re-acquiring`);
            this.isLeader = false;
            this.leaderClient = null;
            this.opts.metrics?.onLeaderLost?.(this.opts.instanceLabel);
            if (this.running) void this.pursueLeadership();
        };
        this.leaderClientErrorHandler = onLeaderClientError;
        client.on('error', onLeaderClientError);
        this.opts.metrics?.onLeaderAcquired?.(this.opts.instanceLabel);
        this.opts.logger.info('[OutboxRelay] acquired leader lock; polling outbox_event');
    }

    private scheduleLeaderPoll(): void {
        this.scheduleLeaderPursue(this.opts.leaderPollIntervalMs ?? 5000);
    }

    /** Schedules the next `pursueLeadership()` attempt after `delayMs`, replacing any pending one. */
    private scheduleLeaderPursue(delayMs: number): void {
        if (!this.running) return;
        if (this.leaderTimer) {
            clearTimeout(this.leaderTimer);
        }
        this.leaderTimer = setTimeout(() => {
            void this.pursueLeadership();
        }, delayMs);
    }

    /**
     * Voluntarily give up leadership because this instance can no longer
     * make progress: `'failures'` (tick()'s catch path, a sustained
     * failure streak past `leaderYieldAfterMs`) or `'tick-timeout'` (the
     * watchdog below, a single tick in flight past `leaderTickTimeoutMs`).
     * Idempotent — a no-op once `isLeader` is already false, which also
     * covers the two triggers racing each other (whichever runs its
     * synchronous prefix first wins; the loser's guard trivially returns).
     *
     * `isLeader` flips to false synchronously, before any `await`, so a
     * tick already in flight when this runs (the tick-timeout case, by
     * construction) finds leadership gone the moment it settles and does
     * NOT re-enter `drainBatch` — it just falls through to `scheduleNext()`
     * like any other non-leader tick.
     */
    private async yieldLeadership(reason: 'failures' | 'tick-timeout'): Promise<void> {
        if (!this.isLeader) return;
        this.isLeader = false;
        const client = this.leaderClient;
        const detail =
            reason === 'failures'
                ? `${this.consecutiveFailures} consecutive tick failures over ${
                      this.firstFailureAt !== null ? Date.now() - this.firstFailureAt : 0
                  }ms`
                : `tick in flight for ${
                      this.tickStartedAt !== null ? Date.now() - this.tickStartedAt : 0
                  }ms`;
        this.opts.logger.error(`[OutboxRelay] yielding leadership (${reason}): ${detail}`);
        this.opts.metrics?.onLeaderLost?.(this.opts.instanceLabel);
        this.opts.metrics?.onLeaderYielded?.(reason, this.opts.instanceLabel);
        if (client) {
            // releaseLeadership's own listener-cleanup guard checks
            // `this.leaderClient === client`, so that field is nulled AFTER
            // this call returns (mirrors stop()'s ordering) rather than
            // before it.
            await this.releaseLeadership(client);
        }
        if (this.leaderClient === client) {
            this.leaderClient = null;
        }
        this.consecutiveFailures = 0;
        this.lastFailureMessage = null;
        this.firstFailureAt = null;
        if (!this.running) return;
        // Back off before re-pursuing so a healthy sibling task (if any)
        // has time to win the lock first, rather than this same
        // stale-but-recovering instance immediately re-acquiring it. If no
        // sibling exists, this task re-acquires after the backoff — that is
        // the intended fallback, not a bug.
        this.scheduleLeaderPursue(
            this.opts.leaderYieldBackoffMs ?? 2 * (this.opts.leaderPollIntervalMs ?? 5000),
        );
    }

    /**
     * Watchdog for a leader tick that never returns at all (as opposed to
     * one that returns but keeps failing, covered by `leaderYieldAfterMs`
     * in `tick()`'s own catch path). Runs on its own unref'd interval,
     * independent of the tick loop itself — a wedged tick can't run its own
     * watchdog check. Set `leaderTickTimeoutMs: 0` (or a computed default
     * that resolves to <= 0) to disable.
     */
    private startLeaderWatchdog(): void {
        const timeoutMs =
            this.opts.leaderTickTimeoutMs ??
            (this.opts.txIdleTimeoutMs ?? 300_000) + (this.opts.drainTimeoutMs ?? 30_000);
        if (timeoutMs <= 0) return;
        const periodMs = Math.min(timeoutMs / 4, 30_000);
        this.leaderWatchdogTimer = setInterval(() => {
            if (!this.isLeader || this.tickStartedAt === null) return;
            if (Date.now() - this.tickStartedAt >= timeoutMs) {
                void this.yieldLeadership('tick-timeout');
            }
        }, periodMs);
        this.leaderWatchdogTimer.unref?.();
    }

    /**
     * Drives OutboxRetention.sweepOnce() directly on the relay's own timer —
     * gated by `isLeader` at each firing — instead of calling
     * OutboxRetention.start(), which would run its own always-on timer with
     * no leader check and sweep from every task.
     */
    private startRetentionTimer(): void {
        if (!this.retention || this.retentionTimer) return;
        const intervalMs = this.opts.retention?.intervalMs ?? 60 * 60 * 1000;
        this.retentionTimer = setInterval(() => {
            if (this.isLeader) void this.retention?.sweepOnce();
        }, intervalMs);
        this.retentionTimer.unref?.();
    }

    private async publishRow(channel: Channel, row: OutboxRow): Promise<void> {
        // Restore the trace context the publisher captured at outbox-write
        // time so this PRODUCER span chains under the original request span,
        // and the consumer's CONSUMER span chains under this one. End-to-end
        // trace stays connected even though publish happens asynchronously.
        const parentCtx = row.meta
            ? propagation.extract(context.active(), row.meta as Record<string, string>)
            : context.active();

        await context.with(parentCtx, async () => {
            const span = tracer.startSpan(
                `publish ${row.event_type}.v${row.event_version}`,
                {
                    kind: SpanKind.PRODUCER,
                    attributes: {
                        'messaging.system': 'rabbitmq',
                        'messaging.destination': this.opts.exchange,
                        'messaging.destination_kind': 'topic',
                        'messaging.rabbitmq.routing_key': row.event_type,
                        'event.id': row.event_id,
                        'event.type': row.event_type,
                        'event.version': row.event_version,
                        'event.aggregate_type': row.aggregate_type,
                        'event.aggregate_id': row.aggregate_id,
                    },
                },
            );

            try {
                // Re-inject trace context AFTER starting the publish span so
                // the consumer's parent is THIS span (not the original
                // request span). That gives the consumer a direct parent
                // pointer to the publish hop, which is what shows up cleanly
                // in Jaeger as `request → publish → consume`.
                const wireMeta: Record<string, unknown> = { ...(row.meta ?? {}) };
                propagation.inject(
                    trace.setSpan(context.active(), span),
                    wireMeta,
                );

                const message = {
                    eventId: row.event_id,
                    eventType: row.event_type,
                    eventVersion: row.event_version,
                    aggregateType: row.aggregate_type,
                    aggregateId: row.aggregate_id,
                    occurredAt: row.occurred_at.toISOString(),
                    payload: row.payload,
                    ...(Object.keys(wireMeta).length > 0 ? { meta: wireMeta } : {}),
                };

                const ok = channel.publish(
                    this.opts.exchange,
                    row.event_type,
                    Buffer.from(JSON.stringify(message)),
                    {
                        contentType: 'application/json',
                        persistent: true,
                        messageId: row.event_id,
                    },
                );

                if (!ok) {
                    // Channel buffer full. Wait for drain, but also listen
                    // for 'error'/'close' AND a hard timeout — without all
                    // three, a silently-dropped TCP socket can wedge the
                    // relay because none of those events arrive until
                    // amqplib's heartbeat eventually closes the connection,
                    // and the row stays locked under FOR UPDATE SKIP LOCKED.
                    const ch = channel;
                    const timeoutMs = this.opts.drainTimeoutMs ?? 30_000;
                    await new Promise<void>((resolve, reject) => {
                        const cleanup = (): void => {
                            clearTimeout(timer);
                            ch.removeListener('drain', onDrain);
                            ch.removeListener('error', onError);
                            ch.removeListener('close', onClose);
                        };
                        const onDrain = (): void => {
                            cleanup();
                            resolve();
                        };
                        const onError = (err: Error): void => {
                            cleanup();
                            reject(err);
                        };
                        const onClose = (): void => {
                            cleanup();
                            reject(new Error('channel closed while awaiting drain'));
                        };
                        const timer = setTimeout(() => {
                            cleanup();
                            reject(
                                new Error(
                                    `timed out after ${timeoutMs}ms awaiting channel drain`,
                                ),
                            );
                        }, timeoutMs);
                        ch.once('drain', onDrain);
                        ch.once('error', onError);
                        ch.once('close', onClose);
                    });
                }

                this.opts.metrics?.onPublished(row.event_type, row.event_version);
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                this.opts.metrics?.onPublishFailed(
                    row.event_type,
                    row.event_version,
                    reason,
                );
                span.recordException(err instanceof Error ? err : new Error(reason));
                span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
                throw err;
            } finally {
                span.end();
            }
        });
    }
}

/**
 * SQLSTATE codes that indicate a misconfiguration or missing object that the
 * relay cannot recover from by retrying. Any of these surfacing repeatedly
 * means manual intervention (rotate creds, grant role, run migration) — the
 * relay should fail loudly so the orchestrator can restart and alerts fire,
 * rather than burning quota with `ERROR`-level logs forever.
 *
 * - 28P01: invalid_password (auth failure)
 * - 28000: invalid_authorization_specification
 * - 42501: insufficient_privilege (role lacks SELECT/UPDATE)
 * - 3D000: invalid_catalog_name (database missing)
 * - 42P01: undefined_table (outbox_event missing — migration not run)
 */
const FATAL_PG_CODES = new Set(['28P01', '28000', '42501', '3D000', '42P01']);

function isFatalPgError(err: Error): boolean {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && FATAL_PG_CODES.has(code);
}
