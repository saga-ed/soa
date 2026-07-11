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
    // Staff control-plane (namespace: staff) — distinct from the resource
    // tree; see model.fga's SEC-CRIT-2 note (staff_org is NOT tenant).
    'saga_platform',
    'staff_org',
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
    // Staff control-plane. `saga_platform` carries the role grants
    // (super_admin/support/org_admin) and the computed `can_*` capabilities
    // app code checks. `staff_org` is the per-org control object; its admin
    // relation is `staff_admin` (NEVER `admin` — SEC-CRIT-2).
    saga_platform:
        | 'super_admin'
        | 'support'
        | 'org_admin'
        | 'can_impersonate'
        | 'can_create_org'
        | 'can_admin_personas'
        | 'can_manage_staff';
    staff_org:
        | 'platform'
        | 'staff_admin'
        | 'can_view'
        | 'can_edit'
        | 'can_delete'
        | 'can_force_clever_sync';
}

export type FgaRelation<T extends FgaType> = FgaRelationsByType[T];
