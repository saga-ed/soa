/**
 * Type literals derived from model.fga. These constants must stay in sync
 * with the DSL; a CI lint (added in P5/P6 follow-up) will diff the .fga
 * file against this file and fail the build on drift.
 */

export const FGA_TYPES = [
    // Identity
    'tenant',
    'user',
    'group',
    'role',
    // Resources
    'school',
    'cohort',
    'program',
    'enrollment',
    'session',
    'room',
    'whiteboard',
] as const;
export type FgaType = (typeof FGA_TYPES)[number];

/**
 * The canonical relations on each type. Used by tuple-key builders to refuse
 * unknown relation names at compile time.
 */
export interface FgaRelationsByType {
    tenant: 'admin' | 'member' | 'support';
    user: never;
    group: 'parent' | 'member' | 'admin';
    role: 'parent' | 'holder';
    school: 'parent' | 'admin' | 'editor' | 'viewer';
    cohort: 'parent' | 'admin' | 'editor' | 'viewer';
    program: 'parent' | 'owner' | 'admin' | 'editor' | 'viewer';
    enrollment: 'parent' | 'program' | 'student' | 'tutor' | 'viewer';
    session:
        | 'parent'
        | 'host'
        | 'participant'
        | 'observer'
        | 'viewer'
        | 'can_join';
    room: 'parent' | 'session' | 'member' | 'moderator' | 'can_join';
    whiteboard: 'parent' | 'editor' | 'viewer';
}

export type FgaRelation<T extends FgaType> = FgaRelationsByType[T];
