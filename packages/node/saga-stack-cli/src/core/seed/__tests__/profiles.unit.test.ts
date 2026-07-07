import { describe, expect, it } from 'vitest';
import { buildSeedRegistry, PROFILE_STEPS, SEED_RUN_ORDER } from '../profiles.js';

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

// soa#253: the native seed profiles never ran iam's `seed:registry`
// (iam-db/dist/seed-registry.js), so after rostering added registry-gated nav-tab
// permissions (view_rosters_tab/view_sessions_tab), seed-dev-user REFUSED the
// dev-admin grant and the journey /roster stage 500'd. The registry must be its
// own seed step, ordered FIRST (before iam-dev-user) in every iam-seeding profile.
describe('buildSeedRegistry — iam-registry step (soa#253)', () => {
  const reg = buildSeedRegistry();

  it('exists with the seed-registry.js command from the iam-db package', () => {
    const step = reg['iam-registry'];
    expect(step.service).toBe('iam-api');
    expect(step.cwd).toBe('packages/node/iam-db');
    expect(step.command).toEqual(['node', 'dist/seed-registry.js']);
  });

  it('is FATAL — the Permission/Policy catalog is a hard prerequisite (not warn like iam-dev-user)', () => {
    expect(reg['iam-registry'].failureMode).toBe('fatal');
    expect(reg['iam-dev-user'].failureMode).toBe('warn');
  });

  it('is OFFLINE (direct DB) — no requiresServiceUp, so it runs pre-launch before iam-dev-user', () => {
    expect(reg['iam-registry'].requiresServiceUp).toEqual([]);
  });

  it('carries the SAME iam DB/PII env as iam/iam-dev-user (DATABASE_URL for iam_local)', () => {
    const step = reg['iam-registry'];
    expect(step.env.kind).toBe('inline-multi');
    const vars = (step.env as { vars: Record<string, string> }).vars;
    expect(vars.DATABASE_URL).toBe('postgresql://iam:iam@localhost:${MESH_PG_PORT}/iam_local');
    // full iamSeedEnv superset (PII vars) is byte-identical to iam-dev-user's.
    expect(vars).toEqual((reg['iam-dev-user'].env as { vars: Record<string, string> }).vars);
  });
});

describe('seed profiles list iam-registry FIRST in every iam-seeding profile (soa#253)', () => {
  // Any profile that seeds iam (contains iam-dev-user) MUST place iam-registry at
  // index 0 — the catalog its dev-admin grant reads. Mutation-check: drop
  // 'iam-registry' from a profile array and this test fails.
  for (const [profile, steps] of Object.entries(PROFILE_STEPS)) {
    if (!steps.includes('iam-dev-user')) continue;
    it(`${profile} lists iam-registry before iam-dev-user (at index 0)`, () => {
      expect(steps[0]).toBe('iam-registry');
      expect(steps.indexOf('iam-registry')).toBeLessThan(steps.indexOf('iam-dev-user'));
    });
  }

  it('SEED_RUN_ORDER places iam-registry before iam-dev-user', () => {
    expect(SEED_RUN_ORDER.indexOf('iam-registry')).toBeLessThan(SEED_RUN_ORDER.indexOf('iam-dev-user'));
  });
});
