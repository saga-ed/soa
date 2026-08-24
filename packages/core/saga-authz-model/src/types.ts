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
    // Delegation spine — persona capabilities cascade group -> program and
    // feed session `edit_grant`/`observe_grant`.
    'persona',
    'pgrant',
    // Resources
    'school',
    'cohort',
    'program',
    'enrollment',
    'pod',
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
    group:
        | 'parent'
        | 'member'
        | 'admin'
        | 'pgrant'
        | 'edit_non_hosted'
        | 'observe';
    role: 'parent' | 'holder';
    persona: 'grants_edit_non_hosted' | 'grants_observe';
    pgrant: 'subject' | 'persona' | 'edit_non_hosted' | 'observe';
    school: 'parent' | 'admin' | 'editor' | 'viewer';
    cohort: 'parent' | 'admin' | 'editor' | 'viewer';
    program:
        | 'parent'
        | 'owner'
        | 'admin'
        | 'editor'
        | 'viewer'
        | 'grant_group'
        | 'edit_non_hosted'
        | 'observe';
    enrollment: 'parent' | 'program' | 'student' | 'tutor' | 'viewer';
    pod: 'parent' | 'tutor' | 'can_create_session';
    session:
        | 'parent'
        | 'pod'
        | 'host'
        | 'participant'
        | 'observer'
        | 'edit_grant'
        | 'observe_grant'
        | 'can_edit'
        | 'can_observe'
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
        | 'can_set_temporary_password'
        | 'can_create_org'
        | 'can_admin_personas'
        | 'can_manage_staff'
        | 'can_view_district_programs'
        | 'can_view_user_pii';
    staff_org:
        | 'platform'
        | 'staff_admin'
        | 'can_view'
        | 'can_edit'
        | 'can_delete'
        | 'can_configure_district'
        | 'can_force_oneroster_ingest'
        | 'can_force_clever_sync';
}

export type FgaRelation<T extends FgaType> = FgaRelationsByType[T];

/**
 * Runtime mirror of {@link FgaRelationsByType}. `FgaRelationsByType` is a
 * type-only interface, so nothing can compare it against model.fga at run
 * time — this constant is what the CI drift test diffs against the DSL.
 *
 * The `satisfies` clause below ties the two together: if you add a relation
 * here that is not in the interface (or use the wrong type name), the build
 * fails. If you add one to model.fga but not here, the drift test fails.
 * Keep all three in lockstep.
 */
export const FGA_RELATIONS = {
    tenant: ['admin', 'member', 'support'],
    user: [],
    group: ['parent', 'member', 'admin', 'pgrant', 'edit_non_hosted', 'observe'],
    role: ['parent', 'holder'],
    persona: ['grants_edit_non_hosted', 'grants_observe'],
    pgrant: ['subject', 'persona', 'edit_non_hosted', 'observe'],
    school: ['parent', 'admin', 'editor', 'viewer'],
    cohort: ['parent', 'admin', 'editor', 'viewer'],
    program: [
        'parent',
        'owner',
        'admin',
        'editor',
        'viewer',
        'grant_group',
        'edit_non_hosted',
        'observe',
    ],
    enrollment: ['parent', 'program', 'student', 'tutor', 'viewer'],
    pod: ['parent', 'tutor', 'can_create_session'],
    session: [
        'parent',
        'pod',
        'host',
        'participant',
        'observer',
        'edit_grant',
        'observe_grant',
        'can_edit',
        'can_observe',
        'viewer',
        'can_join',
    ],
    room: ['parent', 'session', 'member', 'moderator', 'can_join'],
    whiteboard: ['parent', 'editor', 'viewer'],
    saga_platform: [
        'super_admin',
        'support',
        'org_admin',
        'can_impersonate',
        'can_set_temporary_password',
        'can_create_org',
        'can_admin_personas',
        'can_manage_staff',
        'can_view_district_programs',
        'can_view_user_pii',
    ],
    staff_org: [
        'platform',
        'staff_admin',
        'can_view',
        'can_edit',
        'can_delete',
        'can_force_clever_sync',
        'can_configure_district',
        'can_force_oneroster_ingest',
    ],
} as const satisfies {
    [T in FgaType]: readonly FgaRelationsByType[T][];
};
