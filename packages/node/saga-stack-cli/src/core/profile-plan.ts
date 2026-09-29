/**
 * Attach-mode profiling: the PURE decision layer. IO lives in
 * `runtime/profiler.ts`, so the parts that can silently do the WRONG thing stay
 * unit-testable without spawning anything.
 *
 * The failure guarded against: a profile that succeeds against the wrong process.
 * `<stateDir>/<id>.pid` holds the `pnpm dev` WRAPPER pid, not the service — so the
 * target is the pid LISTENING on the service's port, with its pgid matched against
 * the pidfiles for ownership (the `classifyForeign` approach). See `inspector.ts`.
 */

import { INSPECTOR_PORT } from './inspector.js';
import { getService, manifest as defaultManifest } from './manifest/index.js';
import type { Manifest, ServiceId } from './manifest/index.js';

/** What the runtime must gather before a profile can be planned. */
export interface ProfileTarget {
  /** The pid LISTENING on the service's port (`ForeignIo.pidOnPort`), or null. */
  listenerPid: number | null;
  /** That pid's process group + argv (`ForeignIo.procInfo`), or null. */
  proc: { pgid: number; command: string } | null;
  /** Pids recorded in this slot's pidfiles (`ForeignIo.ownedPgids`). */
  ownedPgids: number[];
  /** True when something already holds the inspector port (a stale/other session). */
  inspectorPortBusy: boolean;
  /**
   * The pid holding the inspector port, when it could be resolved. A held port is
   * only an obstacle if someone ELSE holds it: Node keeps the inspector open after
   * the CDP client disconnects, so the target's own inspector is a re-attach, not a
   * conflict.
   */
  inspectorPortPid: number | null;
}

/**
 * SIGUSR1's default disposition is TERMINATE, so only signal a real node process.
 * Match argv[0]'s BASENAME only: a `/node/` path segment anywhere else in the
 * command line belongs to some other runtime's arguments, and signalling it kills it.
 */
