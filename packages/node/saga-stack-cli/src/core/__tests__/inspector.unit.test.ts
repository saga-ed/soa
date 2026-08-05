/**
 * Inspector-port derivation (attach-mode profiling). PURE — no IO, no seams.
 *
 * The port is Node's SIGUSR1 default plus the slot offset — nothing is injected at
 * launch (see the module docblock for why a per-service preset was removed). What
 * matters operationally: the prediction is stable, slots are isolated, frontends
 * are excluded, and the band never overlaps a real service/mesh port.
 */

import { describe, expect, it } from 'vitest';
import { SLOT_PORT_STRIDE } from '../derive-instance.js';
import {
  INSPECTOR_BASE_PORT,
  assertInspectorBandFree,
  inspectorPort,
  profilableServices,
} from '../inspector.js';
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

describe('inspectorPort', () => {
  it('is null for a frontend (profiling a vite dev server is not the ask)', () => {
    expect(inspectorPort('coach-web', 0)).toBeNull();
    expect(inspectorPort('saga-dash', 0)).toBeNull();
  });

  it("is Node's SIGUSR1 default at slot 0 (the port cannot be chosen)", () => {
    const [first] = profilableServices();
    expect(first).toBeDefined();
    expect(inspectorPort(first!, 0)).toBe(INSPECTOR_BASE_PORT);
    expect(inspectorPort('iam-api', 0)).toBe(INSPECTOR_BASE_PORT);
  });

  it('offsets by exactly slot * SLOT_PORT_STRIDE so slots stay isolated', () => {
    const base = inspectorPort('iam-api', 0)!;
    expect(inspectorPort('iam-api', 1)).toBe(base + SLOT_PORT_STRIDE);
    expect(inspectorPort('iam-api', 7)).toBe(base + 7 * SLOT_PORT_STRIDE);
  });

  it('is SHARED across services in a slot — hence one-at-a-time profiling', () => {
    // Not a defect: SIGUSR1 cannot be told a port, so every service in a slot
    // lands on the same one. `planProfile` refuses when it is already held.
    expect(inspectorPort('iam-api', 2)).toBe(inspectorPort('coach-api', 2));
  });
});

describe('assertInspectorBandFree', () => {
  it('passes against the real manifest for slots 0-9', () => {
    expect(() => assertInspectorBandFree()).not.toThrow();
  });

  it('throws when a service is banded onto an inspector port', () => {
    // A synthetic manifest whose service port sits exactly on slot 0's first
    // inspector port — the regression this guard exists to catch.
    const colliding = {
      ...manifest,
      services: {
        ...manifest.services,
        'iam-api': { ...manifest.services['iam-api'], port: INSPECTOR_BASE_PORT },
      },
    };
    expect(() => assertInspectorBandFree(colliding, 0)).toThrow(/collides with/);
  });
});

