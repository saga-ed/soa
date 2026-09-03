import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformer } from '@openfga/syntax-transformer';
import { describe, expect, it } from 'vitest';
import { FGA_RELATIONS, FGA_TYPES } from '../types.js';

/**
 * Verify that every type declared in src/types.ts is present in model.fga.
 * Catches drift if someone edits one without the other.
 */
const modelText = readFileSync(
    resolve(__dirname, '../../model.fga'),
    'utf8',
);

describe('model.fga ↔ src/types.ts', () => {
    it.each(FGA_TYPES)(
        'declares %s in the .fga DSL',
        (type) => {
            expect(modelText).toMatch(new RegExp(`^type ${type}\\b`, 'm'));
        },
    );

    it('declares schema 1.1', () => {
        expect(modelText).toMatch(/^\s*schema 1\.1\b/m);
    });

    it('starts with the model keyword', () => {
        expect(modelText).toMatch(/^model$/m);
    });
});

/**
 * The regex checks above only prove the type names *appear* — they do not
 * prove the DSL is well-formed. The OpenFGA transformer is strict (it rejects
 * multi-line `or`/`and` continuations, for instance), so transforming the model
 * is the only thing that proves it would actually load into a store. This is
 * the test that bites on a malformed model.fga before it ships.
 */
describe('model.fga is a valid OpenFGA model', () => {
    it('transforms without throwing', () => {
        expect(() =>
            transformer.transformDSLToJSONObject(modelText),
        ).not.toThrow();
    });

    it('compiles to exactly the FGA_TYPES type set', () => {
        const json = transformer.transformDSLToJSONObject(modelText);
        expect(json.type_definitions).toHaveLength(FGA_TYPES.length);
        expect(json.type_definitions.map((t) => t.type).sort()).toEqual(
            [...FGA_TYPES].sort(),
        );
    });

    it('compiles to schema 1.1', () => {
        const json = transformer.transformDSLToJSONObject(modelText);
        expect(json.schema_version).toBe('1.1');
    });
});

/**
 * RELATION-level drift guard. The type-set check above only compares type
 * NAMES, so adding a relation to model.fga without updating src/types.ts used
 * to pass CI silently. This closes that gap: every type's relation set in the
 * DSL must equal FGA_RELATIONS exactly, in both directions.
 */
describe('model.fga ↔ FGA_RELATIONS (relation-level drift)', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );

    it.each(FGA_TYPES)('declares exactly the mirrored relations on %s', (type) => {
        const inDsl = Object.keys(byType[type]?.relations ?? {}).sort();
        const mirrored = [...FGA_RELATIONS[type]].sort();
        expect(inDsl).toEqual(mirrored);
    });
});

/**
 * Session/pod hosting invariants. These encode decisions that are expensive to
 * rediscover and easy to break with a well-meaning edit; each maps to a real
 * program-hub behaviour in apps/node/sessions-api.
 */
