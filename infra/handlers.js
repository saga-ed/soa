import {
    snapshot, switch_profile, reset, restore,
    list_profiles, get_active_profile, delete_profile_data,
} from './api.js';

/**
 * Snapshot current database state to profile files.
 * @param {{ profile: string, services?: string[], output_dir?: string, force?: boolean }} input
 */
export async function handle_snapshot(input) {
    const { profile, services = ['mongo', 'mysql'], output_dir, force = false } = input;
    if (!profile) return { ok: false, error: 'profile is required' };

    const result = await snapshot({ profile, services, output_dir, force });
    return result.status === 0
        ? { ok: true, profile, snapshot_at: new Date().toISOString() }
        : { ok: false, error: `snapshot failed (exit ${result.status})` };
}

/**
 * Switch to a different database profile (down + up with new volumes).
 * @param {{ profile: string }} input
 */
export function handle_switch(input) {
    const { profile } = input;
    if (!profile) return { ok: false, error: 'profile is required' };

    const result = switch_profile({ profile });
    return result.status === 0
        ? { ok: true, profile }
        : { ok: false, error: `switch failed (exit ${result.status})` };
}

/**
 * Reset a profile (wipe volumes + restart with fresh seed).
 * @param {{ profile: string }} input
 */
export function handle_reset(input) {
    const { profile } = input;
    if (!profile) return { ok: false, error: 'profile is required' };

    const result = reset({ profile });
    return result.status === 0
        ? { ok: true, profile }
        : { ok: false, error: `reset failed (exit ${result.status})` };
}

/**
 * Restore a profile from snapshot files (reset + re-seed from dumps).
 * @param {{ profile: string }} input
 */
export function handle_restore(input) {
    const { profile } = input;
    if (!profile) return { ok: false, error: 'profile is required' };

    const result = restore({ profile });
    return result.status === 0
        ? { ok: true, profile }
        : { ok: false, error: `restore failed (exit ${result.status})` };
}

/**
 * List available profiles from built-in seeds and user snapshots.
 * @param {{ data_dir?: string }} [input]
 */
export function handle_list_profiles(input = {}) {
    const { data_dir } = input;
    const result = list_profiles(data_dir ? { data_dir } : {});
    const active = get_active_profile();
    return { ok: true, ...result, active };
}

/**
 * Delete snapshot files for a profile (does NOT remove Docker volumes).
 * @param {{ profile: string, data_dir?: string }} input
 */
export function handle_delete_profile(input) {
    const { profile, data_dir } = input;
    if (!profile) return { ok: false, error: 'profile is required' };

    const result = delete_profile_data({ profile, ...(data_dir ? { data_dir } : {}) });
    return { ok: true, ...result };
}

/**
 * Get the currently active profile.
 */
export function handle_get_active() {
    const active = get_active_profile();
    return { ok: true, active };
}
