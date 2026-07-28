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
    it.each([
        'edit_non_hosted',
        'observe',
        'view_non_member',
        'lifecycle_non_hosted',
    ] as const)(
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
        // group's capability relations must resolve ONLY through pgrant —
        // every tupleset they traverse must be the `pgrant` edge.
        for (const rel of [
            'edit_non_hosted',
            'observe',
            'view_non_member',
            'lifecycle_non_hosted',
        ] as const) {
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
 * View / lifecycle capabilities. Same delegation spine as edit/observe —
 * persona -> pgrant -> group -> program(grant_group) -> session — mirroring
 * sessions-api's 'sessions:view_non_member_sessions' (see-all reads) and
 * 'sessions:lifecycle_non_hosted_sessions' (start/end/cancel takeover).
 */
describe('view / lifecycle capability spine', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );

    it.each([
        ['view_grant', 'view_non_member', 'grants_view_non_member'],
        [
            'lifecycle_grant',
            'lifecycle_non_hosted',
            'grants_lifecycle_non_hosted',
        ],
    ] as const)(
        'routes session.%s through the program grant-group spine',
        (grantRel, capRel, personaRel) => {
            // Grants are group-scoped persona capabilities; a direct [user]
            // grant here would bypass persona revocation.
            expect(
                JSON.stringify(byType.session.relations[grantRel]),
            ).toContain(capRel);
            expect(
                JSON.stringify(byType.program.relations[capRel]),
            ).toContain('grant_group');
            expect(
                JSON.stringify(byType.pgrant.relations[capRel]),
            ).toContain(personaRel);
        },
    );

    it('gates can_view on host OR participant OR member OR view_grant', () => {
        const arms = (
            JSON.stringify(byType.session.relations.can_view).match(
                /"relation":"([^"]+)"/g,
            ) ?? []
        ).sort();
        expect(arms).toEqual([
            '"relation":"host"',
            '"relation":"member"',
            '"relation":"participant"',
            '"relation":"view_grant"',
        ]);
    });

    it('session.member is the pod-derived roster (ingest-fed source)', () => {
        // programs.pod_membership.* -> pod.member -> session.member. The
        // legacy `participant` relation stays direct-assignment and separate.
        const def = byType.session.relations.member;
        expect(def.tupleToUserset?.tupleset?.relation).toBe('pod');
        expect(def.tupleToUserset?.computedUserset?.relation).toBe('member');
    });

    it('gates can_lifecycle on host OR lifecycle_grant', () => {
        const arms = (
            JSON.stringify(byType.session.relations.can_lifecycle).match(
                /"relation":"([^"]+)"/g,
            ) ?? []
        ).sort();
        expect(arms).toEqual([
            '"relation":"host"',
            '"relation":"lifecycle_grant"',
        ]);
    });

    it('keeps host and lifecycle_grant SEPARABLE (D19 attribution)', () => {
        // Lifecycle takeover must attribute HOST vs ADMIN just like edit —
        // checkDetailed(['host','lifecycle_grant']). Same rule as edit_grant.
        // NB: relation-NAME matching, never substrings ("lifecycle_non_hosted"
        // contains "host").
        expect(JSON.stringify(byType.session.relations.host)).not.toContain(
            'lifecycle_grant',
        );
        const grantRefs = JSON.stringify(
            byType.session.relations.lifecycle_grant,
        ).match(/"relation":"([^"]+)"/g);
        expect(grantRefs).not.toContain('"relation":"host"');
    });

    it.each(['view_grant', 'lifecycle_grant'] as const)(
        'leaves session.%s OUTSIDE the pod path (ABSENT still admits grants)',
        (rel) => {
            expect(
                JSON.stringify(byType.session.relations[rel]),
            ).not.toContain('pod');
        },
    );

    it.each(['viewer', 'can_join'] as const)(
        'leaves legacy session.%s untouched by the new grants (additive change)',
        (rel) => {
            const serialized = JSON.stringify(byType.session.relations[rel]);
            expect(serialized).not.toContain('view_grant');
            expect(serialized).not.toContain('lifecycle_grant');
        },
    );
});

