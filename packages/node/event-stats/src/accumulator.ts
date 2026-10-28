import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ConsumerObservation } from '@saga-ed/soa-event-consumer';
import type { OutboxObservation } from '@saga-ed/soa-event-outbox';
import {
  IdentitySchema,
  StreamSchema,
  isStatsEvent,
  type Counter,
  type Counters,
  type Identity,
  type Report,
  type Stream,
} from './contract.js';

export interface AccumulatorOptions {
  readonly identity: Identity;
  readonly capabilities: ReadonlyArray<'producer' | 'consumer'>;
  readonly maxStreams?: number;
  readonly wallClock?: () => Date;
  readonly monotonicClock?: () => number;
}
export interface Recorder {
  /** Only use confirmed for a positively confirmed transport; never infer it from accepted. */
  increment(counter: Counter): void;
}
const failureReasons = () => ({
  transport: 0,
  backpressure: 0,
  envelope: 0,
  unsupported: 0,
  schema: 0,
  database: 0,
  handler: 0,
  commit: 0,
});
function counters(role: Stream['role'], confirms: boolean): Counters {
  const producer = role === 'producer' ? 0 : null;
  const consumer = role === 'consumer' ? 0 : null;
  return {
    publishAttempts: producer,
    publishAccepted: producer,
    publishConfirmed: role === 'producer' && confirms ? 0 : null,
    publishFailures: producer,
    deliveries: consumer,
    redeliveries: consumer,
    commits: consumer,
    duplicates: consumer,
    processingFailures: consumer,
    ackIssued: consumer,
    ackFailed: consumer,
    nackIssued: consumer,
    nackFailed: consumer,
    requeues: consumer,
  };
}

export class EventStats {
  private readonly identity: Identity;
  private readonly capabilities: Array<'producer' | 'consumer'>;
  private readonly streams = new Map<string, Report['streams'][number]>();
  private readonly epoch = randomUUID();
  private readonly wall: () => Date;
  private readonly monotonic: () => number;
  private readonly startedAt: string;
  private readonly startMs: number;
  private readonly maxStreams: number;
  private sequence = 0;
  private elapsedMs = 0;
  private readonly diagnostics = {
    droppedObservations: 0,
    reportingFailures: 0,
    oversizedReports: 0,
    saturatedCounters: 0,
  };

  constructor(options: AccumulatorOptions) {
    this.identity = IdentitySchema.parse(options.identity);
    this.capabilities = [...new Set(options.capabilities)];
    if (
      !this.capabilities.length ||
      this.capabilities.some(c => c !== 'producer' && c !== 'consumer')
    )
      throw new Error('Invalid capabilities');
    this.maxStreams = options.maxStreams ?? 128;
    if (!Number.isInteger(this.maxStreams) || this.maxStreams < 1 || this.maxStreams > 1024)
      throw new Error('maxStreams must be 1..1024');
    this.wall = options.wallClock ?? (() => new Date());
    this.monotonic = options.monotonicClock ?? (() => performance.now());
    this.startedAt = this.wall().toISOString();
    this.startMs = this.monotonic();
  }

  diagnostic(kind: keyof Report['diagnostics']): void {
    this.diagnostics[kind] = Math.min(Number.MAX_SAFE_INTEGER, this.diagnostics[kind] + 1);
  }

  private entry(stream: Stream, confirms = false): Report['streams'][number] | undefined {
    if (isStatsEvent(stream.eventType)) return;
    const parsed = StreamSchema.safeParse(stream);
    if (!parsed.success || !this.capabilities.includes(stream.role)) {
      this.diagnostic('droppedObservations');
      return;
    }
    const key = JSON.stringify([
      stream.role,
      stream.exchange,
      stream.queue ?? null,
      stream.consumer ?? null,
      stream.eventType,
      stream.eventVersion ?? null,
    ]);
    let entry = this.streams.get(key);
    if (!entry) {
      if (this.streams.size >= this.maxStreams) {
        this.diagnostic('droppedObservations');
        return;
      }
      entry = {
        stream: parsed.data,
        counters: counters(stream.role, confirms),
        latestSuccessAt: null,
        failureReasons: failureReasons(),
      };
      this.streams.set(key, entry);
    }
    return entry;
  }

  private increment(entry: Report['streams'][number], counter: Counter): void {
    const value = entry.counters[counter];
    if (value === null) {
      this.diagnostic('droppedObservations');
      return;
    }
    if (value >= Number.MAX_SAFE_INTEGER) {
      this.diagnostic('saturatedCounters');
      return;
    }
    entry.counters[counter] = value + 1;
    if (counter === 'commits' || counter === 'publishAccepted' || counter === 'publishConfirmed')
      entry.latestSuccessAt = this.wall().toISOString();
  }

  /** Register idle streams and direct-transport capabilities before observations arrive. */
  register(stream: Stream, options: { confirms?: boolean } = {}): Recorder {
    const entry = this.entry(stream, options.confirms);
    return {
      increment: counter => {
        if (entry) this.increment(entry, counter);
      },
    };
  }

  readonly observeOutbox = (o: OutboxObservation): void => {
    const entry = this.entry({
      role: 'producer',
      exchange: o.exchange,
      eventType: o.eventType,
      eventVersion: o.eventVersion,
    });
    if (entry)
      this.increment(
        entry,
        { attempted: 'publishAttempts', accepted: 'publishAccepted', failed: 'publishFailures' }[
          o.kind
        ] as Counter
      );
    if (entry && o.kind === 'failed' && o.reason) {
      entry.failureReasons[o.reason] = Math.min(
        Number.MAX_SAFE_INTEGER,
        entry.failureReasons[o.reason] + 1
      );
    }
  };

  readonly observeConsumer = (o: ConsumerObservation): void => {
    const entry = this.entry({
      role: 'consumer',
      exchange: o.exchange || '(direct)',
      queue: o.queue,
      consumer: o.consumerName,
      eventType: o.eventType || '(unknown)',
      eventVersion: o.eventVersion,
    });
    if (!entry) return;
    const counter: Counter = {
      delivered: 'deliveries',
      committed: 'commits',
      duplicate: 'duplicates',
      failed: 'processingFailures',
      ackIssued: 'ackIssued',
      ackFailed: 'ackFailed',
      nackIssued: 'nackIssued',
      nackFailed: 'nackFailed',
    }[o.kind] as Counter;
    this.increment(entry, counter);
    if (o.kind === 'delivered' && o.redelivered) this.increment(entry, 'redeliveries');
    if (o.kind === 'nackIssued' && o.requeue) this.increment(entry, 'requeues');
    if (o.kind === 'failed' && o.reason)
      entry.failureReasons[o.reason] = Math.min(
        Number.MAX_SAFE_INTEGER,
        entry.failureReasons[o.reason] + 1
      );
  };

  snapshot(): Report {
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error('Report sequence exhausted');
    const elapsed = this.monotonic() - this.startMs;
    if (!Number.isFinite(elapsed)) throw new Error('Invalid monotonic clock');
    this.elapsedMs = Math.max(this.elapsedMs, elapsed, 0);
    return structuredClone({
      version: 1,
      reportId: randomUUID(),
      identity: this.identity,
      epoch: this.epoch,
      sequence: ++this.sequence,
      startedAt: this.startedAt,
      observedAt: this.wall().toISOString(),
      elapsedMs: this.elapsedMs,
      capabilities: this.capabilities,
      streams: [...this.streams.values()],
      diagnostics: this.diagnostics,
    });
  }
}
