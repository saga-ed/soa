import { describe, expect, it } from 'vitest';
import { buildSeedRegistry } from '../profiles.js';

// Regression for the soak-uncovered blocker: the iam-dev-user / iam seed steps
// used an unimplemented `dotenv` SeedEnv kind that spawned the iam-db seed child
// with an EMPTY env → `seed-dev-user failed: Error: DATABASE_URL is required`.
// They must now carry the DB connection + PII crypto env inline (mirroring the
// `.env.local` up.sh sources), so the spawned seed has what it reads.
describe('buildSeedRegistry — iam seed env (regression: DATABASE_URL is required)', () => {
  const reg = buildSeedRegistry();

  for (const id of ['iam-dev-user', 'iam'] as const) {
    it(`${id} supplies the DB + PII env the iam-db seed reads (no dotenv)`, () => {
      const step = reg[id];
      expect(step.env.kind).toBe('inline-multi');
      const vars = (step.env as { vars: Record<string, string> }).vars;
      // The pure registry emits the mesh postgres port as a `${MESH_PG_PORT}` TOKEN
      // (resolved per-slot in stack-api's seedEnv: 5432 at slot 0, 5432+offset above);
      // everything else is the literal manifest-derived connection data.
      expect(vars.DATABASE_URL).toBe('postgresql://iam:iam@localhost:${MESH_PG_PORT}/iam_local');
      expect(vars.PII_DATABASE_URL).toBe('postgresql://iam_pii:iam_pii@localhost:${MESH_PG_PORT}/iam_pii_local');
      expect(vars.PII_CRYPTO_PIIDEKHEX).toMatch(/^[0-9a-f]{64}$/);
      expect(vars.PII_CRYPTO_PIIHMACKEYHEX).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('no seed step uses the unimplemented dotenv env kind', () => {
    for (const step of Object.values(reg)) {
      expect(step.env.kind).not.toBe('dotenv');
    }
  });

  // Slot bugfix: the pure registry must NEVER bake a literal mesh postgres port —
  // it has no slot/offset context. Every pg connection var carries the
  // `${MESH_PG_PORT}` token (resolved per-slot in stack-api's seedEnv), so a seed at
  // slot N>0 dials the slot's offset postgres instead of slot 0's :5432.
  it('every pg seed env var emits the ${MESH_PG_PORT} token, never a literal :5432', () => {
    const collect = (step: (typeof reg)[keyof typeof reg]): Record<string, string>[] => [
      step.env.kind !== 'dotenv' ? step.env.vars : {},
      ...(step.optionalSteps ?? []).map((s) => (s.env.kind !== 'dotenv' ? s.env.vars : {})),
    ];
    for (const step of Object.values(reg)) {
      for (const vars of collect(step)) {
        for (const [k, v] of Object.entries(vars)) {
          // A pg connection var either names the port var or embeds a postgres URL.
          if (k === 'POSTGRES_PORT') {
            expect(v).toBe('${MESH_PG_PORT}');
          } else if (v.startsWith('postgresql://')) {
            expect(v).toContain(':${MESH_PG_PORT}/');
            expect(v).not.toMatch(/:\d+\//); // no literal port
          }
        }
      }
    }
  });

  // up.sh runs seed-dev-user with `|| true` (prep :1030 + reset :1596): a failure
  // (e.g. iam registry not seeded) must NOT abort the bring-up. Regression for the
  // soak's "registry is missing required session permissions" fatal abort.
  it('iam-dev-user is best-effort (warn), mirroring up.sh `|| true`', () => {
    expect(reg['iam-dev-user'].failureMode).toBe('warn');
  });
});
