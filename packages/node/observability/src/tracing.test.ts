import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveContainerIdAttribute } from './tracing.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('resolveContainerIdAttribute', () => {
    it('returns {} when ECS_CONTAINER_METADATA_URI_V4 is unset (local dev, tests, non-ECS)', async () => {
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', '');

        await expect(resolveContainerIdAttribute()).resolves.toEqual({});
    });

    it('sets container.id from the metadata endpoint DockerId', async () => {
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                json: () => Promise.resolve({ DockerId: 'real-app-container-id' }),
            }),
        );

        await expect(resolveContainerIdAttribute()).resolves.toEqual({
            'container.id': 'real-app-container-id',
        });
    });

    it('degrades to {} after exhausting every retry when the metadata fetch keeps failing', async () => {
        vi.useFakeTimers();
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        const fetchMock = vi.fn().mockRejectedValue(new Error('timeout'));
        vi.stubGlobal('fetch', fetchMock);

        const result = resolveContainerIdAttribute();
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(5);
        vi.useRealTimers();
    });

    it('degrades to {} when the response has no DockerId (no retry — not a fetch failure)', async () => {
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchMock);

        await expect(resolveContainerIdAttribute()).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries past an early metadata-proxy-not-yet-routable failure and succeeds', async () => {
        vi.useFakeTimers();
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
            .mockResolvedValueOnce({
                json: () => Promise.resolve({ DockerId: 'real-app-container-id' }),
            });
        vi.stubGlobal('fetch', fetchMock);

        const result = resolveContainerIdAttribute();
        await vi.runAllTimersAsync();

        await expect(result).resolves.toEqual({ 'container.id': 'real-app-container-id' });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
    });
});
