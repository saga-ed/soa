/**
 * Shared types for fixture-serve infrastructure.
 * These types define the contracts between the base controller
 * and service-specific subclass implementations.
 */

/** Options passed to a fixture creator function (TS or bash). */
export interface FixtureCreateOpts {
    fixture_id: string;
    mongo_host: string;
    mongo_port: number;
    sql_host: string;
    sql_port: number;
    force_adhoc: boolean;
}

/** Definition of a fixture type that a service supports. */
export interface FixtureTypeDefinition {
    /** Human-readable name shown in UI (e.g. "Small (5 users, 1 program)"). */
    name: string;
    /** Estimated creation time in seconds. */
    est_seconds: number;
    /** Native TS creator function. If omitted, falls back to bash script. */
    creator?: (opts: FixtureCreateOpts) => Promise<any>;
    /** Test capabilities this fixture type provides (e.g. ["org", "programs"]). */
    capabilities?: string[];
}

/** Maps domain roles (e.g. IAM roles) to test framework role names. */
export type RoleMapping = Record<string, string[]>;

/** Maps test suite names to the roles they require. */
export type SuiteRoles = Record<string, string[]>;

/** MongoDB document representing an async fixture creation job. */
export interface JobDocument {
    _id: string;
    status: 'running' | 'completed' | 'failed';
    fixture_type: string;
    fixture_id: string;
    started_at: Date;
    completed_at?: Date;
    result?: any;
    error_message?: string;
    output: string[];
}

/** Valid lifecycle states for a provision operation. */
export type ProvisionStatus = 'idle' | 'resetting' | 'creating' | 'switching' | 'verifying' | 'ready' | 'failed';

/** In-memory state for a provision lifecycle operation. */
export interface ProvisionState {
    status: ProvisionStatus;
    fixture_type: string;
    fixture_id: string;
    started_at: Date;
    completed_at: Date | null;
    error: string | null;
    user_count: number | null;
}
