import { ActiveProfile, Profile } from './api.js';

// ── Input types ──────────────────────────────────────────────

export interface SnapshotInput {
    profile: string;
    services?: string[];
    output_dir?: string;
    force?: boolean;
}

export interface ProfileInput {
    profile: string;
}

export interface ListProfilesInput {
    data_dir?: string;
}

export interface DeleteProfileInput {
    profile: string;
    data_dir?: string;
}

// ── Response types ───────────────────────────────────────────

export interface OkResponse {
    ok: true;
}

export interface ErrorResponse {
    ok: false;
    error: string;
}

export interface SnapshotResponse extends OkResponse {
    profile: string;
    snapshot_at: string;
}

export interface ProfileResponse extends OkResponse {
    profile: string;
}

export interface ListProfilesResponse extends OkResponse {
    profiles: Profile[];
    active: ActiveProfile | null;
}

export interface DeleteProfileResponse extends OkResponse {
    deleted: number;
    profile: string;
}

export interface ActiveProfileResponse extends OkResponse {
    active: ActiveProfile | null;
}

// ── Handler functions ────────────────────────────────────────

export function handle_snapshot(input: SnapshotInput): Promise<SnapshotResponse | ErrorResponse>;
export function handle_switch(input: ProfileInput): ProfileResponse | ErrorResponse;
export function handle_reset(input: ProfileInput): ProfileResponse | ErrorResponse;
export function handle_restore(input: ProfileInput): ProfileResponse | ErrorResponse;
export function handle_list_profiles(input?: ListProfilesInput): ListProfilesResponse;
export function handle_delete_profile(input: DeleteProfileInput): DeleteProfileResponse | ErrorResponse;
export function handle_get_active(): ActiveProfileResponse;
