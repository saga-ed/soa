/**
 * Inspector-port derivation (attach-mode profiling). PURE — no IO, no seams.
 *
 * The port is Node's SIGUSR1 default, with NO slot offset: nothing is injected at
 * launch, so SIGUSR1 always opens 9229 whatever the slot. What matters
 * operationally: the prediction is stable, frontends are excluded, and the port
 * never overlaps a real service/mesh port at any slot.
 */

import { describe, expect, it } from 'vitest';
import { SLOT_PORT_STRIDE } from '../derive-instance.js';
import { INSPECTOR_PORT, assertInspectorPortFree, profilableServices } from '../inspector.js';
import { manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

describe('profilableServices', () => {
  it('includes backends and excludes every frontend', () => {
    const ids = profilableServices();
    expect(ids).toContain('iam-api');
    expect(ids).toContain('coach-api');
    for (const id of ids) expect(manifest.services[id].isFrontend).toBe(false);
    for (const id of ['saga-dash', 'coach-web', 'connect-web', 'staff-admin-console'] as ServiceId[]) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('INSPECTOR_PORT', () => {
  it("is Node's SIGUSR1 default, which cannot be chosen", () => {
    expect(INSPECTOR_PORT).toBe(9229);
  });

  it('sits below the slot band, so no offset arithmetic can be mistaken for it', () => {
    // Nothing injects --inspect-port (launch-plan.unit.test.ts pins NODE_OPTIONS
    // undefined on every service), so SIGUSR1 opens 9229 in every slot. The port
    // that planProfile reports is pinned in profile-plan.unit.test.ts.
    expect(INSPECTOR_PORT).toBeLessThan(SLOT_PORT_STRIDE * 10);
  });
});

describe('assertInspectorPortFree', () => {
  it('passes against the real manifest for slots 0-9', () => {
    expect(() => assertInspectorPortFree()).not.toThrow();
  });

  it('throws when a service is banded onto the inspector port', () => {
    const colliding = {
      ...manifest,
      services: {
        ...manifest.services,
        'iam-api': { ...manifest.services['iam-api'], port: INSPECTOR_PORT },
      },
    };
    expect(() => assertInspectorPortFree(colliding, 0)).toThrow(/collides with/);
  });

  it('catches a service that only reaches the inspector port at a HIGHER slot', () => {
    // The offset applies to services, not the inspector — so a service whose base
    // port is below 9229 can still land on it once slotted.
    const colliding = {
      ...manifest,
      services: {
        ...manifest.services,
        'iam-api': { ...manifest.services['iam-api'], port: INSPECTOR_PORT - 2 * SLOT_PORT_STRIDE },
      },
    };
    expect(() => assertInspectorPortFree(colliding, 0)).not.toThrow();
    expect(() => assertInspectorPortFree(colliding, 2)).toThrow(/collides with service iam-api/);
  });
});