export function looksLikeNode(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  let exe = argv[0] ?? '';
  // `env` execs its first non-assignment argument, so unwrap to the real binary.
  if (/(^|\/)env$/.test(exe)) {
    exe = argv.slice(1).find((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) ?? '';
  }
  return /^node(js)?(-[\d.]+)?$/.test(exe.split('/').pop() ?? '');
}

export type ProfilePlan =
  | { ok: true; pid: number; port: number; command: string; adopted: boolean; alreadyOpen: boolean }
  | { ok: false; reason: string };

/** Human-facing hint appended to every "service isn't up" refusal. */
const UP_HINT = 'Bring it up first: `ss stack up --only <service>`.';

/**
 * Decide whether `service` can be profiled, and on which pid/port.
 *
 * Refuses (rather than guessing) when:
 *  - the service is a frontend — `pnpm dev` there is a Vite dev server, so a
 *    profile would measure the bundler, not the app;
 *  - nothing is listening on its port — it isn't up;
 *  - the listening process can't be inspected (`procInfo` failed);
 *  - the inspector port is already held — SIGUSR1 would fail SILENTLY (the only
 *    trace is `address already in use` in the SERVICE's log) and the profiler
 *    would then attach to whatever already owns that port. This is the feature's
 *    sharpest footgun, so it is a hard error, never a warning.
 *
 * An unowned listener (pgid matches no pidfile) is allowed but reported via
 * `adopted: false` so the caller can say whose process it is profiling — a
 * foreign process is still profilable, it just wasn't launched by this slot.
 */
export function planProfile(
  service: ServiceId,
  target: ProfileTarget,
  m: Manifest = defaultManifest,
): ProfilePlan {
  const def = getService(service, m);
  if (def.isFrontend) {
    return {
      ok: false,
      reason: `${service} is a frontend — \`pnpm dev\` runs a Vite dev server, so a CPU profile would measure the bundler, not the app.`,
    };
  }

  if (target.listenerPid === null) {
    return { ok: false, reason: `${service} is not listening — nothing to profile. ${UP_HINT}` };
  }

  if (target.proc === null) {
    return {
      ok: false,
      reason: `${service}: pid ${target.listenerPid} holds the port but is no longer inspectable (it exited mid-check). Re-run.`,
    };
  }

  // SIGUSR1 to a non-node process TERMINATES it (no handler ⇒ default disposition),
  // so never signal a listener we can't identify as node.
  if (!looksLikeNode(target.proc.command)) {
    return {
      ok: false,
      reason:
        `${service}: pid ${target.listenerPid} holds port but is not a node process ` +
        `(${target.proc.command}). Refusing — SIGUSR1 would kill it rather than open an inspector.`,
    };
  }

  // A held inspector port blocks us only when someone ELSE holds it. Node leaves the
  // inspector open after the CDP client disconnects, so the target's own inspector is
  // a re-attach; refusing there would make the command single-use per service.
  if (target.inspectorPortBusy && target.inspectorPortPid !== target.listenerPid) {
    const who =
      target.inspectorPortPid == null ? 'another process' : `pid ${target.inspectorPortPid}`;
    return {
      ok: false,
      reason:
        `${service}: inspector port ${INSPECTOR_PORT} is held by ${who}, not by the service. SIGUSR1 ` +
        `cannot choose a port, so the service could not open its own inspector and this profile ` +
        `would attach to the wrong process. The port takes no slot offset, so another slot is not ` +
        `an escape — free it and re-run.`,
    };
  }

  return {
    ok: true,
    pid: target.listenerPid,
    port: INSPECTOR_PORT,
    command: target.proc.command,
    adopted: target.ownedPgids.includes(target.proc.pgid),
    // Our own inspector already open ⇒ SIGUSR1 is a no-op; attach directly. Keep
    // both conjuncts: this must not depend on the refusal above staying in place.
    alreadyOpen: target.inspectorPortBusy && target.inspectorPortPid === target.listenerPid,
  };
}

/** Parse a `--duration` like `30s` / `500ms` / `2m` / a bare seconds count. */
export function parseDuration(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(input.trim());
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2] ?? 's';
  const ms = unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1000;
  return Math.round(ms);
}

/**
 * Default artifact path: slot-scoped state dir, service + a caller-supplied
 * timestamp so repeat runs don't overwrite each other. The timestamp is passed in
 * (not read from a clock) to keep this pure.
 */
export function defaultArtifactPath(stateDir: string, service: ServiceId, stamp: string): string {
  return `${stateDir.replace(/\/+$/, '')}/${service}-${stamp}.cpuprofile`;
}

/**
 * Does a captured profile actually contain the SERVICE's own frames?
 *
 * The positive signal that separates a real capture from a wrapper profile: at
 * least one sampled frame whose script URL sits under the service's own directory.
 * A profile of pnpm/tsup has plenty of nodes but none from the service's subpath,
 * so node count alone cannot tell the two apart.
 */
export function profileHasServiceFrames(
  profile: { nodes?: Array<{ hitCount?: number; callFrame?: { url?: string } }> },
  service: ServiceId,
  m: Manifest = defaultManifest,
): boolean {
  // Match the service's DIRECTORY, not a build subdir: tsup services run from
  // `<subpath>/dist` but tsx-watch ones (staff-admin-bff) run straight from
  // `<subpath>/src`, and pinning `/dist` reports every valid tsx capture as empty.
  const needle = `${getService(service, m).subpath}/`;
  // hitCount > 0 — a profile's `nodes` is the whole call tree, so parent and
  // parse-time nodes with hitCount 0 exist even when the service never ran.
  return (profile.nodes ?? []).some(
    (n) => (n.hitCount ?? 0) > 0 && (n.callFrame?.url ?? '').includes(needle),
  );
}
