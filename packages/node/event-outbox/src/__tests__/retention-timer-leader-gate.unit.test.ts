import { afterEach, describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts } from '../relay.js';

afterEach(() => {
    vi.useRealTimers();
});

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function makeRelay(logger: ReturnType<typeof makeLogger>) {
    return new OutboxRelay({
        pool: {} as OutboxRelayOpts['pool'],
        connectionManager: {} as unknown as OutboxRelayOpts['connectionManager'],
        exchange: 'test.events',
        logger: logger as unknown as OutboxRelayOpts['logger'],
        retention: { intervalMs: 1000 },
    });
}

const startRetentionTimer = (relay: OutboxRelay) =>
    (relay as unknown as { startRetentionTimer: () => void }).startRetentionTimer();

// startRetentionTimer() only reads `this.retention` to schedule the interval
// callback — a plain fake with a spy is enough to test the isLeader gate
// without exercising OutboxRetention's own SQL (covered by retention.unit.test.ts).
function stubRetention(relay: OutboxRelay, sweepOnce: ReturnType<typeof vi.fn>) {
    (relay as unknown as { retention: { sweepOnce: typeof sweepOnce } }).retention = { sweepOnce };
}

function setLeader(relay: OutboxRelay, value: boolean) {
    (relay as unknown as { isLeader: boolean }).isLeader = value;
}

describe('OutboxRelay retention timer isLeader gate', () => {
    it('calls retention.sweepOnce() on tick when this instance is the elected leader', () => {
        vi.useFakeTimers();
        const relay = makeRelay(makeLogger());
        const sweepOnce = vi.fn(async () => 0);
        stubRetention(relay, sweepOnce);
        setLeader(relay, true);

        startRetentionTimer(relay);
        vi.advanceTimersByTime(1000);

        expect(sweepOnce).toHaveBeenCalledTimes(1);
    });

    it('does not call retention.sweepOnce() on tick when this instance is not the leader', () => {
        vi.useFakeTimers();
        const relay = makeRelay(makeLogger());
        const sweepOnce = vi.fn(async () => 0);
        stubRetention(relay, sweepOnce);
        setLeader(relay, false);

        startRetentionTimer(relay);
        vi.advanceTimersByTime(1000);

        expect(sweepOnce).not.toHaveBeenCalled();
    });

    it('re-checks isLeader on every tick, sweeping only while leadership holds', () => {
        vi.useFakeTimers();
        const relay = makeRelay(makeLogger());
        const sweepOnce = vi.fn(async () => 0);
        stubRetention(relay, sweepOnce);
        setLeader(relay, false);

        startRetentionTimer(relay);
        vi.advanceTimersByTime(1000);
        expect(sweepOnce).not.toHaveBeenCalled();

        setLeader(relay, true);
        vi.advanceTimersByTime(1000);
        expect(sweepOnce).toHaveBeenCalledTimes(1);

        setLeader(relay, false);
        vi.advanceTimersByTime(1000);
        expect(sweepOnce).toHaveBeenCalledTimes(1);
    });
});
