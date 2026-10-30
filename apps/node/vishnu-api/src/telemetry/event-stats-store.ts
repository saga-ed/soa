import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ReportSchema,
  compareReports,
  type Report,
  type ReportComparison,
} from '@saga-ed/soa-event-stats';
import { applyPreviewTag } from '@saga-ed/soa-event-envelope';

export type TelemetryScope = Pick<
  Report['identity'],
  'environment' | 'deployment' | 'broker' | 'vhost'
>;
export const REPORTERS = {
  'iam-api': 'iam.events',
  'programs-api': 'programs.events',
  'scheduling-api': 'scheduling.events',
  // d10 wave 1 (program-hub); Datadog service names confirmed for d6.
  'sessions-api': 'sess.events',
  'content-api': 'content.events',
} as const;
export type ReporterExchanges = Readonly<Record<keyof typeof REPORTERS, string>>;
/** A patch-party sandbox identifier, the value its services put in EVENT_PREVIEW_TAG. */
export const SANDBOX_PREVIEW_TAG = /^sandbox-[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$/;
/**
 * d9: validates an optional sandbox observation tag. Absent or empty means the
 * untagged dev mesh. A tag must be `sandbox-<name>` and must equal the exact MQ
 * deployment, so one receiver never mixes a sandbox with another population.
 */
export function mqPreviewTag(tag: string | undefined, deployment: string | undefined) {
  if (!tag) return undefined;
  if (!SANDBOX_PREVIEW_TAG.test(tag)) throw new Error('MQ preview tag must be sandbox-<name>');
  if (deployment !== tag)
    throw new Error('A sandbox observer must use its preview tag as MQ deployment');
  return tag;
}
/**
 * The reporter exchange each service must publish on. With a sandbox tag, every
 * exchange gets the same applyPreviewTag suffix the sandboxed publishers use.
 * Without one this is REPORTERS itself; the process environment is never read.
 */
export function reporterExchanges(previewTag?: string): ReporterExchanges {
  if (!previewTag) return REPORTERS;
  return Object.fromEntries(
    Object.entries(REPORTERS).map(([service, exchange]) => [
      service,
      applyPreviewTag(exchange, previewTag),
    ])
  ) as ReporterExchanges;
}
export type ApplyResult = 'accepted' | 'ignored' | 'scope' | 'capacity';
const keyFor = (r: Report) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        r.identity.environment,
        r.identity.deployment,
        r.identity.broker,
        r.identity.vhost,
        r.identity.service,
        r.identity.revision,
        r.identity.instance,
      ])
    )
    .digest('hex');

/** Dedicated Vishnu database. Snapshot and rate baseline advance atomically before AMQP ack. */
export class EventStatsStore {
  constructor(
    private readonly pool: Pool,
    readonly scope: TelemetryScope,
    private readonly limits = {
      sources: 256,
      epochs: 64,
      retentionMs: 86_400_000,
      staleMs: 90_000,
    },
    private readonly reporters: ReporterExchanges = REPORTERS
  ) {}
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS event_stats_source (
      source_key text PRIMARY KEY, report jsonb NOT NULL, comparison jsonb NOT NULL,
      retired_epochs text[] NOT NULL DEFAULT '{}', received_at timestamptz NOT NULL,
      CHECK (jsonb_array_length(report->'streams') <= 1024)
    )`);
  }
  async apply(input: unknown, exchange: string, now = new Date()): Promise<ApplyResult> {
    const report = ReportSchema.parse(input);
    if (
      Object.entries(this.scope).some(([k, v]) => report.identity[k as keyof TelemetryScope] !== v)
    )
      return 'scope';
    const service = report.identity.service;
    if (!Object.hasOwn(this.reporters, service)) return 'scope';
    if (this.reporters[service as keyof ReporterExchanges] !== exchange) return 'scope';
    const key = keyFor(report);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the source-capacity check as well as epoch transitions across receiver replicas.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vishnu-event-stats-v1'))");
      await client.query('DELETE FROM event_stats_source WHERE received_at < $1', [
        new Date(now.getTime() - this.limits.retentionMs),
      ]);
      const rows = await client.query<{ report: Report; retired_epochs: string[] }>(
        'SELECT report, retired_epochs FROM event_stats_source WHERE source_key=$1 FOR UPDATE',
        [key]
      );
      const prior = rows.rows[0];
      let retired = prior?.retired_epochs ?? [];
      if (retired.includes(report.epoch)) {
        await client.query('COMMIT');
        return 'ignored';
      }
      const comparison = compareReports(prior?.report, report);
      if (comparison.status === 'ignored') {
        await client.query('COMMIT');
        return 'ignored';
      }
      if (prior && prior.report.epoch !== report.epoch) {
        // Fail closed at the tombstone bound; never forget a retired epoch while a source is live.
        if (retired.length >= this.limits.epochs) {
          await client.query('COMMIT');
          return 'capacity';
        }
        retired = [...retired, prior.report.epoch];
      }
      if (!prior) {
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM event_stats_source'
        );
        if (Number(count.rows[0]?.count) >= this.limits.sources) {
          await client.query('COMMIT');
          return 'capacity';
        }
      }
      await client.query(
        `INSERT INTO event_stats_source VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (source_key) DO UPDATE SET report=EXCLUDED.report, comparison=EXCLUDED.comparison,
          retired_epochs=EXCLUDED.retired_epochs, received_at=EXCLUDED.received_at`,
        [key, report, comparison, retired, now]
      );
      await client.query('COMMIT');
      return 'accepted';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async read(now = new Date()) {
    const result = await this.pool.query<{
      report: Report;
      comparison: ReportComparison;
      received_at: Date;
    }>(
      'SELECT report, comparison, received_at FROM event_stats_source WHERE received_at >= $1 ORDER BY source_key LIMIT $2',
      [new Date(now.getTime() - this.limits.retentionMs), this.limits.sources]
    );
    return {
      version: 1,
      scope: this.scope,
      observedAt: now.toISOString(),
      staleAfterMs: this.limits.staleMs,
      sources: result.rows
        .filter(row =>
          Object.entries(this.scope).every(
            ([k, v]) => row.report.identity[k as keyof TelemetryScope] === v
          )
        )
        .map(row => {
          const fresh = now.getTime() - row.received_at.getTime() <= this.limits.staleMs;
          return {
            report: row.report,
            receivedAt: row.received_at.toISOString(),
            freshness: fresh ? 'fresh' : 'stale',
            role:
              row.report.capabilities.length === 2
                ? 'MQ-P/C'
                : row.report.capabilities[0] === 'producer'
                  ? 'MQ-P'
                  : 'MQ-C',
            comparison: fresh ? row.comparison : null,
            mapping: {
              service: row.report.identity.service,
              status: 'declared',
              streams: row.report.streams.map(s => ({
                ...s.stream,
                status: 'unverified-topology',
              })),
            },
          };
        }),
    };
  }
}
