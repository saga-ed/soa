import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStats } from '../accumulator.js';
import { ReportSchema, type Identity } from '../contract.js';
import { EventStatsReporter } from '../reporter.js';

const identity: Identity = {
  service: 'test',
  environment: 'synthetic',
  deployment: 'slot3',
  revision: 'abc',
  instance: 'one',
  broker: 'local',
  vhost: '/',
};
const stream = {
  role: 'producer' as const,
  exchange: 'test.events',
  eventType: 'test.created',
  eventVersion: 1,
};
const make = (maxStreams = 128) =>
  new EventStats({ identity, capabilities: ['producer', 'consumer'], maxStreams });
afterEach(() => vi.useRealTimers());

describe('cumulative event statistics', () => {
  it('declares idle capabilities and distinguishes unavailable confirms from zero', () => {
    const stats = make();
    stats.register(stream);
    const snapshot = ReportSchema.parse(stats.snapshot());
    expect(snapshot.capabilities).toEqual(['producer', 'consumer']);
    expect(snapshot.streams[0]?.counters.publishAttempts).toBe(0);
    expect(snapshot.streams[0]?.counters.publishConfirmed).toBeNull();
    expect(snapshot.streams[0]?.counters.deliveries).toBeNull();
  });
  it('preserves cumulative counters across snapshots without sharing mutable objects', () => {
    const stats = make();
    const recorder = stats.register(stream);
    recorder.increment('publishAttempts');
    const first = stats.snapshot();
    recorder.increment('publishAttempts');
    const second = stats.snapshot();
    expect(first.streams[0]?.counters.publishAttempts).toBe(1);
    expect(second.streams[0]?.counters.publishAttempts).toBe(2);
    expect(second.sequence).toBe(first.sequence + 1);
    expect(second.epoch).toBe(first.epoch);
    expect(second.reportId).not.toBe(first.reportId);
  });
  it('creates a new epoch on process restart', () => {
    expect(make().snapshot().epoch).not.toBe(make().snapshot().epoch);
  });
  it('bounds cardinality and excludes recursive telemetry', () => {
    const stats = make(1);
    stats.register(stream).increment('publishAttempts');
    stats.register({ ...stream, eventType: 'other.created' }).increment('publishAttempts');
    stats
      .register({ ...stream, eventType: 'observability.event_stats.reported' })
      .increment('publishAttempts');
    const report = stats.snapshot();
    expect(report.streams).toHaveLength(1);
    expect(report.diagnostics.droppedObservations).toBe(1);
  });
  it('uses monotonic elapsed time independently of wall clock corrections', () => {
    let elapsed = 100;
    let wall = new Date('2026-01-01T00:00:00Z');
    const stats = new EventStats({
      identity,
      capabilities: ['producer'],
      monotonicClock: () => elapsed,
      wallClock: () => wall,
    });
    elapsed += 5000;
    wall = new Date('2025-01-01T00:00:00Z');
    expect(stats.snapshot().elapsedMs).toBe(5000);
  });
  it('does not expose caller-supplied identifiers outside the contract', () => {
    expect(ReportSchema.safeParse({ ...make().snapshot(), password: 'secret' }).success).toBe(
      false
    );
    const stats = make();
    stats.register({ ...stream, eventType: 'x'.repeat(129) });
    expect(stats.snapshot().streams).toEqual([]);
  });
  it('requires explicit confirm capability on direct transport registration', () => {
    const stats = make();
    const recorder = stats.register(stream, { confirms: true });
    recorder.increment('publishConfirmed');
    expect(stats.snapshot().streams[0]?.counters.publishConfirmed).toBe(1);
  });
});

describe('bounded reporting', () => {
  it('coalesces concurrent flushes and recovers lost reports with cumulative state', async () => {
    const stats = make();
    const recorder = stats.register(stream);
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const reporter = new EventStatsReporter({ stats, transport: { send } });
    recorder.increment('publishAttempts');
    await Promise.all([reporter.flush(), reporter.flush()]);
    recorder.increment('publishAttempts');
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(2);
    const report = ReportSchema.parse(send.mock.calls[1]?.[0].payload);
    expect(report.streams[0]?.counters.publishAttempts).toBe(2);
    expect(report.diagnostics.reportingFailures).toBe(1);
  });
  it('aborts timed-out sends and never accumulates uncooperative transport operations', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const send = vi.fn((_envelope, s) => {
      signal = s;
      return new Promise<void>(() => {});
    });
    const reporter = new EventStatsReporter({ stats: make(), transport: { send }, timeoutMs: 10 });
    const first = reporter.flush();
    await vi.advanceTimersByTimeAsync(10);
    await first;
    for (let i = 0; i < 100; i++) await reporter.flush();
    expect(signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await reporter.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects oversize snapshots as a whole rather than publishing partial counters', async () => {
    const stats = make();
    const send = vi.fn();
    const reporter = new EventStatsReporter({ stats, transport: { send }, maxBytes: 1 });
    await reporter.flush();
    expect(send).not.toHaveBeenCalled();
    expect(stats.snapshot().diagnostics.oversizedReports).toBe(1);
  });
  it('sends a startup heartbeat and stops its periodic timer', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const reporter = new EventStatsReporter({
      stats: make(),
      transport: { send },
      intervalMs: 100,
      random: () => 0.5,
    });
    reporter.start();
    await vi.advanceTimersByTimeAsync(101);
    expect(send).toHaveBeenCalledTimes(2);
    await reporter.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('does not leave duplicate schedules after stopping and restarting an in-flight heartbeat', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    )
    .mockResolvedValue(undefined);
  const reporter = new EventStatsReporter({
    stats: make(),
    transport: { send },
    intervalMs: 100,
    random: () => 0.5,
  });
  reporter.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = reporter.stop();
  reporter.start();
  release();
  await stopped;
  await vi.advanceTimersByTimeAsync(101);
  expect(send).toHaveBeenCalledTimes(2);
  await reporter.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('backs off failures and returns to the normal cadence after recovery', async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const reporter = new EventStatsReporter({
    stats: make(),
    transport: { send },
    intervalMs: 100,
    random: () => 0.5,
  });
  reporter.start();
  await vi.advanceTimersByTimeAsync(199);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(400);
  expect(send).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(4);
  await reporter.stop();
});
