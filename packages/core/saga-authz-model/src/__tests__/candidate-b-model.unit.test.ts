import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformer, validator } from '@openfga/syntax-transformer';
import { describe, expect, it } from 'vitest';

/**
 * Candidate B is a not-yet-adopted replacement model, staged under
 * `candidate-b/` (see candidate-b/README.md) so it can be validated in this
 * package's CI without touching the live `model.fga` / `src/types.ts`.
 *
 * This test proves the DSL is well-formed (the transformer is strict — it
 * rejects malformed relation syntax, multi-line `or`/`and` continuations,
 * etc.) and pins the type/relation counts so a syntax regression — or an
 * accidental edit to the vendored fixture — fails `pnpm test` immediately,
 * without needing the `fga` CLI locally. The CLI-based `fga model
 * validate`/`fga model test` round-trip against the fixtures runs in CI
 * separately (see .github/workflows for the authz-model-candidate-b job).
 */
const candidateBModelText = readFileSync(resolve(__dirname, '../../candidate-b/model.fga'), 'utf8');
const liveModelText = readFileSync(resolve(__dirname, '../../model.fga'), 'utf8');

/**
 * Directly-related-user-type entry as emitted in `metadata.relations[rel]
 * .directly_related_user_types` by the transformer — `{ type: 'user' }` for
 * `[user]`, `{ type: 'user', wildcard: {} }` for `[user:*]`, etc.
 */
type DirectlyRelatedUserType = {
  type: string;
  relation?: string;
  wildcard?: Record<string, never>;
};

/** A relation's userset rewrite tree, as emitted under `relations[rel]`. */
type UsersetNode = {
  this?: Record<string, never>;
  computedUserset?: { relation: string };
  tupleToUserset?: { tupleset: { relation: string }; computedUserset: { relation: string } };
  union?: { child: UsersetNode[] };
  intersection?: { child: UsersetNode[] };
  difference?: { base: UsersetNode; subtract: UsersetNode };
};

type TypeDefJson = {
  type: string;
  relations?: Record<string, UsersetNode>;
  metadata?: {
    relations?: Record<string, { directly_related_user_types?: DirectlyRelatedUserType[] }>;
  };
};

function byType(json: { type_definitions: TypeDefJson[] }): Record<string, TypeDefJson> {
  return Object.fromEntries(json.type_definitions.map(t => [t.type, t]));
}

describe('candidate-b/model.fga is a valid OpenFGA model', () => {
  it('passes validateDSL (syntax + schema validity)', () => {
    expect(() => validator.validateDSL(candidateBModelText)).not.toThrow();
  });

  it('transforms without throwing', () => {
    expect(() => transformer.transformDSLToJSONObject(candidateBModelText)).not.toThrow();
  });

  it('compiles to schema 1.1', () => {
    const json = transformer.transformDSLToJSONObject(candidateBModelText);
    expect(json.schema_version).toBe('1.1');
  });

  it('declares exactly 12 types', () => {
    const json = transformer.transformDSLToJSONObject(candidateBModelText);
    expect(json.type_definitions).toHaveLength(12);
  });

  it('declares exactly 88 relations across all types', () => {
    const json = transformer.transformDSLToJSONObject(candidateBModelText);
    const relationCount = json.type_definitions.reduce(
      (sum, t) => sum + Object.keys(t.relations ?? {}).length,
      0
    );
    expect(relationCount).toBe(88);
  });
});

/**
 * Staff-plane drift guard.
 *
 * `saga_platform` and `staff_org` are candidate-b's "verbatim from soa +
 * additions" types (see the header comment in candidate-b/model.fga).
 * Candidate-b is free to ADD relations to these types — the use-case survey
 * additions (`baseline`, `can_view_audit`, `can_audit_authz`,
 * `can_query_analytics`, `can_flip_prod_color`, `can_provision_sandbox`,
 * `can_manage_coach_playlists`, `staff_observe`, `staff_view_pii`) are
 * expected and are not asserted against here — but every relation that
 * already exists on the LIVE model must carry over into candidate-b with an
 * IDENTICAL userset rewrite AND identical directly-assignable types. A text
 * diff would not catch a structural change that renders the same (e.g.
 * reordered `or` operands), so this compares the transformed JSON, never the
 * DSL source text.
 */
