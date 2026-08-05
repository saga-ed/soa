/**
 * Inspector-port derivation for attach-mode profiling (`ss stack profile`).
 *
 * This module is PURE: port arithmetic only, zero IO.
 *
 * NOTHING IS INJECTED AT LAUNCH. A service's V8 inspector is opened on demand by
 * SIGUSR1, which always uses Node's DEFAULT port (9229) and offers no way to pick
 * one at signal time. So this module does not choose the port so much as PREDICT
 * it — the profiler needs to know where the inspector will appear.
 *
 * WHY NOT PRESET THE PORT. An earlier revision set
 * `NODE_OPTIONS=--inspect-port=<n>` on each service's launch env to get a distinct
 * per-service port. It does not work, and the failure is instructive: NODE_OPTIONS
 * is inherited by the ENTIRE launch tree, so `pnpm` and `tsup` each reserved the
 * same port and the real `node dist/main.js` — 4 levels down — then failed to bind
 * it, logging `Starting inspector on 127.0.0.1:9229 failed: address already in use`
 * into its own log while `ss` saw nothing. (The deployed `docker-entrypoint.sh`
 * avoids exactly this with a `[ "$1" = "node" ]` gate, but that works only because
 * the entrypoint IS the exec wrapper; the `ss` launch path has no such hop.)
 *
 * CONSEQUENCE — ONE SERVICE AT A TIME PER SLOT. Without a preset, every service in
 * a slot would open its inspector on the same port, so only one can be profiled at
 * a time. That is enforced, not hoped for: `planProfile` hard-refuses when the port
 * is already held (`ProfileTarget.inspectorPortBusy`) rather than silently
 * attaching to whoever owns it. Slots stay isolated because the port carries the
 * slot offset.
 *
 * SIGNAL THE SERVICE PID, NEVER THE GROUP. `ss` launches each service
 * `detached: true`, so the `pnpm dev` wrapper is the PROCESS-GROUP LEADER and the
 * real `node dist/main.js` shares its pgid. `launcher.ts` stops services by
 * signalling the NEGATIVE pid (the whole group) — profiling must not copy that.
 * A group-delivered SIGUSR1 would reach pnpm and tsup too, and whichever node in
 * the tree binds the default port first wins, leaving the service unprofilable.
 * Hence the positive, `lsof`-resolved listener pid only.
 *
 * A HELD PORT MAY NOT SPEAK HTTP. Whatever already owns the port need not be a
 * working inspector — it can accept TCP and never answer `/json/version` (any
 * stray listener does this). An HTTP probe HANGS against such a holder, so
 * `inspectorPortBusy` uses a bounded raw TCP connect instead.
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
