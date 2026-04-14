import {
    snapshot, switch_profile, reset, restore,
    list_profiles, get_active_profile, delete_profile_data,
} from './api.js';

const VALID_PROFILE = /^[a-zA-Z0-9_-]+$/;

function require_profile(input) {
    if (!input?.profile) return { ok: false, error: 'profile is required' };
    if (!VALID_PROFILE.test(input.profile)) return { ok: false, error: 'invalid profile name: must be alphanumeric, hyphens, or underscores only' };
    return null;
}

/**
 * Snapshot current database state to profile files.
 * @param {{ profile: string, services?: string[], output_dir?: string, force?: boolean }} input
 */
export async function handle_snapshot(input) {
    const err = require_profile(input);
    if (err) return err;

    const { profile, services = ['mongo', 'mysql', 'postgres'], output_dir, force = false } = input;
    const result = await snapshot({ profile, services, output_dir, force });
    return result.status === 0
        ? { ok: true, profile, snapshot_at: new Date().toISOString() }
        : { ok: false, error: `snapshot failed (exit ${result.status})` };
}

/**
 * Switch to a different database profile (down + up with new volumes).
 * @param {{ profile: string }} input
 */
export async function handle_switch(input) {
    const err = require_profile(input);
    if (err) return err;

    const result = await switch_profile({ profile: input.profile, seed_dir: input.seed_dir, data_dir: input.data_dir, compose_file: input.compose_file });
    return result.status === 0
        ? { ok: true, profile: input.profile }
        : { ok: false, error: `switch failed (exit ${result.status})` };
}

/**
 * Reset a profile (wipe volumes + restart with fresh seed).
 * @param {{ profile: string, seed_dir?: string, data_dir?: string }} input
 */
export async function handle_reset(input) {
    const err = require_profile(input);
    if (err) return err;

    const result = await reset({ profile: input.profile, seed_dir: input.seed_dir, data_dir: input.data_dir, compose_file: input.compose_file });
    return result.status === 0
        ? { ok: true, profile: input.profile }
        : { ok: false, error: `reset failed (exit ${result.status})` };
}

/**
 * Restore a profile from snapshot files (reset + re-seed from dumps).
 * @param {{ profile: string, seed_dir?: string, data_dir?: string }} input
 */
export async function handle_restore(input) {
    const err = require_profile(input);
    if (err) return err;

    const result = await restore({ profile: input.profile, seed_dir: input.seed_dir, data_dir: input.data_dir, compose_file: input.compose_file });
    return result.status === 0
        ? { ok: true, profile: input.profile }
        : { ok: false, error: `restore failed (exit ${result.status})` };
}

/**
 * List available profiles from built-in seeds and user snapshots.
 * @param {{ data_dir?: string }} [input]
 */
export function handle_list_profiles(input = {}) {
    const result = list_profiles({ data_dir: input.data_dir });
    const active = get_active_profile();
    return { ok: true, ...result, active };
}

/**
 * Delete snapshot files for a profile (does NOT remove Docker volumes).
 * @param {{ profile: string, data_dir?: string }} input
 */
export function handle_delete_profile(input) {
    const err = require_profile(input);
    if (err) return err;

    const result = delete_profile_data({ profile: input.profile, data_dir: input.data_dir });
    return { ok: true, ...result };
}

/**
 * Get the currently active profile.
 */
export function handle_get_active() {
    const active = get_active_profile();
    return { ok: true, active };
}