/**
 * The occurrence layer. A `session_instance` is a dated occurrence of a
 * repeating session; it exists (and carries tuples) only when per-day facts
 * were authored — a pod-swap override, an occurrence host, or a participant
 * delta. The invariants here mirror program-hub's host-resolution semantics
 * (pod_assignment_override SWAP/ABSENT + additive session_instance_override)
 * and were exercised against a real store in rostering's runnable prototype
 * (scripts/fga/prototype/session-instance-slice.fga.yaml, rostering#883).
 */
describe('session occurrence layer (session_instance)', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );
    const instance = byType.session_instance;

    it('declares the instance with its session edge and authored facts', () => {
        expect(instance).toBeDefined();
        for (const rel of [
            'session',
            'override_pod',
            'override_host',
            'added_participant',
            'pod_overridden',
        ]) {
            expect(instance.relations).toHaveProperty(rel);
        }
    });

    it('types pod_overridden as the [user:*] public wildcard marker', () => {
        const restrictions =
            instance.metadata?.relations?.pod_overridden
                ?.directly_related_user_types ?? [];
        expect(
            restrictions.some(
                (r) => r.type === 'user' && r.wildcard !== undefined,
            ),
        ).toBe(true);
    });

    /**
     * Override REPLACES — the marker is what removes the base arm. Assert
     * the STRUCTURE: `base_host` must be a difference whose base resolves
     * `host` through the `session` edge and whose subtrahend is the
     * `pod_overridden` marker. A well-meaning rewrite to a plain union
     * (`host from session or tutor from override_pod`) would silently turn
     * every SWAP day into base-pod ∪ swapped-pod — the exact wrong-pod
     * footgun the session-level comment warns about.
     */
    it.each([
        ['base_host', 'host'],
        ['base_member', 'member'],
    ] as const)(
        '%s subtracts the pod_overridden marker from the session\'s %s',
        (baseRel, sessionRel) => {
            const def = instance.relations[baseRel];
            expect(def).toHaveProperty('difference');
            expect(def).not.toHaveProperty('union');
            expect(
                def.difference?.base?.tupleToUserset?.tupleset?.relation,
            ).toBe('session');
            expect(
                def.difference?.base?.tupleToUserset?.computedUserset
                    ?.relation,
            ).toBe(sessionRel);
            expect(
                def.difference?.subtract?.computedUserset?.relation,
            ).toBe('pod_overridden');
        },
    );

    it('resolves host as override_host or override_pod tutor or base_host', () => {
        const children = instance.relations.host?.union?.child ?? [];
        expect(
            children.some(
                (c) => c.computedUserset?.relation === 'override_host',
            ),
        ).toBe(true);
        expect(
            children.some(
                (c) =>
                    c.tupleToUserset?.tupleset?.relation === 'override_pod' &&
                    c.tupleToUserset?.computedUserset?.relation === 'tutor',
            ),
        ).toBe(true);
        expect(
            children.some((c) => c.computedUserset?.relation === 'base_host'),
        ).toBe(true);
        // The base pod must ONLY be reachable through base_host (which the
        // marker suppresses) — never via a direct `host from session` arm.
        expect(
            children.some(
                (c) => c.tupleToUserset?.tupleset?.relation === 'session',
            ),
        ).toBe(false);
    });

    it('resolves member with the same override/delta mechanics', () => {
        const children = instance.relations.member?.union?.child ?? [];
        expect(
            children.some(
                (c) => c.computedUserset?.relation === 'added_participant',
            ),
        ).toBe(true);
        expect(
            children.some(
                (c) =>
                    c.tupleToUserset?.tupleset?.relation === 'override_pod' &&
                    c.tupleToUserset?.computedUserset?.relation === 'member',
            ),
        ).toBe(true);
        expect(
            children.some(
                (c) => c.computedUserset?.relation === 'base_member',
            ),
        ).toBe(true);
        expect(
            children.some(
                (c) => c.tupleToUserset?.tupleset?.relation === 'session',
            ),
        ).toBe(false);
    });

    it.each([
        'edit_grant',
        'observe_grant',
        'view_grant',
        'lifecycle_grant',
    ] as const)(
        'passes %s through the session edge ONLY (override day still admits grants)',
        (rel) => {
            // Grants never route through override_pod, so a SWAP (or ABSENT)
            // day cannot suppress a grant holder — the instance-level twin of
            // the session-level "ABSENT still admits grants" rule.
            const serialized = JSON.stringify(instance.relations[rel]);
            const tuplesets = [
                ...serialized.matchAll(/"tupleset":\{"relation":"([^"]+)"\}/g),
            ].map((m) => m[1]);
            expect(tuplesets.length).toBeGreaterThan(0);
            expect([...new Set(tuplesets)]).toEqual(['session']);
        },
    );

    /**
     * D19 separability, instance level. The gates mirror the session's arm
     * structure exactly, and the relationship/delegation branches stay
     * separable so checkDetailed can attribute HOST vs ADMIN on a dated
     * occurrence too. NB: relation-NAME matching, never substrings.
     */
    it.each([
        ['can_edit', ['host', 'edit_grant']],
        ['can_observe', ['host', 'observe_grant']],
        ['can_view', ['host', 'member', 'view_grant']],
        ['can_lifecycle', ['host', 'lifecycle_grant']],
    ] as const)(
        'gates %s on exactly the separable arms %j',
        (gate, expected) => {
            const arms = (
                JSON.stringify(instance.relations[gate]).match(
                    /"relation":"([^"]+)"/g,
                ) ?? []
            ).sort();
            expect(arms).toEqual(
                [...expected].sort().map((r) => `"relation":"${r}"`),
            );
        },
    );

    it('keeps host clear of every grant arm', () => {
        const hostRefs = JSON.stringify(instance.relations.host).match(
            /"relation":"([^"]+)"/g,
        );
        for (const grant of [
            'edit_grant',
            'observe_grant',
            'view_grant',
            'lifecycle_grant',
        ]) {
            expect(hostRefs).not.toContain(`"relation":"${grant}"`);
        }
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
            ]),
        );
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

