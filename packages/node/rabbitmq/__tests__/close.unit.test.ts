// Unit tests for ConnectionManager.close().
//
// The point of close() is that a process which has finished its work can END.
// An open AMQP socket holds Node's event loop, so the invariants that actually
// matter are: the connection is torn down, nothing reconnects behind the
// caller's back, and no timer is left running. The last two are the ones that
// silently fail — a reconnect or a pending backoff keeps the process alive just
// as effectively as the original socket did, and the test that only asserts
// "close() resolved" would pass throughout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, ConnectionManagerClosedError } from '../src/connection-manager.js';

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

interface FakeModel {
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    createChannel: ReturnType<typeof vi.fn>;
    /** Fire the handler the manager registered for `event`, as amqplib would. */
    emit(event: string): void;
}

function fakeChannelModel(closeImpl?: () => Promise<void>): FakeModel {
    const handlers = new Map<string, () => void>();
    return {
        on: vi.fn((event: string, handler: () => void) => {
            handlers.set(event, handler);
        }),
        close: vi.fn(closeImpl ?? (() => Promise.resolve())),
        createChannel: vi.fn(),
        emit(event: string) {
            handlers.get(event)?.();
        },
    };
}

function makeManager(overrides: { maxRetries?: number; initialDelay?: number } = {}) {
    return new ConnectionManager(NOOP_LOGGER as never, {
        url: 'amqp://localhost',
        failureMode: 'log-and-continue',
        reconnect: {
            enabled: true,
            maxRetries: overrides.maxRetries ?? 10,
            initialDelay: overrides.initialDelay ?? 1000,
            maxDelay: 30_000,
        },
    });
}

