/**
 * Inspector-port derivation for attach-mode profiling (`ss stack profile`).
 * PURE: port arithmetic only, zero IO.
 *
 * SIGUSR1 opens the inspector on Node's DEFAULT port and cannot be told another,
 * so this module PREDICTS where the inspector will appear rather than choosing it.
 *
 * Don't inject `--inspect-port` into a service's launch env to get per-service
 * ports: NODE_OPTIONS is inherited by the whole `pnpm dev → tsup → node
 * dist/main.js` tree, so the wrappers reserve the port and the service fails to
 * bind it — visible only as `address already in use` in the service's own log.
 * A regression test in launch-plan.unit.test.ts pins this.
 *
 * Two consequences the callers depend on:
 *  - ONE SERVICE AT A TIME PER SLOT (every service in a slot shares the port).
 *    `planProfile` hard-refuses a held port rather than sampling whoever owns it.
 *    Slots stay isolated via the slot offset.
 *  - SIGNAL THE POSITIVE, `lsof`-RESOLVED LISTENER PID, NEVER THE GROUP. Services
 *    launch `detached: true`, so the `pnpm dev` wrapper leads the process group;
 *    a group-delivered SIGUSR1 lets a wrapper win the port instead.
 */

import { SLOT_PORT_STRIDE } from './derive-instance.js';
import { getService, manifest as defaultManifest } from './manifest/index.js';
import type { Manifest, ServiceId } from './manifest/index.js';

/**
 * Node's own default inspector port. SIGUSR1 opens here and cannot be redirected,
 * so this is a FACT about Node, not a choice — slot N adds `N * SLOT_PORT_STRIDE`
 * because slot N's services are separate processes on an offset port band.
 */
export const INSPECTOR_BASE_PORT = 9229;

/** Backends only — a frontend's `pnpm dev` is a Vite dev server, not the app. */
export function profilableServices(m: Manifest = defaultManifest): ServiceId[] {
  return (Object.keys(m.services) as ServiceId[]).filter((id) => !m.services[id].isFrontend);
}

/**
 * Where `service`'s inspector will appear once signalled at `slot`, or null when
 * the service is a frontend (not profilable).
 */
export function inspectorPort(
  service: ServiceId,
  slot: number,
  m: Manifest = defaultManifest,
): number | null {
  if (m.services[service]?.isFrontend !== false) return null;
  return INSPECTOR_BASE_PORT + slot * SLOT_PORT_STRIDE;
}

/**
 * Throw when the inspector band overlaps a service or mesh port at any slot 0-9.
 * `deriveInstance` asserts service/mesh disjointness the same way; this extends
 * that guarantee to the inspector so a future service banded near 9229 fails
 * LOUDLY instead of silently stealing the port a profiler is about to attach to.
 */
export function assertInspectorBandFree(m: Manifest = defaultManifest, maxSlot = 9): void {
  const claimed = new Map<number, string>();
  for (let slot = 0; slot <= maxSlot; slot += 1) {
    const offset = slot * SLOT_PORT_STRIDE;
    for (const id of Object.keys(m.services) as ServiceId[]) {
      claimed.set(getService(id, m).port + offset, `service ${id}`);
    }
    for (const unit of Object.values(m.mesh)) {
      claimed.set(unit.port + offset, `mesh ${unit.id}`);
      if (unit.mgmtPort !== undefined) claimed.set(unit.mgmtPort + offset, `mesh ${unit.id} mgmt`);
    }
  }
  for (let slot = 0; slot <= maxSlot; slot += 1) {
    const port = INSPECTOR_BASE_PORT + slot * SLOT_PORT_STRIDE;
    const owner = claimed.get(port);
    if (owner !== undefined) {
      throw new Error(
        `inspector: port ${port} (slot ${slot}) collides with ${owner}. ` +
          `Re-band INSPECTOR_BASE_PORT above the claimed range.`,
      );
    }
  }
}