describe('candidate-b matches the live model on the staff plane (drift guard)', () => {
  const liveJson = transformer.transformDSLToJSONObject(liveModelText);
  const candidateJson = transformer.transformDSLToJSONObject(candidateBModelText);
  const liveByType = byType(liveJson);
  const candidateByType = byType(candidateJson);

  const STAFF_PLANE_TYPES = ['saga_platform', 'staff_org'] as const;

  for (const typeName of STAFF_PLANE_TYPES) {
    const liveType = liveByType[typeName];

    it(`the live model declares ${typeName}`, () => {
      expect(
        liveType,
        `LIVE model.fga is missing type "${typeName}" — the drift guard has nothing to compare`
      ).toBeDefined();
    });

    const liveRelationNames = Object.keys(liveType?.relations ?? {});

    it.each(liveRelationNames)(
      `${typeName}.%s carries over from the live model unchanged`,
      relation => {
        const liveDef = liveType.relations![relation];
        const liveTypes =
          liveType.metadata?.relations?.[relation]?.directly_related_user_types ?? [];

        const candidateType = candidateByType[typeName];
        const candidateDef = candidateType?.relations?.[relation];
        const candidateTypes =
          candidateType?.metadata?.relations?.[relation]?.directly_related_user_types ?? [];

        expect(
          candidateDef,
          `candidate-b/model.fga is missing "${typeName}.${relation}" — a relation live on ` +
            `${typeName} in the LIVE model. Staff-plane relations may only be ADDED in ` +
            'candidate-b, never removed or renamed.'
        ).toBeDefined();

        expect(
          candidateDef,
          `candidate-b/model.fga's "${typeName}.${relation}" userset rewrite has drifted from ` +
            'the LIVE model. Staff-plane relations that already exist live must stay ' +
            'structurally identical in candidate-b (additions to the type are fine; changes ' +
            "to an existing relation's definition are not)."
        ).toEqual(liveDef);

        expect(
          candidateTypes,
          `candidate-b/model.fga's "${typeName}.${relation}" directly-assignable types ` +
            `(${JSON.stringify(candidateTypes)}) have drifted from the LIVE model's ` +
            `(${JSON.stringify(liveTypes)}).`
        ).toEqual(liveTypes);
      }
    );
  }
});

/**
 * Wildcard guard (candidate-b analogue of the live model's pgrant guard —
 * see `model-fga.unit.test.ts` "pgrant.%s is an INTERSECTION with subject,
 * never a union").
 *
 * A relation whose directly-assignable types include a public wildcard
 * (`user:*` or any `type:*`) confers its capability on EVERY object of that
 * type in the store. Anywhere such a relation is pulled into another
 * relation's definition (`computedUserset` in the same type, or a
 * `tupleToUserset` "X from Y" reference across types), that consumption MUST
 * be one arm of an `intersection` (so some other arm — e.g. `subject` — binds
 * it back down to a single caller). Reaching it through a `union` (or with no
 * guard at all) is a one-character fleet-wide authorization bypass. A
 * substring/text check cannot catch this reliably (an `or` and an `and` share
 * every token around them), so this walks the transformed JSON rewrite tree.
 */
function findWildcardRelationNames(json: { type_definitions: TypeDefJson[] }): Set<string> {
  const names = new Set<string>();
  for (const typeDef of json.type_definitions) {
    for (const [relation, meta] of Object.entries(typeDef.metadata?.relations ?? {})) {
      const types = meta?.directly_related_user_types ?? [];
      if (types.some(t => t.wildcard !== undefined)) {
        names.add(relation);
      }
    }
  }
  return names;
}

