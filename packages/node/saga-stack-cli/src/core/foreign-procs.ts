/**
 * Foreign-process classification (PURE) — the "is this stack port held by a
 * process `ss` did NOT launch?" decision, split out so the command layer + tests
 * reason about it with zero IO.
 *
 * WHY THIS EXISTS: `ss` health-checks a service by PORT, not by ownership — a 200
 * on `:3010` means "something is serving", not "ss launched it". A stale process
 * from a previous `up.sh` run (classically a `--tunnel` launch whose `tsup
 * --watch` supervisor outlived the shell) keeps answering the health probe, so
 * `up` adopts it ("already up" — launcher.ts) and never writes a pidfile for it;
 * `restart`/`down`, which reap by PIDFILE, then can't see it, so it survives
 * every bounce and re-injects its stale env (e.g. a tunnel `AUTH_SESSIONCOOKIE
 * DOMAIN`). `stack verify` flags this state; `stack cold-start` reaps it.
 *
 * OWNERSHIP TEST (exact, not heuristic): `makeRealLauncher` spawns every service
 * `detached: true`, so the recorded `<stateDir>/<id>.pid` IS the process-group
 * leader and the port-holding `node dist/main.js` grandchild inherits that pgid.
 * A listener is therefore ss-OWNED iff its pgid is one of the current pidfile
 * pids; anything else on a stack port is FOREIGN.
 *
 * INVARIANT (plan hard constraint): this lives in `core/` and stays PURE — no
 * `/proc`, no `lsof`, no spawn. The host IO lives only in `runtime/foreign-procs`.
 */

import type { Manifest, ServiceId } from './manifest/index.js';

/** A live listener on a stack service port, as resolved by the IO layer. */
export interface PortListener {
  /** The stack service port it is listening on. */
  port: number;
  /** The listening process's pid. */
  pid: number;
  /** Its process-group id — the ownership key (see module docstring). */
  pgid: number;
  /** A short command label for display (e.g. `node dist/main.js`), best-effort. */
  command: string;
}

/** A stack service port held by a process `ss` did not launch. */
export interface ForeignProc {
  /** The manifest service whose port is foreign-held. */
  id: ServiceId;
  port: number;
  pid: number;
  pgid: number;
  command: string;
}

/**
 * The `(id, port)` pairs to check — every NON-optional service (the same default
 * surface `healthProbes` uses), or a given subset. `portOverrides` (a slot's
 * `InstanceProfile.portOverrides`) shifts each port to the slot's offset; absent
 * (slot 0) ⇒ the manifest base port. Throws on an unknown id.
 */
export function foreignCheckTargets(
  m: Manifest,
  services?: ServiceId[],
  portOverrides?: Partial<Record<ServiceId, number>>,
): { id: ServiceId; port: number }[] {
  const ids =
    services ??
    (Object.keys(m.services) as ServiceId[]).filter((id) => !m.services[id].optional);
  return ids.map((id) => {
    const svc = m.services[id];
    if (!svc) throw new Error(`unknown service id: ${id}`);
    return { id, port: portOverrides?.[id] ?? svc.port };
  });
}

/**
 * Classify which of `targets` are held by a foreign process. `listeners` maps a
 * port → its live listener (absent ⇒ nothing on that port ⇒ NOT foreign, just
 * down). `ownedPgids` is the set of `ss` pidfile pids (== pgid leaders). A port
 * whose listener's pgid is not owned is foreign. Deterministic and
 * order-preserving (targets order in, foreign subset out).
 */
export function classifyForeign(
  targets: { id: ServiceId; port: number }[],
  listeners: Map<number, PortListener>,
  ownedPgids: Set<number>,
): ForeignProc[] {
  const foreign: ForeignProc[] = [];
  for (const { id, port } of targets) {
    const l = listeners.get(port);
    if (!l) continue; // nothing listening ⇒ the service is down, not foreign
    if (ownedPgids.has(l.pgid)) continue; // ss-launched (pgid is a pidfile leader) ⇒ owned
    foreign.push({ id, port, pid: l.pid, pgid: l.pgid, command: l.command });
  }
  return foreign;
}
