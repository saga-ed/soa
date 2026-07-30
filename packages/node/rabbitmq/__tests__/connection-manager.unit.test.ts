// Unit tests for ConnectionManager.newConfirmChannel.
//
// Mocks the underlying ChannelModel (returned by amqplib's connect()) so we
// can verify the manager delegates to createConfirmChannel() and surfaces
// the same not-initialized error contract as newChannel().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelModel } from 'amqplib';
import { ConnectionManager } from '../src/connection-manager.js';

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

function makeManager(channelModel: Partial<ChannelModel> | null) {
    const cm = new ConnectionManager(
        NOOP_LOGGER as never,
        { url: 'amqp://localhost' },
    );
    // Reach in and inject the channel model. Mirrors the post-connect state.
    (cm as unknown as { channelModel: Partial<ChannelModel> | null }).channelModel = channelModel;
    return cm;
}

describe('ConnectionManager.newChannel', () => {
    it('delegates to channelModel.createChannel', async () => {
        const fakeChannel = { id: 'plain' };
        const createChannel = vi.fn().mockResolvedValue(fakeChannel);
        const cm = makeManager({ createChannel } as Partial<ChannelModel>);
        const ch = await cm.newChannel();
        expect(createChannel).toHaveBeenCalledOnce();
        expect(ch).toBe(fakeChannel);
    });

    it('throws when called before connect() establishes channelModel', async () => {
        const cm = makeManager(null);
        await expect(cm.newChannel()).rejects.toThrow(/Channel model not initialized/);
    });
});

describe('ConnectionManager.newConfirmChannel', () => {
    it('delegates to channelModel.createConfirmChannel', async () => {
        const fakeConfirm = { id: 'confirm', waitForConfirms: vi.fn() };
        const createConfirmChannel = vi.fn().mockResolvedValue(fakeConfirm);
        const cm = makeManager({ createConfirmChannel } as Partial<ChannelModel>);
        const ch = await cm.newConfirmChannel();
        expect(createConfirmChannel).toHaveBeenCalledOnce();
        expect(ch).toBe(fakeConfirm);
    });

    it('throws when called before connect() establishes channelModel', async () => {
        const cm = makeManager(null);
        await expect(cm.newConfirmChannel()).rejects.toThrow(/Channel model not initialized/);
    });

    it('does not interfere with newChannel — both can be called on the same manager', async () => {
        const createChannel = vi.fn().mockResolvedValue({ kind: 'plain' });
        const createConfirmChannel = vi.fn().mockResolvedValue({ kind: 'confirm' });
        const cm = makeManager({ createChannel, createConfirmChannel } as Partial<ChannelModel>);
        const plain = await cm.newChannel();
        const confirm = await cm.newConfirmChannel();
        expect(plain).toEqual({ kind: 'plain' });
        expect(confirm).toEqual({ kind: 'confirm' });
        expect(createChannel).toHaveBeenCalledOnce();
        expect(createConfirmChannel).toHaveBeenCalledOnce();
    });
});

describe('ConnectionManager.connect — failureMode', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
        // Force `connect` to exhaust retries quickly: stub amqplib.connect so
        // it always rejects, and use a tiny `initialDelay` so the backoff
        // doesn't drag the test out.
        vi.mocked(mockConnect).mockRejectedValue(new Error('boom'));
    });

    afterEach(() => {
        vi.mocked(mockConnect).mockReset();
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    });

    function makeFailingManager(failureMode?: 'fatal' | 'log-and-continue') {
        return new ConnectionManager(NOOP_LOGGER as never, {
            url: 'amqp://localhost',
            failureMode,
            reconnect: { enabled: true, maxRetries: 1, initialDelay: 1, maxDelay: 1 },
        });
    }

    it('throws when failureMode=fatal after retries exhaust', async () => {
        const cm = makeFailingManager('fatal');
        await expect(cm.connect()).rejects.toThrow(/circuit breaker opened/);
        expect(cm.state()).toBe('CIRCUIT_OPEN');
    });

    it('LOGS THE ACTUAL CAUSE, not "{}"', async () => {
        // Regression guard for the real defect: the connect catch used
        // `JSON.stringify(error)`, which is "{}" for an Error (message/name/
        // stack are non-enumerable). Every failure logged
        // `Error connecting to RabbitMQ: {}` — auth rejection, DNS miss and TLS
        // failure were indistinguishable, which cost a prod debugging session.
        //
        // Asserted at the CALL SITE deliberately: a describeError() unit test
        // alone still passes if someone reverts this line, because nothing
        // would tie the helper to the logger.
        vi.mocked(mockConnect).mockRejectedValue(
            Object.assign(new Error('ACCESS_REFUSED - Login was refused'), { code: 403 }),
        );
        // NOOP_LOGGER is module-level and never reset, so earlier tests' calls
        // are still in .mock.calls — clear it or we assert on their 'boom'.
        vi.mocked(NOOP_LOGGER.error).mockClear();

        const cm = makeFailingManager('log-and-continue');
        await cm.connect();

        const logged = vi.mocked(NOOP_LOGGER.error).mock.calls.map(c => String(c[0]));
        const connectLine = logged.find(l => l.includes('Error connecting to RabbitMQ'));
        expect(connectLine).toBeDefined();
        expect(connectLine).toContain('ACCESS_REFUSED');
        expect(connectLine).toContain('code=403');
        expect(connectLine).not.toContain('{}');
    });

    it('returns + logs warn when failureMode=log-and-continue', async () => {
        const cm = makeFailingManager('log-and-continue');
        await expect(cm.connect()).resolves.toBeUndefined();
        expect(cm.state()).toBe('CIRCUIT_OPEN');
        expect(NOOP_LOGGER.warn).toHaveBeenCalledWith(
            expect.stringMatching(/log-and-continue/),
        );
    });

    it("defaults to 'fatal' when NODE_ENV=production", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        const cm = makeFailingManager();
        await expect(cm.connect()).rejects.toThrow(/circuit breaker opened/);
    });

    it("defaults to 'log-and-continue' when NODE_ENV is not production", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
        const cm = makeFailingManager();
        await expect(cm.connect()).resolves.toBeUndefined();
    });
});
