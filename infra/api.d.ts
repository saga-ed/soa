import { SpawnSyncReturns } from 'child_process';

export interface UpOptions {
    profile?: string;
    /** Directory containing project-specific seed files. Mounted as /extra-seed/ in init containers. Project seeds take priority over built-in seeds. */
    seed_dir?: string;
}
export function up(options?: UpOptions): Promise<{ exitCode: number }>;

export interface DumpOptions {
    profile: string;
    services?: string[];
    output_dir?: string;
    force?: boolean;
}
export interface RestoreOptions {
    profile: string;
}

export function dump(options: DumpOptions): SpawnSyncReturns<Buffer>;
export function restore(options: RestoreOptions): SpawnSyncReturns<Buffer>;

export interface SwitchProfileOptions { profile: string; }
export function switch_profile(options: SwitchProfileOptions): SpawnSyncReturns<Buffer>;

export function list_profiles(): { exitCode: number; output: string };

export interface ResetOptions { profile: string; }
export function reset(options: ResetOptions): SpawnSyncReturns<Buffer>;
