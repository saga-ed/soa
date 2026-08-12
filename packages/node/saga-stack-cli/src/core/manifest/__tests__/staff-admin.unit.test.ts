/**
 * staff-admin-console manifest guards.
 *
 * The console is saga-dash's SECOND app — a staff-only SPA plus its own BFF —
 * and the two entries encode three facts that are easy to regress and expensive
 * to debug, because each fails as a plausible-looking 200/404 rather than a
 * crash. Each gets a test here.
 */
import { describe, expect, it } from 'vitest';

import { closureDatabases } from '../../../commands/stack/snapshot/store.js';
import {
  AUTHZ_IDS,
  PLAYBACK_IDS,
  STAFF_ADMIN_IDS,
  closureOptsFor,
  closureOptsForIds,
} from '../../bundles.js';
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
    // A slot > 0 console must not silently read slot 0's BFF — that would mix
    // two stacks' data behind one console.
    expect(spa.launch.env.BFF_URL).toBe('http://localhost:${STAFF_ADMIN_BFF_PORT}');
    // vite ignores $PORT (hence null), but the SPA still slots: `isFrontend`
    // services get `--port <base+offset>` appended to argv by stack-api.
    expect(spa.portEnvVar).toBeNull();
    expect(spa.isFrontend).toBe(true);
  });

  it('brings the BFF up before the SPA that proxies to it', () => {
    expect(spa.dependsOn).toContain('staff-admin-bff');
    expect(bff.dependsOn).toEqual(['iam-api', 'programs-api', 'sis-api', 'content-api']);
  });

  it('TELLS the BFF its listen port instead of relying on offset injection', () => {
    // 🪤 launch-plan injects `portEnvVar` ONLY when the resolved port differs
    // from the manifest base ("so slot-0 env stays byte-identical"). At slot 0
    // this BFF resolves to 3011 === its manifest 3011, so nothing is injected —
    // and local.ts falls back to its OWN baked default of 3000. The health poll
    // then watches :3011 forever and the launch fails as "never became healthy".
    // Every other portEnvVar service bakes the same default as its manifest
    // port; this one is the lone exception, so it must say so explicitly.
    expect(bff.launch.env.PORT).toBe('${STAFF_ADMIN_BFF_PORT}');
  });

  it('points the BFF at content-api, whose baked default is another service', () => {
    // 🪤 The BFF's built-in CONTENT_API_URL default is localhost:3010 — which in
    // this manifest is iam-api, not content-api (:3009). Unset, the console's
    // connect-content pages query iam-api and get plausible 200s off the wrong
    // service, reading as "content is empty" rather than as a misconfiguration.
    expect(bff.launch.env.CONTENT_API_URL).toBe('http://localhost:${CONTENT_PORT}');
    expect(bff.depKinds['content-api']).toBe('url');
  });

  it('keeps the BFF off the contested :3000', () => {
    // `deriveInstance` builds portOverrides over EVERY service (optional too),
    // and `stack down`'s orphan reap group-kills whatever sits on the resulting
    // band — for every user, including those who never pass --with staff-admin.
    // On :3000 that means SIGKILLing a stray Next/Rails dev server.
    expect(bff.port).not.toBe(3000);
    expect(bff.port).toBe(3011);
    expect(bff.lane.stack).toBe('http://localhost:3011');
  });

  it('makes the SPA→BFF edge survive followBrowserEdges:false', () => {
    // A 'browser' edge is skipped in flow/e2e closures, which would resolve the
    // SPA WITHOUT its only upstream — every page then fails at the /api proxy.
    expect(spa.depKinds['staff-admin-bff']).toBe('url');
  });

  it('fingerprints BOTH processes against adoption of a stray dev server', () => {
    // Both sides of the proxy can be mis-adopted: a `dev:mock` BFF serves fixture
    // data, and a stray vite never receives BFF_URL (so it proxies to :3000).
    expect(bff.adoptEnv).toContain('IAM_API_URL');
    expect(spa.adoptEnv).toContain('BFF_URL');
  });
});

