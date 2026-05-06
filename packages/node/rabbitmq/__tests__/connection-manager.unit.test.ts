// Unit tests for ConnectionManager.newConfirmChannel.
//
// Mocks the underlying ChannelModel (returned by amqplib's connect()) so we
// can verify the manager delegates to createConfirmChannel() and surfaces
// the same not-initialized error contract as newChannel().

import { describe, expect, it, vi } from 'vitest';
import type { ChannelModel } from 'amqplib';
import { ConnectionManager } from '../src/connection-manager.js';

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
