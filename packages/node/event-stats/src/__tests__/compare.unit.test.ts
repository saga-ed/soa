import { describe, expect, it } from 'vitest';
import { EventStats } from '../accumulator.js';
import { compareReports } from '../compare.js';

function fixture(instance = 'one') {
  let time = 0;
  const stats = new EventStats({
    identity: {
      service: 'test',
      environment: 'local',
      deployment: 'slot3',
      revision: 'a',
      instance,
      broker: 'local',
      vhost: '/',
    },
    capabilities: ['producer'],
    monotonicClock: () => time,
  });
  const recorder = stats.register({
    role: 'producer',
    exchange: 'test.events',
    eventType: 'test.created',
    eventVersion: 1,
  });
  return {
    stats,
    recorder,
    advance: () => {
      time += 1000;
    },
  };
}
describe('receiver reference calculations', () => {
  it('bridges missed reports using actual elapsed time', () => {
    const f = fixture();
    const first = f.stats.snapshot();
    f.recorder.increment('publishAccepted');
    f.advance();
    f.stats.snapshot();
    f.recorder.increment('publishAccepted');
    f.advance();
    const result = compareReports(first, f.stats.snapshot());
    expect(result.intervalMs).toBe(2000);
    expect(result.streams[0]?.deltas.publishAccepted).toBe(2);
    expect(result.streams[0]?.rates.publishAccepted).toBe(1);
    expect(result.streams[0]?.rates.publishConfirmed).toBeNull();
  });
  it('ignores duplicate and out-of-order sequences', () => {
    const f = fixture();
    const a = f.stats.snapshot();
    f.advance();
    const b = f.stats.snapshot();
    expect(compareReports(a, a).status).toBe('ignored');
    expect(compareReports(b, a).status).toBe('ignored');
  });
  it('does not subtract across restarts, replicas or environment scopes', () => {
    const a = fixture().stats.snapshot();
    const b = fixture().stats.snapshot();
    expect(compareReports(a, b).status).toBe('baseline');
    expect(
      compareReports(a, { ...b, epoch: a.epoch, identity: { ...a.identity, instance: 'two' } })
        .status
    ).toBe('baseline');
    expect(
      compareReports(a, { ...b, epoch: a.epoch, identity: { ...a.identity, deployment: 'slot4' } })
        .status
    ).toBe('baseline');
    expect(compareReports(undefined, a).streams[0]?.rates.publishAccepted).toBeNull();
  });
  it('does not invent a rate for zero duration or decreasing counters', () => {
    const f = fixture();
    f.recorder.increment('publishAccepted');
    const a = f.stats.snapshot();
    const b = f.stats.snapshot();
    expect(compareReports(a, b).streams[0]?.rates.publishAccepted).toBeNull();
    b.elapsedMs = 1000;
    b.streams[0]!.counters.publishAccepted = 0;
    expect(compareReports(a, b).streams[0]?.deltas.publishAccepted).toBeNull();
  });
});
