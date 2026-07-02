// Unit tests for ConnectionManager.ensureConnected + single-flight connect().
//
// Channel holders (outbox relay, event consumers) call ensureConnected()
// from their channel-recovery paths. Two invariants matter:
//   1. ensureConnected() is a no-op while the connection is usable
//      (READY / DEGRADED) — recovery ticks must not churn the connection.
//   2. Concurrent connect()/ensureConnected() callers join one in-flight
//      attempt instead of racing parallel connection loops.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../src/connection-manager.js';
import type { ConnectionState } from '../src/connection-manager.js';

vi.mock('amqplib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('amqplib')>();
    return { ...actual, connect: vi.fn() };
});

const { connect: mockConnect } = await import('amqplib');

const NOOP_LOGGER = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
};

function fakeChannelModel() {
    return { on: vi.fn(), createChannel: vi.fn() };
}

function makeManager() {
    return new ConnectionManager(NOOP_LOGGER as never, { url: 'amqp://localhost' });
}

function setState(cm: ConnectionManager, state: ConnectionState) {
    (cm as unknown as { currentState: ConnectionState }).currentState = state;
}

beforeEach(() => {
    vi.mocked(mockConnect).mockReset();
});

describe('ConnectionManager.ensureConnected', () => {
    it('is a no-op when READY', async () => {
        const cm = makeManager();
        setState(cm, 'READY');
        await cm.ensureConnected();
        expect(mockConnect).not.toHaveBeenCalled();
    });

    it('is a no-op when DEGRADED (connected but flow-blocked)', async () => {
        const cm = makeManager();
        setState(cm, 'DEGRADED');
        await cm.ensureConnected();
        expect(mockConnect).not.toHaveBeenCalled();
    });

    it('connects when DISCONNECTED and lands in READY', async () => {
        const cm = makeManager();
        vi.mocked(mockConnect).mockResolvedValue(fakeChannelModel() as never);
        await cm.ensureConnected();
        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(cm.state()).toBe('READY');
    });
});

describe('ConnectionManager.connect single-flight', () => {
    it('joins concurrent callers onto one underlying attempt', async () => {
        const cm = makeManager();
        let release!: (model: unknown) => void;
        vi.mocked(mockConnect).mockReturnValue(
            new Promise((res) => {
                release = res;
            }) as never,
        );

        const first = cm.connect();
        const second = cm.ensureConnected();
        release(fakeChannelModel());
        await Promise.all([first, second]);

        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(cm.state()).toBe('READY');
    });

    it('allows a fresh attempt after the previous one settles', async () => {
        const cm = makeManager();
        vi.mocked(mockConnect).mockResolvedValue(fakeChannelModel() as never);
        await cm.connect();
        setState(cm, 'DISCONNECTED');
        await cm.connect();
        expect(mockConnect).toHaveBeenCalledTimes(2);
    });
});
