/**
 * `saga-stack stack down` — stop the running stack (fully NATIVE at every slot).
 *
 * Default (no `--mesh`): the slot's OWN dev servers are stopped NATIVELY by
 * `stopServices(stateDir)` — SIGTERM→grace→SIGKILL of exactly the pids the native
 * `up` recorded under the state dir (slot 0 = `/tmp/sds-synthetic`, slot N =
 * `…-s<N>`). It enumerates ONLY that dir's pidfiles and NEVER a host-global `pkill`,
 * so it is strictly safer than the old `up.sh --down` (which did `pkill -f tsup` +
 * killed the hardcoded slot-0 STATE) and cannot cross into a peer slot. The mesh
 * (postgres/rabbitmq/redis/connect-mongo) is LEFT up.
 *
 * With `--mesh` (plan M2 — "stack down --mesh: also make down infra"): after the
 * services are stopped, ALSO tear the mesh down — the faithful inverse of up.sh's
 * `mesh_up` (`make up PROJECT=saga-mesh …` in `$SOA/infra`). The teardown runs
 * `make down PROJECT=saga-mesh` there (infra `down:` = `docker compose down`,
 * volumes preserved), against THIS slot's project (slot 0 → the default `soa`).
 *
 *   node bin/dev.js stack down            # services down, mesh stays up
 *   node bin/dev.js stack down --mesh     # services down + mesh down
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { meshDown, repoContextFromFlags, resolveRepoRoot } from '../../runtime/index.js';
import type {
  MeshDownResult,
  ReapedProc,
  ScriptContext,
  StopServiceResult,
} from '../../runtime/index.js';

export default class StackDown extends BaseCommand {
  static description =
    'Stop the running stack natively (kill-by-pidfile; leaves the mesh up unless --mesh).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --mesh',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    mesh: Flags.boolean({
      description:
        'Also tear the mesh (postgres/rabbitmq/redis/connect-mongo) down (make down PROJECT=saga-mesh in $SOA/infra); default leaves the mesh up.',
      default: false,
    }),
  };

  /**
   * `stack down [--slot N]` stops the slot's OWN services natively (`stopServices`
   * kill-by-pidfile against the slot's state dir) and, with `--mesh`, tears down the
   * RIGHT per-slot mesh project. Slot-aware at every slot; NO host-global `pkill`.
   */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `--set` resolves to the set's slot; down tears that slot down. */
  protected setAware(): boolean {
    return true;
  }

  /** Slot claims: a teardown DRIVES the slot — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackDown);

    // The slot profile supplies the per-slot state dir + COMPOSE_PROJECT_NAME for the
    // mesh teardown. At slot 0 stateDir=/tmp/sds-synthetic and project stays `soa`.
    const profile = deriveInstance({ slot: flags.slot });

    // ── NATIVE service-stop at EVERY slot (slot 0 included). ──
    // SIGTERM→grace→SIGKILL of exactly the pids native `up` recorded — it enumerates
    // ONLY the pidfiles under this slot's state dir and NEVER a host-global `pkill`, so
    // it is strictly safer than the old `up.sh --down` and can't cross into a peer slot.
    // An EXPLICIT `--state-dir` wins; otherwise the slot's `profile.stateDir` (slot 0 =
    // `/tmp/sds-synthetic`). This MUST mirror `up`'s resolution (base-command
    // `buildNativeRuntime`: `flags['state-dir'] ?? profile.stateDir`) — `up --state-dir
    // /custom` records pids under /custom, so a `down` that ignored `--state-dir` would
    // enumerate the default dir, find nothing, and leak every server.
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const stopper = this.getServiceStopper();
    const stopped = await stopper(stateDir);
    this.reportStopped(profile, stateDir, stopped);

    // ── POST-DOWN ORPHAN REAP (saga-ed/soa#249, soa#361). ──
    // The pidfile group-kill above reaps every RECORDED pid's whole subtree, but a
    // watch child orphaned from its recorded group leader (leader already exited, or
    // a vite/tsup child reparented into a NEW process group) survives invisibly —
    // stopServices sees the dead leader, marks it `stale`, and never signals the
    // orphan. It then keeps a slot port with a STALE launch env, so the next
    // `up`/`up --tunnel` refuses to adopt it ("contract can't be verified"). Scan the
    // slot's resolved service-port band and REAP any survivor by its LIVE pgid (the
    // same ForeignProcs primitive cold-start uses). Silent when clean; never fails
    // the teardown.
    await this.reapOrphans(profile, stateDir);

    if (!flags.mesh) return;

    // ── --mesh: ALSO tear the mesh down (inverse of up.sh mesh_up's
    //    `make up PROJECT=saga-mesh`), against THIS slot's project (slot 0 → default `soa`). ──
    const mesh = await this.tearMeshDown(flags, profile);
    this.log(
      mesh.ok
        ? `mesh (${profile.project}): down`
        : `mesh (${profile.project}): make down exited ${mesh.code}`,
    );
    if (mesh.code !== 0) this.exit(mesh.code);
  }

  /**
   * Tear the mesh down through the shared Runner (inverse of up.sh mesh_up's
   * `make up PROJECT=saga-mesh`). IO stays in runtime/. CRITICAL (M7): pass the
   * slot's project so `make down` tears down THIS slot's mesh, not the default
   * `soa` project (at slot 0 `project` is undefined → the default).
   */
  private async tearMeshDown(
    flags: { dev: string; soa?: string },
    profile: InstanceProfile,
  ): Promise<MeshDownResult> {
    const ctx: ScriptContext = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    return meshDown({
      soaRoot: resolveRepoRoot('SOA', ctx),
      runner: this.getRunner(),
      project: profile.slot === 0 ? undefined : profile.project,
    });
  }

  /**
   * Post-down orphan REAP (saga-ed/soa#249, soa#361): after `stopServices` has
   * killed+unlinked this slot's recorded pidfiles, find any process STILL listening
   * on the slot's resolved service-port band (`reapScanServices` — every service the
   * slot could launch, minus its `excludedServices`) and group-kill it by its LIVE
   * pgid. This is the same `ForeignProcs` primitive `cold-start` reaps with, run at
   * `down` time so a reparented watch child (which the pidfile group-kill can't
   * reach) can't survive to block the next `up --tunnel`'s contract check. Every
   * shell-out degrades OPEN (a missing `lsof`/`ss`/`ps` ⇒ "nothing found"), so the
   * reap can never fail `down` itself. Silent when the teardown was clean.
   *
   * Scanned AFTER `stopServices` (unlike cold-start, which scans first): our own
   * pidfiles are already gone, so anything still on the band is by definition a
   * survivor of the teardown — no ownership disambiguation needed.
   */
  private async reapOrphans(profile: InstanceProfile, stateDir: string): Promise<void> {
    const services = reapScanServices(profile);
    if (services.length === 0) return;

    const foreign = await this.getForeignProcs().find({
      manifest,
      services,
      stateDir,
      portOverrides: profile.portOverrides,
    });
    if (foreign.length === 0) return; // clean teardown — stay silent.

    const reaped = await this.getForeignProcs().reap(foreign);
    for (const line of describeReap(reaped, profile.slot)) this.log(line);
  }

  /**
   * Render what the native slot-safe service-stop did: the services that were
   * actually stopped (SIGTERM'd, or SIGKILL'd if they outlived the grace window),
   * any that SURVIVED even SIGKILL (`alive` — a leak the teardown couldn't close),
   * and any stale pidfiles that were already dead (a clean no-op). Names the RESOLVED
   * state dir (which honours `--state-dir`) so the scope of the teardown is
   * unambiguous.
   */
  private reportStopped(
    profile: InstanceProfile,
    stateDir: string,
    stopped: StopServiceResult[],
  ): void {
    const stopped_ = stopped.filter((s) => s.outcome === 'term' || s.outcome === 'kill');
    const survived = stopped.filter((s) => s.outcome === 'alive');
    const stale = stopped.filter((s) => s.outcome === 'stale');

    this.log(
      `slot ${profile.slot}: stopped ${stopped_.length} service(s) from ${stateDir} ` +
        '(native kill-by-pidfile — no host-global pkill)',
    );
    this.log(
      `stopped: ${
        stopped_.map((s) => `${s.id}${s.outcome === 'kill' ? ' (SIGKILL)' : ''}`).join(', ') ||
        '(none running)'
      }`,
    );
    if (survived.length > 0) {
      this.log(
        `STILL ALIVE after SIGTERM+SIGKILL (leaked — pidfile kept): ${survived
          .map((s) => `${s.id}${s.pid !== undefined ? ` (pid ${s.pid})` : ''}`)
          .join(', ')}`,
      );
    }
    if (stale.length > 0) {
      this.log(`stale pidfiles (already gone): ${stale.map((s) => s.id).join(', ')}`);
    }
  }
}

