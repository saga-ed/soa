import { buildEnvelope, type EventEnvelope } from '@saga-ed/soa-event-envelope';
import { EventStats } from './accumulator.js';
import { REPORT_EVENT_TYPE, REPORT_EVENT_VERSION, ReportSchema } from './contract.js';

export interface ReportTransport {
  /** Dedicated reporting transport. Must release channel/socket resources when aborted. */
  send(envelope: EventEnvelope, signal: AbortSignal): Promise<void>;
}
export interface ReporterOptions {
  readonly stats: EventStats;
  readonly transport: ReportTransport;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly random?: () => number;
  /** Independent local metric/log callback. No payloads or transport errors are passed. */
  readonly onError?: (kind: 'transport' | 'timeout' | 'oversized' | 'snapshot') => void;
}
export class EventStatsReporter {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private running = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private inFlight?: Promise<void>;
  private transportPending = false;
  private failures = 0;

  constructor(private readonly options: ReporterOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBytes = options.maxBytes ?? 262_144;
    for (const n of [this.intervalMs, this.timeoutMs, this.maxBytes])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error('Reporter limits must be positive safe integers');
    if (this.intervalMs > 3_600_000 || this.timeoutMs > 60_000 || this.maxBytes > 1_048_576)
      throw new Error('Reporter limits exceed supported bounds');
  }

  private error(kind: 'transport' | 'timeout' | 'oversized' | 'snapshot'): void {
    this.failures = Math.min(4, this.failures + 1);
    this.options.stats.diagnostic('reportingFailures');
    try {
      void Promise.resolve(this.options.onError?.(kind)).catch(() => {});
    } catch {
      /* the independent error sink must not fail reporting */
    }
  }

  /** Immediate heartbeat, then jittered bounded backoff; no backlog of report objects. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const tick = async () => {
      await this.flush();
      if (!this.running || generation !== this.generation) return;
      let random = 0.5;
      try {
        random = this.options.random?.() ?? Math.random();
      } catch {
        /* use centered jitter */
      }
      const jitter = 0.9 + 0.2 * (Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5);
      const delay =
        Math.min(Math.max(300_000, this.intervalMs), this.intervalMs * 2 ** this.failures) * jitter;
      this.timer = setTimeout(() => {
        void tick();
      }, delay);
      this.timer.unref?.();
    };
    void tick();
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    // A non-cooperative transport gets at most one outstanding operation, even after timeout.
    if (this.transportPending) return Promise.resolve();
    this.inFlight = this.send().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async send(): Promise<void> {
    let envelope: EventEnvelope;
    try {
      const report = ReportSchema.parse(this.options.stats.snapshot());
      envelope = buildEnvelope({
        eventType: REPORT_EVENT_TYPE,
        eventVersion: REPORT_EVENT_VERSION,
        aggregateType: 'event-stats-instance',
        aggregateId: report.epoch,
        payload: report,
      });
      if (Buffer.byteLength(JSON.stringify(envelope)) > this.maxBytes) {
        this.options.stats.diagnostic('oversizedReports');
        this.error('oversized');
        return;
      }
    } catch {
      this.error('snapshot');
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    this.transportPending = true;
    const sending = Promise.resolve()
      .then(() => this.options.transport.send(envelope, controller.signal))
      .finally(() => {
        this.transportPending = false;
      });
    const timedOut = Symbol('timeout');
    try {
      const result = await Promise.race([
        sending,
        new Promise<typeof timedOut>(resolve => {
          timeout = setTimeout(() => {
            resolve(timedOut);
            controller.abort();
          }, this.timeoutMs);
        }),
      ]);
      if (result === timedOut) this.error('timeout');
      else this.failures = 0;
    } catch {
      this.error('transport');
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** Bounded by the send timeout; final flush is best-effort and opt-in. */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    if (this.inFlight) await this.inFlight;
    if (options.flush) await this.flush();
  }
}
