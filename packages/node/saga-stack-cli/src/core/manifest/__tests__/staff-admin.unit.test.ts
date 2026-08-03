/**
 * staff-admin-console manifest guards.
 *
 * The console is saga-dash's SECOND app — a staff-only SPA plus its own BFF —
 * and the two entries encode three facts that are easy to regress and expensive
 * to debug, because each fails as a plausible-looking 200/404 rather than a
 * crash. Each gets a test here.
 */
import { describe, expect, it } from 'vitest';

import { computeClosure } from '../../closure.js';
import { manifest } from '../index.js';

const bff = manifest.services['staff-admin-bff'];
const spa = manifest.services['staff-admin-console'];

describe('staff-admin manifest entries', () => {
  it('keeps both out of the default closure (optional)', () => {
    // A bare `ss stack up` must stay byte-identical: this is an operator
    // console, reached only via `--with staff-admin` / `--only`.
    expect(bff.optional).toBe(true);
    expect(spa.optional).toBe(true);
  });

  it('points the BFF at BARE upstream origins, never a /trpc suffix', () => {
    // 🪤 The BFF's tRPC clients append `/trpc` themselves (iam-client.ts et al),
    // unlike ads-adm-api whose manifest entry uses `${IAM_URL}/trpc`. Copying
    // that form here doubles the segment and 404s in a way that reads like a
    // broken feature rather than a config error.
    expect(bff.launch.env.IAM_API_URL).toBe('${IAM_URL}');
    expect(bff.launch.env.PROGRAMS_API_URL).toBe('http://localhost:${PROGRAMS_PORT}');
    expect(bff.launch.env.SIS_API_URL).toBe('http://localhost:${SIS_PORT}');
    for (const [key, value] of Object.entries(bff.launch.env)) {
      expect(`${key}=${value}`).not.toMatch(/\/trpc$/);
    }
  });

  it('fingerprints IAM_API_URL so a `dev:mock` BFF is never adopted', () => {
    // The app's documented local path (`pnpm dev:mock`) pins IAM_API_URL at the
    // e2e mock (127.0.0.1:4610). Adopting such a process serves FIXTURE data
    // from a console claiming to be on the ss stack — 200s all the way down.
    expect(bff.adoptEnv).toContain('IAM_API_URL');
  });

  it('routes the SPA proxy at its OWN slot BFF', () => {
    // The SPA's listen port cannot slot (vite ignores $PORT; the port is baked
    // into vite.config.ts + the dev script), but its proxy target CAN — so a
    // slot > 0 console must not silently read slot 0's BFF.
    expect(spa.launch.env.BFF_URL).toBe('http://localhost:${STAFF_ADMIN_BFF_PORT}');
    expect(spa.portEnvVar).toBeNull();
  });

  it('brings the BFF up before the SPA that proxies to it', () => {
    expect(spa.dependsOn).toContain('staff-admin-bff');
    expect(bff.dependsOn).toEqual(['iam-api', 'programs-api', 'sis-api']);
  });
});

describe('staff-admin closure admission', () => {
  const ids = ['staff-admin-bff', 'staff-admin-console'] as const;

  it('resolves the pair + its upstream closure under withStaffAdmin', () => {
    const c = computeClosure(manifest, [...ids], { withStaffAdmin: true });
    // The whole point of the bundle: one flag, and the upstreams the console
    // reads come along automatically.
    expect(c.services).toEqual([
      'iam-api',
      'sis-api',
      'programs-api',
      'staff-admin-bff',
      'staff-admin-console',
    ]);
  });

  it('DROPS the pair without the flag (each optional service needs its own)', () => {
    // Regression: `admitsOptional` fell through to `withPlayback` for unknown
    // optional ids, so `--with staff-admin` silently resolved ZERO services
    // while every test still passed.
    expect(computeClosure(manifest, [...ids], {}).services).toEqual([]);
    expect(computeClosure(manifest, [...ids], { withPlayback: true }).services).toEqual([]);
    expect(computeClosure(manifest, [...ids], { withAuthz: true }).services).toEqual([]);
  });

  it('is not cross-admitted by, and does not cross-admit, other optionals', () => {
    const c = computeClosure(manifest, ['authz-sync', ...ids], {
      withStaffAdmin: true,
    });
    expect(c.services).not.toContain('authz-sync');
  });

  it('stays out of the default full-stack closure', () => {
    const all = Object.keys(manifest.services).filter(
      (id) => !manifest.services[id as keyof typeof manifest.services].optional,
    );
    const c = computeClosure(manifest, all as never, {});
    for (const id of ids) expect(c.services).not.toContain(id);
  });
});
