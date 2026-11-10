import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReportSchema, StreamSchema } from '../contract.js';
describe('version 1 wire contract', () => {
  // JSON Schema generation is Zod 4 only; the Zod 3 run (test:zod3) still checks validation.
  it.skipIf(typeof z.toJSONSchema !== 'function')(
    'matches the checked-in schema; published contracts require a new version for breaking changes',
    () => {
      const frozen = JSON.parse(
        readFileSync(new URL('../../contracts/event-stats.v1.json', import.meta.url), 'utf8')
      );
      expect(z.toJSONSchema(ReportSchema)).toEqual(frozen);
    }
  );
  it('requires consumer topology identifiers beyond the generated JSON schema', () => {
    expect(
      StreamSchema.safeParse({ role: 'consumer', exchange: 'events', eventType: 'created' }).success
    ).toBe(false);
  });
});