describe('session hosting model', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );

    it('resolves host through the pod (tutors attach at the pod level)', () => {
        // `tutoring_session` has no owner column; hosting resolves via the pod.
        expect(JSON.stringify(byType.session.relations.host)).toContain('pod');
        expect(byType.pod.relations).toHaveProperty('tutor');
    });

    it('keeps host and edit_grant SEPARABLE for D19 attribution', () => {
        // checkDetailed(['host','edit_grant']) attributes actor HOST vs ADMIN
        // (cancellationActor). Collapsing these into one relation destroys it.
        // Asserted in BOTH directions: folding either into the other is fatal.
        expect(byType.session.relations).toHaveProperty('host');
        expect(byType.session.relations).toHaveProperty('edit_grant');
        expect(JSON.stringify(byType.session.relations.host)).not.toContain(
            'edit_grant',
        );
        // NB: assert on relation NAMES, not a substring — `edit_non_hosted`
        // legitimately contains the substring "host".
        const grantRefs = JSON.stringify(
            byType.session.relations.edit_grant,
        ).match(/"relation":"([^"]+)"/g);
        expect(grantRefs).not.toContain('"relation":"host"');
    });

    it('gates ad-hoc create on the POD, not the session', () => {
        // An ad-hoc create has no session object yet, so the gate cannot live
        // on `session`. Mirrors sessions-api assertCanCreateAdhoc.
        expect(byType.pod.relations).toHaveProperty('can_create_session');
    });

    it('routes edit_grant through the program grant-group spine, not a direct grant', () => {
        // Grants are group-scoped persona capabilities; a direct [user] grant
        // here would bypass persona revocation.
        expect(JSON.stringify(byType.session.relations.edit_grant)).toContain(
            'edit_non_hosted',
        );
        expect(JSON.stringify(byType.program.relations.edit_non_hosted)).toContain(
            'grant_group',
        );
        expect(JSON.stringify(byType.pgrant.relations.edit_non_hosted)).toContain(
            'grants_edit_non_hosted',
        );
    });

    /**
     * SEC-CRIT: `persona.grants_*` is a [user:*] PUBLIC WILDCARD, so pgrant's
     * capability relations MUST be an intersection with `subject`. Flipping the
     * `and` to `or` is a one-character fleet-wide authorization bypass — every
     * user in the store would gain the capability, cascading pgrant -> group ->
     * program -> session.can_edit / pod.can_create_session.
     *
     * A substring assertion cannot catch this (`subject or grants_x from persona`
     * contains the same tokens), so assert the STRUCTURE.
     */
    it.each(['edit_non_hosted', 'observe'] as const)(
        'pgrant.%s is an INTERSECTION with subject, never a union',
        (rel) => {
            const def = byType.pgrant.relations[rel];
            expect(def).toHaveProperty('intersection');
            expect(def).not.toHaveProperty('union');

            const children = def.intersection?.child ?? [];
            // One side must be the `subject` computed userset — that is what
            // binds the [user:*] capability to THIS assignment's user.
            expect(
                children.some(
                    (c) => c.computedUserset?.relation === 'subject',
                ),
            ).toBe(true);
            // The other must resolve the grant through the persona object.
            expect(
                children.some(
                    (c) =>
                        c.tupleToUserset?.tupleset?.relation === 'persona' &&
                        c.tupleToUserset?.computedUserset?.relation ===
                            `grants_${rel}`,
                ),
            ).toBe(true);
        },
    );

    /**
     * The delegation spine must stay FLAT. program-hub resolves grant scope as
     * `programGrantGroupIds` (organizationId + schoolGroupIds) and a flat
     * `groupId IN (...)` test — explicitly "not a hierarchy crawl". A group->group
     * ancestor cascade here would grant edits that `callerHoldsGrant` denies.
     */
    it('has no group ancestor cascade on the capability relations', () => {
        const groupRels = byType.group.relations ?? {};
        expect(groupRels).not.toHaveProperty('parent_group');
        // group.edit_non_hosted/observe must resolve ONLY through pgrant —
        // every tupleset they traverse must be the `pgrant` edge.
        for (const rel of ['edit_non_hosted', 'observe'] as const) {
            const serialized = JSON.stringify(groupRels[rel]);
            expect(serialized).toContain('pgrant');
            const tuplesets = [
                ...serialized.matchAll(/"tupleset":\{"relation":"([^"]+)"\}/g),
            ].map((m) => m[1]);
            expect(tuplesets.length).toBeGreaterThan(0);
            expect([...new Set(tuplesets)]).toEqual(['pgrant']);
        }
    });

    it('leaves edit_grant OUTSIDE the pod path (ABSENT still admits grants)', () => {
        // An ABSENT effective pod admits no HOST, but a grant holder still
        // passes can_edit — matching sessions-api checking holdsGrant outside
        // its `if (effectivePod != null)` guard.
        expect(JSON.stringify(byType.session.relations.edit_grant)).not.toContain(
            'pod',
        );
    });
});

/**
 * SEC-CRIT-2: the staff control-plane is a DISTINCT namespace. `staff_org`
 * must NOT reuse the `admin` relation (that would overwrite tenant.admin and
 * feed the `admin from parent` cascades), and must NOT inherit admin from a
 * resource parent. These assertions fail CI if a future edit collapses the
 * staff namespace back into the resource tree.
 */
describe('staff control-plane namespace (SEC-CRIT-2)', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );

    it('declares the staff types', () => {
        expect(byType.saga_platform).toBeDefined();
        expect(byType.staff_org).toBeDefined();
    });

    it('saga_platform exposes the computed capabilities', () => {
        const rels = Object.keys(byType.saga_platform.relations ?? {});
        expect(rels).toEqual(
            expect.arrayContaining([
                'can_impersonate',
                'can_create_org',
                'can_admin_personas',
                'can_manage_staff',
                'can_view_district_programs',
                'can_view_user_pii',
                'can_observe_session_recordings',
            ]),
        );
    });

    it('can_view_user_pii resolves from super_admin only (rostering#1126)', () => {
        const rel = byType.saga_platform.relations?.can_view_user_pii;
        expect(rel?.computedUserset?.relation).toBe('super_admin');
    });

    it('can_view_district_programs resolves from org_admin, not super_admin alone', () => {
        const rel = byType.saga_platform.relations?.can_view_district_programs;
        expect(rel?.computedUserset?.relation).toBe('org_admin');
    });

    it('can_observe_session_recordings resolves from support (program-hub#760)', () => {
        const rel = byType.saga_platform.relations?.can_observe_session_recordings;
        expect(rel?.computedUserset?.relation).toBe('support');
    });

    it('staff_org uses staff_admin and NEVER admin (SEC-CRIT-2)', () => {
        const rels = Object.keys(byType.staff_org.relations ?? {});
        expect(rels).toContain('staff_admin');
        expect(rels).not.toContain('admin');
    });

    it('staff_org exposes can_force_clever_sync computed from staff_admin', () => {
        const rels = byType.staff_org.relations ?? {};
        expect(rels).toHaveProperty('can_force_clever_sync');
        // Must resolve THROUGH staff_admin (org_admin+ staff), not a direct
        // user grant — so it can never be handed to a district persona.
        expect(JSON.stringify(rels.can_force_clever_sync)).toContain('staff_admin');
    });

    it('staff_org has no `from parent` cascade into the resource tree', () => {
        // No relation on staff_org may resolve through a `parent` edge —
        // the only computed-userset source allowed is `platform`.
        const relations = byType.staff_org.relations ?? {};
        const serialized = JSON.stringify(relations);
        expect(serialized).not.toMatch(/"relation"\s*:\s*"parent"/);
        expect(byType.staff_org.relations).not.toHaveProperty('parent');
    });
});
