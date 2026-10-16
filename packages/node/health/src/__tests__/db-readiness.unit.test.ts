import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDbReadiness } from '../db-readiness.js';
import { awaitDbAtBoot } from '../db-boot.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDbReadiness', () => {
  it('goes starting -> connected -> stale as successes stop', async () => {
    let healthy = true;
    const ping = vi.fn(async () => {
      if (!healthy) throw new TypeError('boom');
    });
    const r = createDbReadiness({ ping, intervalMs: 1000, staleAfterMs: 5000 });

    expect(await r.probe()).toEqual({ ready: false, detail: 'starting' });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await r.probe()).toEqual({ ready: true, detail: 'connected' });

    healthy = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await r.probe()).toEqual({ ready: true, detail: 'connected' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await r.probe()).toEqual({ ready: false, detail: 'stale' });
    expect(r.snapshot().lastErrorClass).toBe('TypeError');
    expect(r.snapshot().state).toBe('stale');

    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await r.probe()).toEqual({ ready: true, detail: 'connected' });
    expect(r.snapshot().lastErrorClass).toBeUndefined();
    r.stop();
  });

  it('stays starting when the first ping fails', async () => {
    const r = createDbReadiness({
      ping: async () => {
        throw new Error('down');
      },
    });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await r.probe()).toEqual({ ready: false, detail: 'starting' });
    expect(r.snapshot().lastErrorClass).toBe('Error');
    r.stop();
  });

  it('probe never calls ping', async () => {
    const ping = vi.fn(async () => undefined);
    const r = createDbReadiness({ ping });
    await r.probe();
    await r.probe();
    expect(ping).not.toHaveBeenCalled();
  });

  it('markSuccess suppresses background pings and keeps ready', async () => {
    const ping = vi.fn(async () => undefined);
    const r = createDbReadiness({ ping, intervalMs: 1000, staleAfterMs: 3000 });
    r.markSuccess();
    r.start();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(900);
      r.markSuccess();
    }
    expect(ping).not.toHaveBeenCalled();
    expect(await r.probe()).toEqual({ ready: true, detail: 'connected' });
    r.stop();
  });

  it('resumes pinging once traffic stops', async () => {
    const ping = vi.fn(async () => undefined);
    const r = createDbReadiness({ ping, intervalMs: 1000 });
    r.markSuccess();
    r.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(ping).toHaveBeenCalled();
    r.stop();
  });

  it('a ping that exceeds timeoutMs counts as a failure', async () => {
    const ping = vi.fn(() => new Promise<void>(() => {}));
    const r = createDbReadiness({ ping, intervalMs: 10000, timeoutMs: 500 });
    r.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(await r.probe()).toEqual({ ready: false, detail: 'starting' });
    expect(r.snapshot().lastErrorClass).toBe('Timeout');
    r.stop();
  });

  it('never overlaps pings', async () => {
    let active = 0;
    let maxActive = 0;
    const ping = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      active--;
    });
    const r = createDbReadiness({ ping, intervalMs: 1000, timeoutMs: 5000 });
    r.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(maxActive).toBe(1);
    expect(ping.mock.calls.length).toBeGreaterThan(1);
    r.stop();
  });

  it('stop() clears the timer', async () => {
    const ping = vi.fn(async () => undefined);
    const r = createDbReadiness({ ping, intervalMs: 1000 });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    expect(vi.getTimerCount()).toBe(0);
    const calls = ping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(ping.mock.calls.length).toBe(calls);
  });

  it('uses the injected clock', async () => {
    let t = 1000;
    const r = createDbReadiness({ ping: async () => undefined, staleAfterMs: 100, now: () => t });
    r.markSuccess();
    expect((await r.probe()).ready).toBe(true);
    t += 101;
    expect(await r.probe()).toEqual({ ready: false, detail: 'stale' });
    expect(r.snapshot().msSinceSuccess).toBe(101);
  });
});

describe('awaitDbAtBoot', () => {
  it('resolves after retries and reports each failed attempt', async () => {
    let n = 0;
    const ping = vi.fn(async () => {
      if (++n < 3) throw new Error('not yet');
    });
    const onRetry = vi.fn();
    const p = awaitDbAtBoot(ping, { retryDelayMs: 100, onRetry });
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
  });

  it('throws naming attempts and the last error at the deadline', async () => {
    const ping = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = awaitDbAtBoot(ping, { timeoutMs: 1000, retryDelayMs: 300 });
    const assertion = expect(p).rejects.toThrow(/after \d+ attempt\(s\).*ECONNREFUSED/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(ping.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a hung attempt as a failure', async () => {
    const ping = vi.fn(() => new Promise<void>(() => {}));
    const p = awaitDbAtBoot(ping, { timeoutMs: 1000, retryDelayMs: 100, attemptTimeoutMs: 200 });
    const assertion = expect(p).rejects.toThrow(/attempt timed out/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
});
