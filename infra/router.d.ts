import { Router } from 'express';
import { ProfileResponse } from './handlers.js';

export interface InfraRouterOptions {
    /** Called after a successful switch_profile operation. */
    on_after_switch?: (result: ProfileResponse) => Promise<void> | void;
    /** Called after a successful reset operation. */
    on_after_reset?: (result: ProfileResponse) => Promise<void> | void;
    /** Called after a successful snapshot operation. */
    on_after_snapshot?: (result: { ok: true; profile: string; snapshot_at: string }) => Promise<void> | void;
}

/**
 * Create an Express Router exposing infra-compose operations over HTTP.
 *
 * Routes:
 *   POST /snapshot        - Snapshot current DB state
 *   POST /switch          - Switch to a different profile
 *   POST /reset           - Reset a profile (wipe + re-seed)
 *   POST /restore         - Restore from snapshot files
 *   GET  /profiles        - List available profiles
 *   POST /delete-profile  - Delete snapshot files for a profile
 *   GET  /active-profile  - Get currently active profile
 *   GET  /health          - Health check
 */
export function create_router(options?: InfraRouterOptions): Router;
