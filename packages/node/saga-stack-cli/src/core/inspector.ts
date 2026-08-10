/**
 * Inspector-port derivation for attach-mode profiling (`ss stack profile`).
 * PURE: port arithmetic only, zero IO.
 *
 * SIGUSR1 opens the inspector on Node's DEFAULT port and cannot be told another,
 * so this module PREDICTS where the inspector will appear rather than choosing it.
 *
 * Per-service inspector ports are not available: injecting `--inspect-port` via
 * NODE_OPTIONS reserves the port in a wrapper instead of the service. Pinned by
 * launch-plan.unit.test.ts; rationale in docs/instrumentation.md.
 *
 * Two consequences the callers depend on:
 *  - ONE SERVICE AT A TIME, MACHINE-WIDE — not per slot. The port is Node's
 *    default and takes no offset, so slot 2's inspector lands on 9229 exactly
 *    like slot 0's. `planProfile` hard-refuses a held port rather than sampling
 *    whoever owns it, and `captureCpuProfile` re-checks the holder after SIGUSR1.
 *  - SIGNAL THE POSITIVE, `lsof`-RESOLVED LISTENER PID, NEVER THE GROUP. Services
 *    launch `detached: true`, so the `pnpm dev` wrapper leads the process group;
 *    a group-delivered SIGUSR1 lets a wrapper win the port instead.
 */

import { SLOT_PORT_STRIDE } from './derive-instance.js';
import { getService, manifest as defaultManifest } from './manifest/index.js';
import type { Manifest, ServiceId } from './manifest/index.js';

/**
 * Node's own default inspector port. SIGUSR1 opens here and cannot be redirected,
 * so this is a FACT about Node, not a choice — and it takes no slot offset: a
 * second concurrent profile, in any slot, collides here.
 */
export const INSPECTOR_PORT = 9229;

/** Backends only — a frontend's `pnpm dev` is a Vite dev server, not the app. */
export function profilableServices(m: Manifest = defaultManifest): ServiceId[] {
  return (Object.keys(m.services) as ServiceId[]).filter((id) => !m.services[id].isFrontend);
}

/**
 * Throw when the inspector port collides with a service or mesh port at any slot 0-9.
 * `deriveInstance` asserts service/mesh disjointness the same way; this extends
 * that guarantee to the inspector so a future service banded near 9229 fails
 * LOUDLY instead of silently stealing the port a profiler is about to attach to.
 */
export function assertInspectorPortFree(m: Manifest = defaultManifest, maxSlot = 9): void {
  for (let slot = 0; slot <= maxSlot; slot += 1) {
    const offset = slot * SLOT_PORT_STRIDE;
    for (const id of Object.keys(m.services) as ServiceId[]) {
      if (getService(id, m).port + offset === INSPECTOR_PORT) {
        throw new Error(
          `inspector: port ${INSPECTOR_PORT} collides with service ${id} at slot ${slot}. ` +
            `Re-band INSPECTOR_PORT above the claimed range.`,
        );
      }
    }
    for (const unit of Object.values(m.mesh)) {
      const mesh = [unit.port, unit.mgmtPort].filter((p): p is number => p !== undefined);
      if (mesh.some((p) => p + offset === INSPECTOR_PORT)) {
        throw new Error(
          `inspector: port ${INSPECTOR_PORT} collides with mesh ${unit.id} at slot ${slot}. ` +
            `Re-band INSPECTOR_PORT above the claimed range.`,
        );
      }
    }
  }
}
