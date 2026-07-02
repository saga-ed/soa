/**
 * healthProbes — the PURE, manifest-derived health-probe plan (plan §2.4, §7.2
 * "M2 — native status/verify").
 *
 * `stack status` and `stack verify` are re-implemented natively in M2: instead
 * of shelling out to `up.sh --status` / `verify.sh`, they derive the list of
 * endpoints to probe straight from the MANIFEST and probe each one through the
 * injectable `HealthProber` (see `runtime/health.ts`). This module is the PURE
 * half of that: given the manifest (and an optional service subset) it returns
 * the ordered probe list — no IO, no network, no spawn.
 *
 * Closing the verify.sh gap (plan §2.4): verify.sh hand-maintains a list of ~10
 * health endpoints and MISSES content-api (`:3009/health`). Here the list is
 * DERIVED from `manifest.services`, so content-api — which is in the manifest
 * with `port:3009, healthPath:'/health'` — is covered automatically, and the
 * list can never silently drift from the topology again.
 *
 * Each probe's `url` is built from the service's STACK lane (`http://localhost:
 * <port>`) joined with its `healthPath`, e.g.
 *   iam-api      → http://localhost:3010/health
 *   content-api  → http://localhost:3009/health     (the gap this closes)
 *   connect-api  → http://localhost:6106/connectv3/v1/health
 *   saga-dash    → http://localhost:8900/           (frontend: healthPath '/')
 *
 * INVARIANT (plan hard constraint): this lives in `core/` and stays PURE. The
 * actual HTTP lives only in `runtime/health.ts`; the command layer wires the two.
 */

import type { Manifest, ServiceId } from './manifest/index.js';

/** One manifest-derived health probe: which service, the URL to GET, and the expected status. */
export interface HealthProbe {
  /** The service this probe targets. */
  id: ServiceId;
  /** Absolute URL to GET — the service's stack lane joined with its health path. */
  url: string;
  /** The service's health path (`/health` | `/` | `/connectv3/v1/health`), kept for display. */
  healthPath: string;
  /** The status code a healthy service answers with (always 200 today; carried for clarity). */
  expectStatus: number;
}

/**
 * Build the ordered health-probe list for a service set.
 *
 * - `services` omitted ⇒ ALL non-optional services (the default health surface;
 *   optional playback services — transcripts/insights/chat — are excluded, just
 *   as verify.sh never probes them). Order is manifest declaration order.
 * - `services` given ⇒ exactly those ids, in the order supplied (callers pass a
 *   closure's launch order so the table reads top-down through the dependency
 *   graph). Throws on an unknown id.
 *
 * The stack-lane URL has no trailing slash (`http://localhost:3010`) and every
 * `healthPath` begins with `/`, so a plain concatenation yields the correct URL
 * for both `/health` services and the `/`-rooted frontends.
 *
 * M7: `portOverrides` (a slot's `InstanceProfile.portOverrides`) shifts each URL to
 * the slot's RESOLVED offset port, so `stack status`/`verify` probe the right
 * instance instead of base. Absent (slot 0) ⇒ the manifest base port, which equals
 * `svc.lane.stack`, so slot 0 is byte-identical.
 */
export function healthProbes(
  m: Manifest,
  services?: ServiceId[],
  portOverrides?: Partial<Record<ServiceId, number>>,
): HealthProbe[] {
  const ids =
    services ??
    (Object.keys(m.services) as ServiceId[]).filter((id) => !m.services[id].optional);

  return ids.map((id) => {
    const svc = m.services[id];
    if (!svc) throw new Error(`unknown service id: ${id}`);
    const port = portOverrides?.[id] ?? svc.port;
    return {
      id,
      url: `http://localhost:${port}${svc.healthPath}`,
      healthPath: svc.healthPath,
      expectStatus: 200,
    };
  });
}