beforeEach(() => {
    vi.mocked(mockConnect).mockReset();
    // Module-level, so without this a test asserts on the previous test's log
    // lines. Cleared wholesale rather than per-level: an asymmetry here is the
    // kind of thing that makes a later `info` assertion depend on test order.
    for (const spy of Object.values(NOOP_LOGGER)) spy.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ConnectionManager.close', () => {
    it('closes the underlying connection and reports CLOSED', async () => {
        const model = fakeChannelModel();
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();

        await cm.close();

        expect(model.close).toHaveBeenCalledOnce();
        expect(cm.state()).toBe('CLOSED');
    });

    it('DOES NOT RECONNECT when the model emits close as a result', async () => {
        // The regression this whole change turns on. amqplib emits 'close' when
        // the socket goes, whether the broker dropped it or we asked — and the
        // handler's job in every other case is to reconnect. If it reconnects
        // here, close() opens a fresh socket, the event loop stays alive, and
        // the CLI hangs exactly as it did before.
        const model = fakeChannelModel();
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();
        expect(mockConnect).toHaveBeenCalledTimes(1);

        await cm.close();
        model.emit('close');
        // Let any reconnect that was going to be scheduled actually run.
        await Promise.resolve();
        await Promise.resolve();

        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(cm.state()).toBe('CLOSED');
        // Not merely "the reconnect failed" — it is never attempted. connect()
        // refusing a closed manager would make the count above pass on its own,
        // and an operator reading a log full of failed-reconnect noise after a
        // clean shutdown has been told something untrue.
        expect(NOOP_LOGGER.warn).not.toHaveBeenCalledWith(
            expect.stringMatching(/attempting reconnect|automatic reconnection/i),
        );
        expect(NOOP_LOGGER.error).not.toHaveBeenCalled();
    });

    it('ignores late events from the connection it dropped', async () => {
        // 'unblocked' after a close would otherwise report the manager READY.
        const model = fakeChannelModel();
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();

        await cm.close();
        model.emit('unblocked');

        expect(cm.state()).toBe('CLOSED');
    });

    it('is idempotent — a second close tears down once and does not throw', async () => {
        const model = fakeChannelModel();
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();

        await cm.close();
        await expect(cm.close()).resolves.toBeUndefined();

        expect(model.close).toHaveBeenCalledOnce();
    });

    it('is a no-op when it was never connected', async () => {
        const cm = makeManager();

        await expect(cm.close()).resolves.toBeUndefined();

        expect(mockConnect).not.toHaveBeenCalled();
        expect(cm.state()).toBe('CLOSED');
    });

    it('does not throw when the broker already dropped the socket', async () => {
        // Teardown of a connection that is already gone throws in amqplib. A
        // tidy-up failure must not turn a successful run into a failed one.
        const model = fakeChannelModel(() => Promise.reject(new Error('Connection closed')));
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();

        await expect(cm.close()).resolves.toBeUndefined();

        expect(NOOP_LOGGER.warn).toHaveBeenCalledWith(
            expect.stringMatching(/Error closing connection/),
        );
        expect(cm.state()).toBe('CLOSED');
    });

    it('closes the socket an in-flight connect() opens after it', async () => {
        // The race: close() is called while connect() is awaiting amqplib, so
        // there is no socket for it to close yet. Whoever ends up holding it
        // has to drop it, or the CLI hangs on a connection nobody asked for.
        const model = fakeChannelModel();
        let landConnection!: (model: unknown) => void;
        vi.mocked(mockConnect).mockReturnValue(
            new Promise((resolve) => {
                landConnection = resolve;
            }) as never,
        );
        const cm = makeManager();

        const connecting = cm.connect();
        const closing = cm.close();
        landConnection(model);
        await Promise.all([connecting, closing]);

        expect(model.close).toHaveBeenCalledOnce();
        expect(cm.state()).toBe('CLOSED');
    });

    it('arms no NEW retry timer when the in-flight attempt fails after the close', async () => {
        // The nastier half of the in-flight race, and the one that shipped
        // broken: close() can only cancel a retry sleep that already exists.
        // Land it while the attempt is still inside amqplib, let that attempt
        // fail, and the catch block would arm a fresh 30s timer — holding the
        // event loop open AND leaving close() itself pending behind
        // `await inFlight` for the whole backoff.
        vi.useFakeTimers();
        let failAttempt!: (error: Error) => void;
        vi.mocked(mockConnect).mockReturnValue(
            new Promise((_resolve, reject) => {
                failAttempt = reject;
            }) as never,
        );
        const cm = makeManager({ maxRetries: 10, initialDelay: 30_000 });

        const connecting = cm.connect();
        const closing = cm.close();
        let closed = false;
        void closing.then(() => {
            closed = true;
        });
        failAttempt(new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(0);
        expect(closed).toBe(true);
        await Promise.all([connecting, closing]);
        expect(cm.state()).toBe('CLOSED');
    });

    it('leaves no pending retry timer behind', async () => {
        // A close during the backoff sleep is the case that bites: the socket
        // is gone, nothing reconnects, and the process still refuses to exit
        // because a bare setTimeout is counting down to the next attempt.
        vi.useFakeTimers();
        vi.mocked(mockConnect).mockRejectedValue(new Error('ECONNREFUSED'));
        const cm = makeManager({ maxRetries: 10, initialDelay: 30_000 });

        const connecting = cm.connect();
        // Let the first attempt fail and park in the backoff sleep.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);

        await cm.close();
        await connecting;

        expect(vi.getTimerCount()).toBe(0);
        expect(cm.state()).toBe('CLOSED');
    });

    it('stops the retry loop rather than opening a connection nobody wants', async () => {
        vi.useFakeTimers();
        vi.mocked(mockConnect).mockRejectedValue(new Error('ECONNREFUSED'));
        const cm = makeManager({ maxRetries: 10, initialDelay: 30_000 });

        const connecting = cm.connect();
        await vi.advanceTimersByTimeAsync(0);
        const attemptsBeforeClose = vi.mocked(mockConnect).mock.calls.length;

        await cm.close();
        await connecting;
        await vi.advanceTimersByTimeAsync(120_000);

        expect(vi.mocked(mockConnect).mock.calls.length).toBe(attemptsBeforeClose);
    });
});

describe('ConnectionManager after close', () => {
    it('refuses to reconnect — connect() throws instead of reviving', async () => {
        const model = fakeChannelModel();
        vi.mocked(mockConnect).mockResolvedValue(model as never);
        const cm = makeManager();
        await cm.connect();
        await cm.close();

        // A typed error, not a message to regex: a service's recovery loop has
        // to tell "shutting down, stop" apart from "broker is down, retry", and
        // retrying a closed manager forever is the same hang in a new place.
        await expect(cm.connect()).rejects.toThrow(ConnectionManagerClosedError);
        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(cm.state()).toBe('CLOSED');
    });

    it('ensureConnected() surfaces the same refusal', async () => {
        const cm = makeManager();
        await cm.close();

        await expect(cm.ensureConnected()).rejects.toThrow(ConnectionManagerClosedError);
        expect(mockConnect).not.toHaveBeenCalled();
    });
});
