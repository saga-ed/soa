/**
 * Attach-mode profiling decisions. PURE — the IO is faked by the caller shape.
 *
 * These assert the REFUSALS more than the happy path, because every failure mode
 * here is one where profiling would otherwise appear to succeed against the wrong
 * process: a wrapper pid, a Vite dev server, or an inspector port already owned by
 * someone else.
 */

import { describe, expect, it } from 'vitest';
import { inspectorPort } from '../inspector.js';
import {
  defaultArtifactPath,
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
    const plan = planProfile('iam-api', 0, target());
    expect(plan).toMatchObject({ ok: true, pid: 4242, adopted: true });
    if (plan.ok) expect(plan.port).toBe(inspectorPort('iam-api', 0));
  });

  it('uses the slot-offset inspector port', () => {
    const plan = planProfile('iam-api', 4, target());
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.port).toBe(inspectorPort('iam-api', 4));
  });

  it('refuses a frontend (that would profile the Vite dev server)', () => {
    const plan = planProfile('coach-web', 0, target());
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/frontend/i);
  });

  it('refuses when nothing is listening', () => {
    const plan = planProfile('iam-api', 0, target({ listenerPid: null }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/not listening/i);
  });

  it('refuses when the listener vanished before it could be inspected', () => {
    const plan = planProfile('iam-api', 0, target({ proc: null }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/no longer inspectable/i);
  });

  it('HARD-refuses when the inspector port is already held', () => {
    // The sharpest footgun: SIGUSR1 cannot pick a port, so the service would fail
    // to open its inspector silently and we would attach to the squatter.
    const plan = planProfile('iam-api', 0, target({ inspectorPortBusy: true }));
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/already in use/i);
  });

  it('allows an unowned listener but reports it as not adopted', () => {
    const plan = planProfile('iam-api', 0, target({ ownedPgids: [999] }));
    expect(plan).toMatchObject({ ok: true, adopted: false });
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
});