describe('review-driven guards (2026-07-28)', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );
    const instance = byType.session_instance;

    it('session_instance.can_join follows the v1 vocabulary (host OR member OR observe_grant)', () => {
        const arms = (
            JSON.stringify(instance.relations.can_join).match(
                /"relation":"([^"]+)"/g,
            ) ?? []
        ).sort();
        expect(arms).toEqual([
            '"relation":"host"',
            '"relation":"member"',
            '"relation":"observe_grant"',
        ]);
    });

    // D19 separability extended to ALL four grants at both levels: no can_*
    // gate may inline pgrant/persona machinery — the grant arm must stay a
    // named *_grant relation so checkDetailed can attribute HOST vs ADMIN.
    it.each([
        ['session', 'can_view', 'view_grant'],
        ['session', 'can_lifecycle', 'lifecycle_grant'],
        ['session_instance', 'can_view', 'view_grant'],
        ['session_instance', 'can_lifecycle', 'lifecycle_grant'],
        ['session_instance', 'can_join', 'observe_grant'],
    ] as const)(
        '%s.%s keeps its grant arm as the named %s relation',
        (typeName, gate, grantRel) => {
            const text = JSON.stringify(byType[typeName].relations[gate]);
            expect(text).toContain(`"relation":"${grantRel}"`);
            expect(text).not.toContain('pgrant');
            expect(text).not.toContain('grants_');
        },
    );
});
