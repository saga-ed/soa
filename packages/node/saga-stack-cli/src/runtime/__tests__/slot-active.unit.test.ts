/**
 * Slot-activity probe (M13-A `set list` ACTIVE column): pid-liveness leg,
 * compose-containers leg, and the everything-folds-to-false degradation.
 */

import { describe, expect, it } from 'vitest';
import { makeSlotActiveProbe } from '../slot-active.js';

describe('makeSlotActiveProbe', () => {
  it('a live pid makes the slot active without consulting docker', async () => {
    let dockerAsked = false;
    const probe = makeSlotActiveProbe({
      listPidFiles: () => ['/state/iam-api.pid'],
      readPid: () => 4242,
      pidAlive: () => true,
      projectHasContainers: async () => {
        dockerAsked = true;
        return false;
      },
    });
    await expect(probe.isActive('/state', 'soa-s1')).resolves.toBe(true);
    expect(dockerAsked).toBe(false);
  });

  it('dead pids fall through to the compose-containers leg', async () => {
    const probe = makeSlotActiveProbe({
      listPidFiles: () => ['/state/iam-api.pid'],
      readPid: () => 4242,
      pidAlive: () => false,
      projectHasContainers: async (project) => project === 'soa-s2',
    });
    await expect(probe.isActive('/state', 'soa-s2')).resolves.toBe(true);
    await expect(probe.isActive('/state', 'soa-s3')).resolves.toBe(false);
  });

  it('a missing state dir (no pid files) + no containers = inactive', async () => {
    const probe = makeSlotActiveProbe({
      listPidFiles: () => [],
      projectHasContainers: async () => false,
    });
    await expect(probe.isActive('/nope', 'soa-s1')).resolves.toBe(false);
  });

  it('unreadable pid files are skipped, not fatal', async () => {
    const probe = makeSlotActiveProbe({
      listPidFiles: () => ['/state/bad.pid', '/state/good.pid'],
      readPid: (p) => (p.endsWith('good.pid') ? 99 : null),
      pidAlive: (pid) => pid === 99,
      projectHasContainers: async () => false,
    });
    await expect(probe.isActive('/state', 'soa-s1')).resolves.toBe(true);
  });
});
