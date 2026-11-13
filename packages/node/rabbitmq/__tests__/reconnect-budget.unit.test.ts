// Reconnect governed by a time budget after a live connection is lost.
// The initial connect() stays capped by maxRetries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../src/connection-manager.js';
import type { RabbitMQConfig } from '../src/connection-manager.js';

vi.mock('amqplib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('amqplib')>();
    return { ...actual, connect: vi.fn() };
});

const { connect: mockConnect } = await import('amqplib');

const NOOP_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function fakeModel() {
    const handlers = new Map<string, () => void>();
    return {
        on: vi.fn((event: string, handler: () => void) => {
            handlers.set(event, handler);
        }),
        close: vi.fn().mockResolvedValue(undefined),
        createChannel: vi.fn(),
        emit: (event: string) => handlers.get(event)?.(),
    };
}

function makeManager(reconnect: Partial<NonNullable<RabbitMQConfig['reconnect']>> = {}) {
    return new ConnectionManager(NOOP_LOGGER as never, {
        url: 'amqp://localhost',
        failureMode: 'log-and-continue',
        reconnect: { enabled: true, maxRetries: 10, initialDelay: 1000, maxDelay: 30_000, ...reconnect },
    });
}

const MIN = 60_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockConnect).mockReset();
});
afterEach(() => vi.useRealTimers());

async function connectedThenLost(cm: ConnectionManager) {
    const model = fakeModel();
    vi.mocked(mockConnect).mockResolvedValueOnce(model as never);
    await cm.connect();
    vi.mocked(mockConnect).mockRejectedValue(new Error('ECONNREFUSED'));
    model.emit('close');
    await vi.advanceTimersByTimeAsync(0);
}

describe('reconnect time budget', () => {
    it('keeps retrying past maxRetries within the budget', async () => {
        const cm = makeManager();
        await connectedThenLost(cm);
        await vi.advanceTimersByTimeAsync(10 * MIN);
        // 10 attempts would be exhausted in ~3.5 min under the count cap.
        expect(vi.mocked(mockConnect).mock.calls.length).toBeGreaterThan(11);
        expect(cm.reconnectGaveUp()).toBe(false);
        expect(cm.state()).toBe('RECONNECTING');
        expect(cm.disconnectedSince()).toBeTypeOf('number');
    });

    it('resumes and clears the outage state when the broker returns inside the budget', async () => {
        const cm = makeManager();
        await connectedThenLost(cm);
        await vi.advanceTimersByTimeAsync(8 * MIN);
        vi.mocked(mockConnect).mockResolvedValue(fakeModel() as never);
        await vi.advanceTimersByTimeAsync(35_000);
        expect(cm.state()).toBe('READY');
        expect(cm.isConnected()).toBe(true);
        expect(cm.disconnectedSince()).toBeUndefined();
        expect(cm.reconnectGaveUp()).toBe(false);
    });

    it('gives up once the budget is spent, distinct from CLOSED', async () => {
        const cm = makeManager({ budgetMs: 5 * MIN });
        await connectedThenLost(cm);
        await vi.advanceTimersByTimeAsync(6 * MIN);
        expect(cm.reconnectGaveUp()).toBe(true);
        expect(cm.state()).toBe('CIRCUIT_OPEN');
        expect(cm.disconnectedSince()).toBeTypeOf('number');
        const attempts = vi.mocked(mockConnect).mock.calls.length;
        await vi.advanceTimersByTimeAsync(2 * MIN);
        // Past the breaker window the loop does not restart on its own.
        expect(vi.mocked(mockConnect).mock.calls.length).toBe(attempts);
    });

    it('a gave-up manager can still reconnect and clears the flag; a closed one cannot', async () => {
        const cm = makeManager({ budgetMs: 2 * MIN });
        await connectedThenLost(cm);
        await vi.advanceTimersByTimeAsync(3 * MIN);
        expect(cm.reconnectGaveUp()).toBe(true);

        await vi.advanceTimersByTimeAsync(31_000); // breaker half-opens
        vi.mocked(mockConnect).mockResolvedValue(fakeModel() as never);
        await cm.ensureConnected();
        expect(cm.state()).toBe('READY');
        expect(cm.reconnectGaveUp()).toBe(false);

        await cm.close();
        expect(cm.state()).toBe('CLOSED');
        expect(cm.reconnectGaveUp()).toBe(false);
        await expect(cm.connect()).rejects.toThrow(/closed/);
    });

    it('budgetMs: 0 opts out: the loss is capped by maxRetries', async () => {
        const cm = makeManager({ budgetMs: 0, maxRetries: 3, initialDelay: 10, maxDelay: 10 });
        await connectedThenLost(cm);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(cm.reconnectGaveUp()).toBe(true);
        expect(vi.mocked(mockConnect).mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('the initial connect is still capped by maxRetries, not the budget', async () => {
        const cm = makeManager({ maxRetries: 2, initialDelay: 10, maxDelay: 10 });
        vi.mocked(mockConnect).mockRejectedValue(new Error('ECONNREFUSED'));
        const connecting = cm.connect();
        await vi.advanceTimersByTimeAsync(1_000);
        await connecting;
        expect(cm.reconnectGaveUp()).toBe(true);
        expect(cm.disconnectedSince()).toBeUndefined();
        expect(vi.mocked(mockConnect)).toHaveBeenCalledTimes(2);
    });

    it('exposes the configured budget (default 15 min)', () => {
        expect(makeManager().reconnectBudgetMs()).toBe(15 * MIN);
        expect(makeManager({ budgetMs: 1234 }).reconnectBudgetMs()).toBe(1234);
    });

    it('ensureConnected fails fast while a background reconnect runs; newChannel names the outage', async () => {
        const cm = makeManager();
        await connectedThenLost(cm);
        await expect(cm.ensureConnected()).rejects.toThrow(/reconnecting/);
        await expect(cm.newChannel()).rejects.toThrow(/disconnected since .*reconnect in progress/);
    });

    it('a late close from a superseded model does not drop the live connection', async () => {
        const cm = makeManager();
        const first = fakeModel();
        vi.mocked(mockConnect).mockResolvedValueOnce(first as never);
        await cm.connect();
        vi.mocked(mockConnect).mockResolvedValue(fakeModel() as never);
        first.emit('close');
        await vi.advanceTimersByTimeAsync(0);
        expect(cm.state()).toBe('READY');
        first.emit('close');
        await vi.advanceTimersByTimeAsync(0);
        expect(cm.state()).toBe('READY');
        expect(cm.disconnectedSince()).toBeUndefined();
    });
});
