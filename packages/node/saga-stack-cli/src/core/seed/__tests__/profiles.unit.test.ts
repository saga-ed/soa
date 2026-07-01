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
      expect(vars.DATABASE_URL).toBe('postgresql://iam:iam@localhost:5432/iam_local');
      expect(vars.PII_DATABASE_URL).toBe('postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local');
      expect(vars.PII_CRYPTO_PIIDEKHEX).toMatch(/^[0-9a-f]{64}$/);
      expect(vars.PII_CRYPTO_PIIHMACKEYHEX).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('no seed step uses the unimplemented dotenv env kind', () => {
    for (const step of Object.values(reg)) {
      expect(step.env.kind).not.toBe('dotenv');
    }
  });

  // up.sh runs seed-dev-user with `|| true` (prep :1030 + reset :1596): a failure
  // (e.g. iam registry not seeded) must NOT abort the bring-up. Regression for the
  // soak's "registry is missing required session permissions" fatal abort.
  it('iam-dev-user is best-effort (warn), mirroring up.sh `|| true`', () => {
    expect(reg['iam-dev-user'].failureMode).toBe('warn');
  });
});
