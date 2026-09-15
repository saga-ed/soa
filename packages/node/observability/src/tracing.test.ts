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

    it('degrades to {} when the metadata fetch fails', async () => {
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

        await expect(resolveContainerIdAttribute()).resolves.toEqual({});
    });

    it('degrades to {} when the response has no DockerId', async () => {
        vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }),
        );

        await expect(resolveContainerIdAttribute()).resolves.toEqual({});
    });
});