describe('staff-admin closure admission', () => {
  const ids = ['staff-admin-bff', 'staff-admin-console'] as const;

  it('resolves the pair + its upstream closure under withStaffAdmin', () => {
    const c = computeClosure(manifest, [...ids], { withStaffAdmin: true });
    // The whole point of the bundle: one flag, and the upstreams the console
    // reads come along automatically — content-api included, since the
    // connect-content pages (search + bulk ingest) are unusable without it.
    expect(c.services).toEqual([
      'iam-api',
      'sis-api',
      'programs-api',
      'content-api',
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

describe('optional-service id sets (derived from BUNDLES)', () => {
  it('maps each opt-in flag to its own bundle services', () => {
    // Consumers that map an optional id BACK to its flag (flow resolution,
    // workspace run-sets) read these instead of hand-listing ids, so they
    // cannot drift from the bundle registry.
    expect(STAFF_ADMIN_IDS).toEqual(['staff-admin-bff', 'staff-admin-console']);
    expect(AUTHZ_IDS).toEqual(['authz-sync']);
    expect(PLAYBACK_IDS).toEqual(['transcripts-api', 'insights-api', 'chat-api']);
  });

  it('every optional manifest service belongs to exactly one opt-in set', () => {
    // The gap this whole class of bug came from: an optional service with no
    // flag mapping silently resolves to an EMPTY closure at every caller.
    const mapped = new Set<string>([...PLAYBACK_IDS, ...AUTHZ_IDS, ...STAFF_ADMIN_IDS]);
    const optional = Object.values(manifest.services)
      .filter((s) => s.optional)
      .map((s) => s.id);
    for (const id of optional) expect(mapped.has(id)).toBe(true);
  });
});

describe('closureOptsFor / closureOptsForIds', () => {
  it('derives every flag from one --with list', () => {
    expect(closureOptsFor(['staff-admin'])).toEqual({
      withPlayback: false,
      withAuthz: false,
      withStaffAdmin: true,
    });
    expect(closureOptsFor(undefined)).toEqual({
      withPlayback: false,
      withAuthz: false,
      withStaffAdmin: false,
    });
  });

  it('derives the same flags from wanted ids (workspace run-set / flow systems)', () => {
    expect(closureOptsForIds(['staff-admin-console'])).toEqual({
      withPlayback: false,
      withAuthz: false,
      withStaffAdmin: true,
    });
    expect(closureOptsForIds(['iam-api'])).toEqual({
      withPlayback: false,
      withAuthz: false,
      withStaffAdmin: false,
    });
  });

  it('never cross-admits between families', () => {
    expect(closureOptsFor(['authz']).withStaffAdmin).toBe(false);
    expect(closureOptsFor(['playback']).withAuthz).toBe(false);
    expect(closureOptsFor(['staff-admin']).withPlayback).toBe(false);
  });
});

describe('admitsOptional is exhaustive', () => {
  it('throws on an optional id with no opt-in flag rather than silently dropping it', () => {
    // The whole bug class: an unmapped optional id used to inherit `withPlayback`
    // and resolve an EMPTY closure with exit 0. It must now fail loudly.
    const fake = {
      ...manifest,
      services: {
        ...manifest.services,
        'ghost-api': { ...manifest.services['iam-api'], id: 'ghost-api', optional: true },
      },
    } as unknown as typeof manifest;
    expect(() => computeClosure(fake, ['ghost-api'] as never, {})).toThrow(/no opt-in flag/);
  });

  it('still admits every real optional family from its own flag', () => {
    expect(computeClosure(manifest, ['authz-sync'], { withAuthz: true }).services).toEqual([
      'authz-sync',
    ]);
    expect(computeClosure(manifest, ['chat-api'], { withPlayback: true }).services).toContain(
      'chat-api',
    );
  });
});

describe('snapshot store — closureDatabases', () => {
  const fail = (m: string): never => {
    throw new Error(m);
  };

  it('resolves the staff-admin closure DBs when the flag is set', () => {
    // Regression: this call site omitted `withStaffAdmin`, so the ids resolved
    // to an EMPTY db list — and `storePlan` honours a defined-but-empty `only`
    // as "dump exactly these", writing a zero-database snapshot that exits 0.
    // The pair owns no DBs itself; the upstreams it pulls in do.
    const dbs = closureDatabases([...STAFF_ADMIN_IDS], closureOptsFor(['staff-admin']), fail);
    expect(dbs).not.toEqual([]);
    expect(dbs).toContain('iam_local');
  });

  it('still fails loudly on an unknown service id', () => {
    expect(() => closureDatabases(['nope' as never], closureOptsFor(['staff-admin']), fail)).toThrow(
      /unknown service id/,
    );
  });
});
