import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the entire api.js module so handlers call our fakes
vi.mock('../api.js', () => ({
    snapshot: vi.fn(),
    switch_profile: vi.fn(),
    reset: vi.fn(),
    restore: vi.fn(),
    list_profiles: vi.fn(),
    get_active_profile: vi.fn(),
    delete_profile_data: vi.fn(),
}));

import {
    snapshot, switch_profile, reset, restore,
    list_profiles, get_active_profile, delete_profile_data,
} from '../api.js';

import {
    handle_snapshot, handle_switch, handle_reset, handle_restore,
    handle_list_profiles, handle_delete_profile, handle_get_active,
} from '../handlers.js';

beforeEach(() => {
    vi.clearAllMocks();
});

// ── handle_snapshot ─────────────────────────────────────────

describe('handle_snapshot', () => {
    it('returns ok:true with profile and timestamp on success', async () => {
        snapshot.mockResolvedValue({ status: 0 });

        const result = await handle_snapshot({ profile: 'test', services: ['mongo'] });
        expect(result.ok).toBe(true);
        expect(result.profile).toBe('test');
        expect(result.snapshot_at).toBeDefined();
        expect(snapshot).toHaveBeenCalledWith({
            profile: 'test', services: ['mongo'], output_dir: undefined, force: false,
        });
    });

    it('returns ok:false when snapshot fails', async () => {
        snapshot.mockResolvedValue({ status: 1 });

        const result = await handle_snapshot({ profile: 'bad' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('snapshot failed');
    });

    it('returns error when profile is missing', async () => {
        const result = await handle_snapshot({});
        expect(result.ok).toBe(false);
        expect(result.error).toBe('profile is required');
        expect(snapshot).not.toHaveBeenCalled();
    });

    it('defaults force to false and services to all three', async () => {
        snapshot.mockResolvedValue({ status: 0 });

        await handle_snapshot({ profile: 'x' });
        expect(snapshot).toHaveBeenCalledWith(
            expect.objectContaining({ force: false, services: ['mongo', 'mysql', 'postgres'] }),
        );
    });
});

// ── handle_switch ───────────────────────────────────────────

describe('handle_switch', () => {
    it('returns ok:true on success', async () => {
        switch_profile.mockResolvedValue({ status: 0, profile: 'p1' });

        const result = await handle_switch({ profile: 'p1' });
        expect(result.ok).toBe(true);
        expect(result.profile).toBe('p1');
    });

    it('returns ok:false on failure', async () => {
        switch_profile.mockResolvedValue({ status: 1, profile: 'p1' });

        const result = await handle_switch({ profile: 'p1' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('switch failed');
    });

    it('validates profile is required', async () => {
        const result = await handle_switch({});
        expect(result.ok).toBe(false);
        expect(result.error).toBe('profile is required');
        expect(switch_profile).not.toHaveBeenCalled();
    });

    it('rejects invalid profile names', async () => {
        const result = await handle_switch({ profile: '../../etc' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid profile name/);
        expect(switch_profile).not.toHaveBeenCalled();
    });
});

// ── handle_reset ────────────────────────────────────────────

describe('handle_reset', () => {
    it('returns ok:true on success', async () => {
        reset.mockResolvedValue({ status: 0, profile: 'r1' });

        const result = await handle_reset({ profile: 'r1' });
        expect(result.ok).toBe(true);
        expect(result.profile).toBe('r1');
    });

    it('returns ok:false on failure', async () => {
        reset.mockResolvedValue({ status: 1, profile: 'r1' });

        const result = await handle_reset({ profile: 'r1' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('reset failed');
    });

    it('validates profile is required', async () => {
        const result = await handle_reset({});
        expect(result.ok).toBe(false);
        expect(switch_profile).not.toHaveBeenCalled();
    });
});

// ── handle_restore ──────────────────────────────────────────

describe('handle_restore', () => {
    it('returns ok:true on success', async () => {
        restore.mockResolvedValue({ status: 0, profile: 'snap1' });

        const result = await handle_restore({ profile: 'snap1' });
        expect(result.ok).toBe(true);
        expect(result.profile).toBe('snap1');
    });

    it('returns ok:false on failure', async () => {
        restore.mockResolvedValue({ status: 1, profile: 'snap1' });

        const result = await handle_restore({ profile: 'snap1' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('restore failed');
    });

    it('validates profile is required', async () => {
        const result = await handle_restore({});
        expect(result.ok).toBe(false);
        expect(restore).not.toHaveBeenCalled();
    });
});

// ── handle_list_profiles ────────────────────────────────────

describe('handle_list_profiles', () => {
    it('returns ok:true with profiles and active profile', () => {
        list_profiles.mockReturnValue({ profiles: [{ name: 'p1', type: 'seed', service: 'mongo' }] });
        get_active_profile.mockReturnValue({ profile: 'p1', switched_at: '2026-01-01' });

        const result = handle_list_profiles();
        expect(result.ok).toBe(true);
        expect(result.profiles).toHaveLength(1);
        expect(result.active).toEqual({ profile: 'p1', switched_at: '2026-01-01' });
    });

    it('passes data_dir through to list_profiles', () => {
        list_profiles.mockReturnValue({ profiles: [] });
        get_active_profile.mockReturnValue(null);

        handle_list_profiles({ data_dir: '/custom/path' });
        expect(list_profiles).toHaveBeenCalledWith({ data_dir: '/custom/path' });
    });

    it('handles no active profile', () => {
        list_profiles.mockReturnValue({ profiles: [] });
        get_active_profile.mockReturnValue(null);

        const result = handle_list_profiles();
        expect(result.ok).toBe(true);
        expect(result.active).toBeNull();
    });
});

// ── handle_delete_profile ───────────────────────────────────

describe('handle_delete_profile', () => {
    it('returns ok:true with deleted count', () => {
        delete_profile_data.mockReturnValue({ deleted: 3, profile: 'old' });

        const result = handle_delete_profile({ profile: 'old' });
        expect(result.ok).toBe(true);
        expect(result.deleted).toBe(3);
        expect(result.profile).toBe('old');
    });

    it('returns ok:true even when nothing deleted', () => {
        delete_profile_data.mockReturnValue({ deleted: 0, profile: 'missing' });

        const result = handle_delete_profile({ profile: 'missing' });
        expect(result.ok).toBe(true);
        expect(result.deleted).toBe(0);
    });

    it('validates profile is required', () => {
        const result = handle_delete_profile({});
        expect(result.ok).toBe(false);
        expect(result.error).toBe('profile is required');
        expect(delete_profile_data).not.toHaveBeenCalled();
    });
});

// ── handle_get_active ───────────────────────────────────────

describe('handle_get_active', () => {
    it('returns active profile when set', () => {
        get_active_profile.mockReturnValue({ profile: 'current', switched_at: '2026-03-27' });

        const result = handle_get_active();
        expect(result.ok).toBe(true);
        expect(result.active).toEqual({ profile: 'current', switched_at: '2026-03-27' });
    });

    it('returns null active when no profile set', () => {
        get_active_profile.mockReturnValue(null);

        const result = handle_get_active();
        expect(result.ok).toBe(true);
        expect(result.active).toBeNull();
    });
});
