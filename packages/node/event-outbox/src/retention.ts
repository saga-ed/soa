import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * OutboxRetention — periodic sweep of published outbox_event rows into
 * outbox_event_archive (see OUTBOX_EVENT_ARCHIVE_SQL in schema.ts).
 *
 * outbox_event has no retention today — published rows sit forever, growing
 * the table (and the poll query's OFFSET-free but still-live index) without
 * bound. Rows move rather than get deleted so a bad sweep or an unexpected
 * downstream gap can be replayed; see the package README's replay recipe.
 *
 * Runs on the SAME pg.Pool OutboxRelay uses, so it honors any per-tenant
 * `search_path` schema isolation already wired into that pool.
 *
 * Exposed for standalone use (its own start()/stop()), but OutboxRelay's
 * `retention` option does not call those — it drives sweepOnce() itself on
 * its own leader-gated timer, so only the elected leader ever sweeps.
 *
 * Best-effort by design: a failed sweep logs and returns 0 — it must never
 * crash the service (the table merely grows until the next successful sweep).
 */
export interface OutboxRetentionOptions {
    pool: Pool;
    logger: ILogger;
    /** Archive outbox_event rows published more than this many days ago. Must be > 0. Default: 7. */
    retentionDays?: number;
    /** Max rows moved per DELETE/INSERT round-trip. Default: 1000. */
    batchSize?: number;
    /** Sweep cadence for the standalone start()/stop() timer. Default: 1h. */
    intervalMs?: number;
    /**
     * Cap on rows archived within one sweepOnce() call. sweepOnce() loops
     * batches of `batchSize` until this cap, `maxSweepDurationMs`, or a short
     * batch (fewer eligible rows than requested — backlog drained) is hit.
     * Without this loop, one batch per `intervalMs` caps throughput at
     * `batchSize` rows per interval (e.g. 1,000/hour at the defaults) —
     * nowhere near enough to drain a real backlog or keep up with sustained
     * publish volume above ~batchSize/intervalMs events/sec. Default: 50,000.
     */
    maxRowsPerSweep?: number;
    /**
     * Wall-clock budget (ms) for one sweepOnce() call's batch loop, checked
     * between batches. Bounds how long a single sweep can hold the pool
     * connection even under a very large backlog. Default: 30,000 (30s).
     */
    maxSweepDurationMs?: number;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_ROWS_PER_SWEEP = 50_000;
const DEFAULT_MAX_SWEEP_DURATION_MS = 30_000; // 30s

// Explicit column list (not SELECT * / bare INSERT) so a replayed event_id
// re-entering the sweep window hits ON CONFLICT DO NOTHING instead of
// failing the whole batch's INSERT on a duplicate PK forever.
const ARCHIVE_COLUMNS = [
    'event_id',
    'aggregate_type',
    'aggregate_id',
    'event_type',
    'event_version',
    'payload',
    'meta',
    'occurred_at',
    'claimed_at',
    'published_at',
    'attempts',
    'last_error',
] as const;

interface SweepBatchResult {
    /** Rows removed from outbox_event — drives the short-batch loop exit. */
    moved: number;
    /** Rows actually inserted into the archive (excludes ON CONFLICT skips). */
    archived: number;
}

export class OutboxRetention {
    private readonly pool: Pool;
    private readonly logger: ILogger;
    private readonly retentionDays: number;
    private readonly batchSize: number;
    private readonly intervalMs: number;
    private readonly maxRowsPerSweep: number;
    private readonly maxSweepDurationMs: number;
    private timer: NodeJS.Timeout | null = null;
    private sweeping = false;

    constructor(opts: OutboxRetentionOptions) {
        const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
            throw new Error(
                `OutboxRetention: retentionDays must be > 0 (got ${retentionDays}); ` +
                    'a 0/negative TTL would archive rows the relay may not have finished publishing.',
            );
        }
        this.pool = opts.pool;
        this.logger = opts.logger;
        this.retentionDays = retentionDays;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.maxRowsPerSweep = opts.maxRowsPerSweep ?? DEFAULT_MAX_ROWS_PER_SWEEP;
        this.maxSweepDurationMs = opts.maxSweepDurationMs ?? DEFAULT_MAX_SWEEP_DURATION_MS;
    }

    /**
     * Move published rows older than the TTL into outbox_event_archive,
     * looping single-batch DELETE/INSERT round-trips until a batch comes back
     * short (fewer eligible rows than requested — the backlog is drained),
     * `maxRowsPerSweep` is reached, or `maxSweepDurationMs` elapses. Returns
     * the total rows archived across the whole call. The sweep only touches
     * `published_at IS NOT NULL` rows, disjoint from the relay's own
     * `published_at IS NULL` poll, so it never contends with the relay for
     * row locks.
     *
     * `sweepBatch` selects candidates with `FOR UPDATE SKIP LOCKED`, so a row
     * held by another open transaction is skipped rather than blocking the
     * sweep. A skipped row also shrinks the batch below `limit`, which trips
     * the short-batch loop exit above even though rows remain — the next
     * interval's sweep retries them once the lock releases.
     *
     * Best-effort: a batch error is logged and stops the loop for this call
     * (returning what was archived so far) — the next interval retries.
     *
     * Re-entrancy guarded: a call that arrives while a previous sweepOnce()
     * is still running (an overrun past `intervalMs`, or a caller invoking
     * it directly alongside the timer) returns 0 immediately instead of
     * running a second batch loop concurrently against the same table.
     */
    async sweepOnce(): Promise<number> {
        if (this.sweeping) {
            this.logger.debug('[outbox-retention] sweep already in progress; skipping this tick');
            return 0;
        }
        this.sweeping = true;
        try {
            return await this.runSweep();
        } finally {
            this.sweeping = false;
        }
    }

    private async runSweep(): Promise<number> {
        const startedAt = Date.now();
        // The cap/loop-exit logic below is keyed on `moved` (rows removed
        // from outbox_event), not `archived` (rows that landed in the
        // archive table) — a batch full of ON CONFLICT DO NOTHING skips still
        // drains the backlog and still needs to count against
        // maxRowsPerSweep, or the cap never trips on a replay-heavy sweep.
        let totalMoved = 0;
        let totalArchived = 0;
        while (totalMoved < this.maxRowsPerSweep) {
            if (Date.now() - startedAt >= this.maxSweepDurationMs) break;
            const limit = Math.min(this.batchSize, this.maxRowsPerSweep - totalMoved);
            let batch: SweepBatchResult;
            try {
                batch = await this.sweepBatch(limit);
            } catch (err) {
                this.logger.error(
                    '[outbox-retention] sweep failed (best-effort; will retry next interval)',
                    err instanceof Error ? err : undefined,
                );
                break;
            }
            totalMoved += batch.moved;
            totalArchived += batch.archived;
            if (batch.moved < limit) break;
        }
        if (totalMoved > 0) {
            const skipped = totalMoved - totalArchived;
            const skippedNote = skipped > 0 ? ` (${skipped} already archived — replayed event_id)` : '';
            this.logger.info(
                `[outbox-retention] moved ${totalMoved} row(s) published more than ${this.retentionDays}d ago, ` +
                    `archived ${totalArchived}${skippedNote}`,
            );
        }
        return totalArchived;
    }

    private async sweepBatch(limit: number): Promise<SweepBatchResult> {
        const columns = ARCHIVE_COLUMNS.join(', ');
        const result = await this.pool.query<{ moved_count: number; archived_count: number }>(
            `WITH candidates AS (
                SELECT event_id FROM outbox_event
                WHERE published_at IS NOT NULL
                  AND published_at < now() - make_interval(days => $1)
                ORDER BY published_at
                LIMIT $2
                FOR UPDATE SKIP LOCKED
            ), moved AS (
                DELETE FROM outbox_event
                WHERE event_id IN (SELECT event_id FROM candidates)
                RETURNING ${columns}
            ), inserted AS (
                INSERT INTO outbox_event_archive (${columns})
                SELECT ${columns} FROM moved
                ON CONFLICT (event_id) DO NOTHING
                RETURNING event_id
            )
            SELECT
                (SELECT count(*) FROM moved)::int AS moved_count,
                (SELECT count(*) FROM inserted)::int AS archived_count`,
            [this.retentionDays, limit],
        );
        const row = result.rows[0];
        return { moved: row?.moved_count ?? 0, archived: row?.archived_count ?? 0 };
    }

    /** Sweep immediately, then every `intervalMs`. Idempotent. */
    start(): void {
        if (this.timer) return;
        void this.sweepOnce();
        this.timer = setInterval(() => {
            void this.sweepOnce();
        }, this.intervalMs);
        this.timer.unref?.();
        this.logger.info(
            `[outbox-retention] started — TTL ${this.retentionDays}d, batch ${this.batchSize} ` +
                `(cap ${this.maxRowsPerSweep}/sweep, ${Math.round(this.maxSweepDurationMs / 1000)}s budget), ` +
                `every ${Math.round(this.intervalMs / 1000)}s`,
        );
    }

    /** Stop the interval. Safe to call when not started. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
