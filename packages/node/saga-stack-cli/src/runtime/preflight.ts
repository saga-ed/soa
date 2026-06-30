/**
 * The mesh host-port preflight (plan §7.2 "M4"). A FAITHFUL port of up.sh's
 * `check_ports` (~482-519) + `port_listening` (~492-499).
 *
 * Before the native mesh comes up, assert each host port the mesh publishes is
 * either FREE or already held by one of OUR mesh containers. up.sh names ALL
 * conflicts up front (it doesn't bail on the first) so the user can clear them in
 * one pass; we keep that, returning the full conflict list rather than throwing.
 *
 * Two probe sources, exactly like up.sh:
 *   1. `docker ps` — a port-MAPPED container shows here, giving a clean name +
 *      a `docker stop <name>` remedy. If that container is one of our mesh
 *      containers (`soa-postgres-1`/`soa-redis-1`/… from the manifest), it's
 *      fine — `make up` reconciles it; skip it.
 *   2. a real LISTENER check (ss → netstat → lsof → /dev/tcp) — catches NATIVE
 *      processes AND host-network containers a docker-ps-only check would miss
 *      (the host-redis-on-6379 footgun the up.sh comment calls out).
 *
 * The port list is DERIVED FROM THE MANIFEST (`meshPortSpecs`) — postgres 5432,
 * redis 6379, rabbitmq 5672 + its mgmt 15672, AND connect-mongo 27037. up.sh's
 * hardcoded `MESH_PORTS` array stops at 15672 (connect-mongo predates it); driving
 * the list off the manifest closes that gap and keeps it from drifting from the
 * topology. The owned-container set is likewise the manifest's mesh container
 * names, so a running `soa-connect-mongo-1` on :27037 is correctly "ours".
 *
 * Both probe sources are behind the injectable `PortProbe` so tests assert the
 * conflict logic with NO docker / no socket IO; production wires
 * `makeRealPortProbe()` (the only place `docker ps` / `ss` run for the preflight).
 *
 * INVARIANT (plan hard constraint): host/process IO lives only in
 * `src/runtime/**`; `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';
import { allMesh, manifest as defaultManifest } from '../core/manifest/index.js';
import type { Manifest } from '../core/manifest/index.js';

/** One mesh host port to preflight, with the human label up.sh prints. */
export interface MeshPortSpec {
  port: number;
  /** Human label, e.g. `postgres`, `rabbitmq`, `rabbitmq-mgmt`, `connect-mongo`. */
  name: string;
}

/** A detected port conflict (mesh can't bind this host port). */
export interface PortConflict {
  port: number;
  name: string;
  /** `docker` — a (non-mesh) container maps the port; `native` — a non-docker listener. */
  kind: 'docker' | 'native';
  /** The conflicting container name (kind `docker` only). */
  holder?: string;
  /** A ready-to-print, actionable message (mirrors up.sh's `✗ mesh port …`). */
  message: string;
}

/**
 * The injectable host-port probe. Two questions, mirroring up.sh: which docker
 * container (if any) maps this host port, and is the port held by a raw LISTENER.
 * A real probe shells out (`docker ps`, `ss`/`lsof`); a fake answers from a map.
 */
export interface PortProbe {
  /** The name of the docker container publishing host `port`, or null. */
  dockerHolder(port: number): Promise<string | null>;
  /** True iff host `port` is bound by a listening socket (native or host-network). */
  listening(port: number): Promise<boolean>;
}

/**
 * Derive the mesh host-port list from the manifest: each mesh unit's `port`, plus
 * `mgmtPort` where present (rabbitmq's 15672). Declaration order is preserved, so
 * the output reads postgres, redis, rabbitmq (+ mgmt), connect-mongo.
 */
export function meshPortSpecs(m: Manifest = defaultManifest): MeshPortSpec[] {
  const specs: MeshPortSpec[] = [];
  for (const unit of allMesh(m)) {
    specs.push({ port: unit.port, name: unit.id });
    if (unit.mgmtPort !== undefined) {
      specs.push({ port: unit.mgmtPort, name: `${unit.id}-mgmt` });
    }
  }
  return specs;
}

/** The set of container names that legitimately OWN a mesh port (manifest mesh containers). */
export function meshOwnedContainers(m: Manifest = defaultManifest): Set<string> {
  return new Set(allMesh(m).map((u) => u.container));
}

/**
 * Assert every mesh host port is free or owned by us. Returns the FULL list of
 * conflicts (empty ⇒ all clear) — the caller decides whether to abort. A port
 * mapped by one of `ownedContainers` is skipped (our own mesh, reconciled by
 * `make up`); any other docker container or a non-docker listener is a conflict.
 */
export async function checkPorts(
  ports: MeshPortSpec[],
  probe: PortProbe,
  ownedContainers: Set<string>,
): Promise<PortConflict[]> {
  const conflicts: PortConflict[] = [];
  for (const { port, name } of ports) {
    const holder = await probe.dockerHolder(port);
    if (holder) {
      if (ownedContainers.has(holder)) continue; // our mesh — fine
      conflicts.push({
        port,
        name,
        kind: 'docker',
        holder,
        message: `mesh port ${port} (${name}) held by container '${holder}' — free it:  docker stop ${holder}`,
      });
      continue;
    }
    if (await probe.listening(port)) {
      conflicts.push({
        port,
        name,
        kind: 'native',
        message:
          `mesh port ${port} (${name}) in use by a non-docker listener — find it:  ` +
          `sudo lsof -iTCP:${port} -sTCP:LISTEN  (or: sudo ss -lptn 'sport = :${port}')`,
      });
    }
  }
  return conflicts;
}

/** Run a command, resolving its trimmed stdout (or '' on any non-zero/spawn error). NEVER throws. */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString());
    });
  });
}

/**
 * The production port probe. `dockerHolder` parses `docker ps` for a container
 * publishing `:<port>->` on the host; `listening` tries `ss`, then `lsof` (the
 * widely-available subset of up.sh's ss→netstat→lsof→/dev/tcp ladder). Every
 * branch folds errors into a safe answer — a missing `docker`/`ss` never throws,
 * it just reports "no holder"/"not listening" so the preflight degrades open.
 */
export function makeRealPortProbe(): PortProbe {
  return {
    async dockerHolder(port: number): Promise<string | null> {
      const out = await runCapture('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
      if (!out) return null;
      // A row maps the port when its Ports column contains `:<port>->` or `.<port>->`.
      const re = new RegExp(`[:.]${port}->`);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [names, portsCol] = line.split('\t');
        if (portsCol && re.test(portsCol)) return (names ?? '').trim() || null;
      }
      return null;
    },

    async listening(port: number): Promise<boolean> {
      const re = new RegExp(`[:.]${port}$`);
      // ss -ltnH: one socket per line; column 4 is the local address:port.
      const ss = await runCapture('ss', ['-ltnH']);
      if (ss) {
        for (const line of ss.split('\n')) {
          const addr = line.trim().split(/\s+/)[3];
          if (addr && re.test(addr)) return true;
        }
        return false;
      }
      // Fallback: lsof exits 0 iff something LISTENs on the port.
      const lsof = await runCapture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
      return lsof.trim().length > 0;
    },
  };
}
