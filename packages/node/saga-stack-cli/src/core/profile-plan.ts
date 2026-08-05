/**
 * Attach-mode profiling: the PURE decision layer.
 *
 * Everything here is arithmetic + validation over already-gathered facts; the IO
 * (resolving the listening pid, signalling, speaking CDP, writing the artifact)
 * lives in `runtime/profiler.ts`. Splitting it this way keeps the parts that can
 * silently do the WRONG thing — attaching to a wrapper, profiling a stale port —
 * unit-testable without spawning anything.
 *
 * The failure this module exists to prevent: a profile that succeeds against the
 * wrong process. `ss` records the `pnpm dev` WRAPPER pid in `<stateDir>/<id>.pid`,
 * while the real service is a `node dist/main.js` grandchild 4 levels deeper
 * (tsup re-spawns it on every rebuild, so its pid also churns). Profiling the
 * recorded pid would silently sample the package manager. Ownership is therefore
 * proven the way `classifyForeign` does it — resolve the pid LISTENING on the
 * service's port, then require its pgid to match a pidfile-recorded pid.
 */

import { inspectorPort } from './inspector.js';
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
}

export type ProfilePlan =
  | { ok: true; pid: number; port: number; command: string; adopted: boolean }
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
  slot: number,
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

  const port = inspectorPort(service, slot, m);
  if (port === null) {
    return { ok: false, reason: `${service} has no inspector port (not profilable).` };
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

  if (target.inspectorPortBusy) {
    return {
      ok: false,
      reason:
        `${service}: inspector port ${port} is already in use. SIGUSR1 cannot choose a port, so the ` +
        `service would fail to open its inspector SILENTLY and this profile would attach to the ` +
        `wrong process. Close the existing inspector (or profile a different service) and re-run.`,
    };
  }

  return {
    ok: true,
    pid: target.listenerPid,
    port,
    command: target.proc.command,
    adopted: target.ownedPgids.includes(target.proc.pgid),
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
 * A profile of pnpm/tsup has plenty of nodes but none from `<subpath>/dist`, which
 * is exactly how the earlier `--cpu-prof` attempt looked "successful" while being
 * useless.
 */
export function profileHasServiceFrames(
  profile: { nodes?: Array<{ hitCount?: number; callFrame?: { url?: string } }> },
  service: ServiceId,
  m: Manifest = defaultManifest,
): boolean {
  const needle = `${getService(service, m).subpath}/dist`;
  return (profile.nodes ?? []).some(
    (n) => (n.hitCount ?? 0) >= 0 && (n.callFrame?.url ?? '').includes(needle),
  );
}
