/**
 * Attach-mode profiling decisions. PURE — the IO is faked by the caller shape.
 *
 * These assert the REFUSALS more than the happy path, because every failure mode
 * here is one where profiling would otherwise appear to succeed against the wrong
 * process: a wrapper pid, a Vite dev server, or an inspector port already owned by
 * someone else.
 */

import { describe, expect, it } from 'vitest';
import { INSPECTOR_PORT } from '../inspector.js';
import {
  defaultArtifactPath,
  looksLikeNode,
  parseDuration,
  planProfile,
  profileHasServiceFrames,
  type ProfileTarget,
} from '../profile-plan.js';

/** A healthy target: listening, inspectable, owned by this slot, port free. */
function target(over: Partial<ProfileTarget> = {}): ProfileTarget {
  return {
    listenerPid: 4242,
    proc: { pgid: 4200, command: 'node dist/main.js' },
    ownedPgids: [4200],
    inspectorPortBusy: false,
    ...over,
  };
}

describe('planProfile', () => {
  it('plans a profile against the LISTENING pid, not a pidfile pid', () => {
    const plan = planProfile('iam-api', target());
    expect(plan).toMatchObject({ ok: true, pid: 4242, adopted: true });
    if (plan.ok) expect(plan.port).toBe(INSPECTOR_PORT);
  });

  it('reports the un-offset inspector port for every service', () => {
    // SIGUSR1 takes no port argument, so the port must never carry a slot offset:
    // an offset port is one nothing ever binds.
    for (const id of ['iam-api', 'coach-api', 'sessions-api'] as const) {
      const plan = planProfile(id, target());
      if (!plan.ok) throw new Error(`expected ok for ${id}`);
      expect(plan.port).toBe(INSPECTOR_PORT);
    }
  });

  it('refuses a frontend (that would profile the Vite dev server)', () => {
    const plan = planProfile('coach-web', target());
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/frontend/i);
  });

  it('refuses when nothing is listening', () => {
    const plan = planProfile('iam-api', target({ listenerPid: null }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/not listening/i);
  });

  it('refuses when the listener vanished before it could be inspected', () => {
    const plan = planProfile('iam-api', target({ proc: null }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/no longer inspectable/i);
  });

  it('HARD-refuses when SOMEONE ELSE holds the inspector port', () => {
    // SIGUSR1 cannot pick a port, so the service could not open its own inspector
    // and we would attach to the squatter.
    const plan = planProfile('iam-api', target({ inspectorPortBusy: true, inspectorPortPid: 777 }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/held by pid 777/i);
  });

  it('does not offer another slot as an escape from a held port', () => {
    // The inspector port takes no slot offset, so "try another slot" is unachievable
    // advice — the refusal must not imply the collision is slot-scoped.
    const plan = planProfile('iam-api', target({ inspectorPortBusy: true, inspectorPortPid: 777 }));
    if (plan.ok) throw new Error('expected refusal');
    expect(plan.reason).not.toMatch(/profile in another slot/i);
  });

  it('RE-ATTACHES when the target itself holds the port', () => {
    // Node leaves the inspector open after the CDP client disconnects, so a second
    // profile of the same service must not be refused.
    const plan = planProfile('iam-api', target({ inspectorPortBusy: true, inspectorPortPid: 4242 }));
    expect(plan).toMatchObject({ ok: true, pid: 4242, alreadyOpen: true });
  });

  it('refuses to signal a listener that is not a node process', () => {
    // SIGUSR1 has no handler there, so the default disposition TERMINATES it.
    const plan = planProfile(
      'iam-api',
      target({ proc: { pgid: 4200, command: '/usr/bin/python3 -m http.server 3010' } }),
    );
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/not a node process/i);
  });

  it('allows an unowned listener but reports it as not adopted', () => {
    const plan = planProfile('iam-api', target({ ownedPgids: [999] }));
    expect(plan).toMatchObject({ ok: true, adopted: false });
  });
});

describe('looksLikeNode', () => {
  // Both directions matter: a false POSITIVE gets a live non-node process killed by
  // SIGUSR1's default disposition, and a false NEGATIVE refuses a real service.
  it.each([
    'node dist/main.js',
    '/usr/bin/node dist/main.js',
    '/usr/bin/env node dist/main.js',
    '/usr/bin/env NODE_ENV=dev node dist/main.js',
    '/home/u/.nvm/versions/node/v24.13.0/bin/node dist/main.js',
    'nodejs server.js',
    '/opt/node-22/bin/node app.js',
  ])('accepts %s', (command) => {
    expect(looksLikeNode(command)).toBe(true);
  });

  it.each([
    'java -cp /opt/node/lib App',
    'python /srv/node/app.py',
    'ruby /srv/node/app.rb',
    'nginx -c /etc/node/nginx.conf',
    '/usr/bin/python3 -m http.server 3010',
    '/usr/bin/env python3 /srv/node/x.py',
    'node_modules/.bin/tsx watch src/main.ts',
  ])('refuses %s', (command) => {
    expect(looksLikeNode(command)).toBe(false);
  });
});

describe('parseDuration', () => {
  it('parses ms / s / m and bare seconds', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('15')).toBe(15_000);
  });

  it('rejects junk and non-positive values', () => {
    for (const bad of ['', 'soon', '-5s', '0', '10h']) expect(parseDuration(bad)).toBeNull();
  });
});

