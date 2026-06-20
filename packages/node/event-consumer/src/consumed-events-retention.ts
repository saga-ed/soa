import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * ConsumedEventsRetention — periodic sweep of the at-least-once dedup table.
 *
 * `consumed_events` (consumer_name, event_id, processed_at) gets a row per
 * processed event and nothing ever removes them, so the table and its
 * processed_at index grow unbounded. This sweep deletes rows older than a TTL
 * that is far beyond any realistic broker redelivery window, so dedup
 * correctness is preserved while the table stays bounded.
 *
 * Runs on the SAME pg.Pool the OutboxRelay / EventConsumer use, so it honors
 * any per-tenant `search_path` schema isolation already wired into that pool.
 *
 * Best-effort by design: a failed sweep logs and returns 0 — it must never
 * crash the service (the table merely grows until the next successful sweep).
 */
export interface ConsumedEventsRetentionOptions {
  pool: Pool;
  logger: ILogger;
  /** Delete consumed_events rows older than this many days. Must be > 0. */
  retentionDays: number;
  /** Sweep cadence in ms. Default: 6h. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export class ConsumedEventsRetention {
  private readonly pool: Pool;
  private readonly logger: ILogger;
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: ConsumedEventsRetentionOptions) {
    if (!Number.isFinite(opts.retentionDays) || opts.retentionDays <= 0) {
      throw new Error(
        `ConsumedEventsRetention: retentionDays must be > 0 (got ${opts.retentionDays}); ` +
          'a 0/negative TTL would delete live dedup rows and break at-least-once idempotency.',
      );
    }
    this.pool = opts.pool;
    this.logger = opts.logger;
    this.retentionDays = opts.retentionDays;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Delete consumed_events rows older than the TTL. Returns the number deleted.
   * Best-effort: errors are logged and swallowed (returns 0).
   *
   * The TTL is passed as a bound parameter and applied via
   * `make_interval(days => $1)` so the interval is never string-concatenated
   * into the SQL.
   */
  async sweepOnce(): Promise<number> {
    try {
      const result = await this.pool.query(
        'DELETE FROM consumed_events WHERE processed_at < now() - make_interval(days => $1)',
        [this.retentionDays],
      );
      const deleted = result.rowCount ?? 0;
      if (deleted > 0) {
        this.logger.info(
          `[consumed-events-retention] swept ${deleted} row(s) older than ${this.retentionDays}d`,
        );
      }
      return deleted;
    } catch (err) {
      this.logger.error(
        '[consumed-events-retention] sweep failed (best-effort; will retry next interval)',
        err instanceof Error ? err : undefined,
      );
      return 0;
    }
  }

  /** Sweep immediately, then every `intervalMs`. Idempotent. */
  start(): void {
    if (this.timer) return;
    void this.sweepOnce();
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the sweep.
    this.timer.unref?.();
    this.logger.info(
      `[consumed-events-retention] started — TTL ${this.retentionDays}d, every ${Math.round(this.intervalMs / 1000)}s`,
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
