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