/**
 * PURE: the services whose ports a post-down reap scans — every service the slot
 * carries a resolved port for (`portOverrides`), minus the slot's
 * `excludedServices` (e.g. the literal-port playback trio a slot-N stack does not
 * own). Order-preserving over `portOverrides`. Empty ⇒ nothing to scan.
 */
export function reapScanServices(profile: InstanceProfile): ServiceId[] {
  const excluded = new Set<ServiceId>(profile.excludedServices);
  return (Object.keys(profile.portOverrides) as ServiceId[]).filter((id) => !excluded.has(id));
}

/** Clip a long command label for a one-line orphan report. */
function clipReapCommand(command: string, max = 60): string {
  return command.length > max ? `${command.slice(0, max - 1)}…` : command;
}

/**
 * PURE: the report lines for a post-down reap. Empty in ⇒ empty out (a clean
 * teardown stays silent). Otherwise a loud header, one line per reaped orphan
 * (pid + pgid + command, flagged when the kill did NOT confirm), and a trailing
 * summary — `✓` when every orphan is confirmed gone, `⚠` naming any that survived
 * (already gone, or not permitted to signal).
 */
export function describeReap(reaped: ReapedProc[], slot: number): string[] {
  if (reaped.length === 0) return [];
  const lines = [
    `⚠ ${reaped.length} orphan(s) still held slot ${slot}'s service ports after down ` +
      '(a watch child the pidfile group-kill could not reach) — reaping by live pgid:',
  ];
  for (const r of reaped) {
    lines.push(
      `⚠   ${r.id} :${r.port} pid ${r.pid} (pgid ${r.pgid})  ${clipReapCommand(r.command)}` +
        (r.killed ? '' : '  — STILL ALIVE'),
    );
  }
  const survived = reaped.filter((r) => !r.killed);
  lines.push(
    survived.length === 0
      ? `✓ reaped ${reaped.length} orphan(s) — the next up starts clean`
      : `⚠ ${survived.length} orphan(s) could not be killed (already gone, or not permitted): ` +
          survived.map((s) => `${s.id}(pid ${s.pid})`).join(', '),
  );
  return lines;
}