describe('defaultArtifactPath', () => {
  it('is slot-scoped and does not double a trailing slash', () => {
    expect(defaultArtifactPath('/tmp/sds-synthetic', 'iam-api', 'T1')).toBe(
      '/tmp/sds-synthetic/iam-api-T1.cpuprofile',
    );
    expect(defaultArtifactPath('/tmp/sds-synthetic-s2/', 'coach-api', 'T2')).toBe(
      '/tmp/sds-synthetic-s2/coach-api-T2.cpuprofile',
    );
  });
});

describe('profileHasServiceFrames', () => {
  it('detects the service\'s own frames', () => {
    const profile = {
      nodes: [{ hitCount: 3, callFrame: { url: 'file:///r/apps/node/iam-api/dist/main.js' } }],
    };
    expect(profileHasServiceFrames(profile, 'iam-api')).toBe(true);
  });

  it('rejects a wrapper-only profile (the --cpu-prof failure mode)', () => {
    // pnpm + tsup frames only: plenty of nodes, none from the service.
    const profile = {
      nodes: [
        { hitCount: 9, callFrame: { url: 'file:///g/pnpm/dist/pnpm.cjs' } },
        { hitCount: 4, callFrame: { url: 'file:///r/node_modules/tsup/dist/cli-default.js' } },
      ],
    };
    expect(profileHasServiceFrames(profile, 'iam-api')).toBe(false);
  });

  it('handles an empty profile', () => {
    expect(profileHasServiceFrames({}, 'iam-api')).toBe(false);
    expect(profileHasServiceFrames({ nodes: [] }, 'iam-api')).toBe(false);
  });

  it('rejects frames that were never SAMPLED (hitCount 0)', () => {
    // A profile's `nodes` is the whole call tree: parent and parse-time nodes
    // exist with hitCount 0 even when the service never ran, so an idle service
    // with a loaded module graph must not read as "has app frames".
    const idle = {
      nodes: [{ hitCount: 0, callFrame: { url: 'file:///r/apps/node/iam-api/dist/main.js' } }],
    };
    expect(profileHasServiceFrames(idle, 'iam-api')).toBe(false);
  });

  it('matches a tsx-watch service that runs from src/, not dist/', () => {
    // staff-admin-bff is a profilable backend whose dev script is
    // `tsx watch src/local.ts` — pinning `/dist` reported every valid capture
    // of it as empty.
    const profile = {
      nodes: [
        {
          hitCount: 5,
          callFrame: { url: 'file:///w/apps/web/staff-admin-console/backend/src/local.ts' },
        },
      ],
    };
    expect(profileHasServiceFrames(profile, 'staff-admin-bff')).toBe(true);
  });
});
