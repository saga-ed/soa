// ── Types ──────────────────────────────────────────────────

export interface UpOptions {
    profile?: string;
    /** Directory containing project-specific seed files (mounted as /extra-seed/). */
    seed_dir?: string;
    /** Directory for user snapshot data (default: ~/.fixtures/profiles). */
    data_dir?: string;
}

export interface SnapshotOptions {
    profile: string;
    services?: string[];
    /** Output directory (default: ~/.fixtures/profiles). */
    output_dir?: string;
    force?: boolean;
}

export interface ProfileOptions {
    profile: string;
    /** Directory containing project-specific seed files (mounted as /extra-seed/). */
    seed_dir?: string;
    /** Directory for user snapshot data (default: ~/.fixtures/profiles). */
    data_dir?: string;
}

export interface ListProfilesOptions {
    /** Data directory to scan for user snapshots (default: ~/.fixtures/profiles). */
    data_dir?: string;
}

export interface Profile {
    name: string;
    type: 'seed' | 'snapshot';
    service: string;
}

export interface ProfileResult {
    status: number;
    profile: string;
}

// ── Docker lifecycle ───────────────────────────────────────

export function up(options?: UpOptions): Promise<{ exitCode: number }>;

/** Switch to a different database profile (down + up with new volumes). */
export function switch_profile(options: ProfileOptions): ProfileResult;

/** Reset a profile: stop services, wipe profile volumes, restart fresh. */
export function reset(options: ProfileOptions): ProfileResult;

/** Restore a profile from seed/snapshot files. Wipes existing volumes if present. */
export function restore(options: ProfileOptions): ProfileResult;

// ── Data operations (native JS) ───────────────────────────

/** Snapshot current DB state to profile files using mongodb driver + mysql2. */
export function snapshot(options: SnapshotOptions): Promise<{ status: number }>;

/** Backward-compat alias for snapshot(). */
export const dump: typeof snapshot;

/** List profiles from built-in seeds + user data directory. */
export function list_profiles(options?: ListProfilesOptions): { profiles: Profile[] };

export interface ActiveProfile {
    profile: string;
    switched_at: string | null;
}

/** Get the currently active profile (written by switch/up/reset). */
export function get_active_profile(): ActiveProfile | null;

/** Delete snapshot files for a profile. Does NOT remove Docker volumes. */
export function delete_profile_data(options: { profile: string; data_dir?: string }): { deleted: number; profile: string };
