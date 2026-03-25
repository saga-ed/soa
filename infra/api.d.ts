import { SpawnSyncReturns } from 'child_process';

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

// ── Docker lifecycle ───────────────────────────────────────

export function up(options?: UpOptions): Promise<{ exitCode: number }>;
export function switch_profile(options: ProfileOptions): SpawnSyncReturns<Buffer>;
export function reset(options: ProfileOptions): SpawnSyncReturns<Buffer>;
export function restore(options: ProfileOptions): SpawnSyncReturns<Buffer>;

// ── Data operations (native JS) ───────────────────────────

/** Snapshot current DB state to profile files using mongodb driver + mysql2. */
export function snapshot(options: SnapshotOptions): Promise<{ status: number }>;

/** Backward-compat alias for snapshot(). */
export const dump: typeof snapshot;

/** List profiles from built-in seeds + user data directory. */
export function list_profiles(options?: ListProfilesOptions): { profiles: Profile[] };