type WildcardConsumption = { relation: string; guardedByIntersection: boolean };

/**
 * Recursively walks a userset rewrite tree, recording every reference to a
 * wildcard relation together with whether its NEAREST enclosing combinator
 * (the operator whose `child` array directly holds it) is `intersection`.
 */
function collectWildcardConsumptions(
  node: UsersetNode | undefined,
  wildcardRelationNames: Set<string>,
  nearestOp: 'union' | 'intersection' | 'difference' | null,
  out: WildcardConsumption[]
): void {
  if (!node) return;

  if (node.computedUserset && wildcardRelationNames.has(node.computedUserset.relation)) {
    out.push({
      relation: node.computedUserset.relation,
      guardedByIntersection: nearestOp === 'intersection',
    });
  }
  if (
    node.tupleToUserset &&
    wildcardRelationNames.has(node.tupleToUserset.computedUserset.relation)
  ) {
    out.push({
      relation: node.tupleToUserset.computedUserset.relation,
      guardedByIntersection: nearestOp === 'intersection',
    });
  }
  if (node.union) {
    for (const child of node.union.child)
      collectWildcardConsumptions(child, wildcardRelationNames, 'union', out);
  }
  if (node.intersection) {
    for (const child of node.intersection.child) {
      collectWildcardConsumptions(child, wildcardRelationNames, 'intersection', out);
    }
  }
  if (node.difference) {
    collectWildcardConsumptions(node.difference.base, wildcardRelationNames, 'difference', out);
    collectWildcardConsumptions(node.difference.subtract, wildcardRelationNames, 'difference', out);
  }
}

/**
 * Returns one human-readable violation string per ungated wildcard
 * consumption found anywhere in the model (empty array = model is clean).
 */
function findUngatedWildcardConsumptions(json: { type_definitions: TypeDefJson[] }): string[] {
  const wildcardRelationNames = findWildcardRelationNames(json);
  const violations: string[] = [];

  for (const typeDef of json.type_definitions) {
    for (const [relation, def] of Object.entries(typeDef.relations ?? {})) {
      const found: WildcardConsumption[] = [];
      collectWildcardConsumptions(def, wildcardRelationNames, null, found);
      for (const consumption of found) {
        if (!consumption.guardedByIntersection) {
          violations.push(
            `${typeDef.type}.${relation} consumes wildcard relation "${consumption.relation}" ` +
              'without an intersection guard (must be one arm of an `and`, never reachable via `or`)'
          );
        }
      }
    }
  }

  return violations;
}

describe('candidate-b wildcard relations are only ever consumed through an intersection', () => {
  it('has no relation anywhere in candidate-b that consumes a [*] wildcard via union', () => {
    // Candidate-b declares no wildcard-typed relation today, so this passes
    // vacuously — the guard's bite is proven by the negative case below.
    const json = transformer.transformDSLToJSONObject(candidateBModelText);
    const violations = findUngatedWildcardConsumptions(json);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('rejects a union-consumed wildcard (proves the guard actually fires)', () => {
    const unsafeDsl = `
model
  schema 1.1

type user

type doc
  relations
    define grants_view: [user:*]
    define owner: [user]
    define can_view: owner or grants_view
`;
    const json = transformer.transformDSLToJSONObject(unsafeDsl);
    const violations = findUngatedWildcardConsumptions(json);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('doc.can_view');
    expect(violations[0]).toContain('grants_view');
  });

  it('accepts the same wildcard consumed through an intersection', () => {
    const safeDsl = `
model
  schema 1.1

type user

type doc
  relations
    define grants_view: [user:*]
    define subject: [user]
    define can_view: subject and grants_view
`;
    const json = transformer.transformDSLToJSONObject(safeDsl);
    const violations = findUngatedWildcardConsumptions(json);

    expect(violations).toEqual([]);
  });
});
