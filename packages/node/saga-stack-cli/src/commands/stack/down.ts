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
import type { ServiceId } from '../../core/manifest/index.js';
import { clearRegistry } from '../../runtime/frontend-registry.js';
import { meshDown, repoContextFromFlags, resolveRepoRoot } from '../../runtime/index.js';
import type {
  MeshDownResult,
  OrphanListener,
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

    // `ss frontend` variants were reaped above (their `saga-dash@<label>.pid` files
    // live under this state dir); clear the now-stale registry so `frontend browser`
    // doesn't point at dead ports.
    clearRegistry(stateDir, this.getFrontendRegistryIo());

    // ── POST-DOWN ORPHAN AUDIT (saga-ed/soa#249). ──
    // The group-kill above reaps every RECORDED pid's whole subtree, but a watch
    // child orphaned by an older build (or a pidfile lost to a crashed up) survives
    // invisibly — and then serves a STALE build to the next bring-up. Scan the
    // slot's resolved service-port band for sockets still LISTENing and warn LOUD,
    // naming pid + port + a paste-ready kill hint. Silent when clean; never fails
    // the teardown.
    await this.auditOrphans(profile);

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
   * Post-down orphan audit (saga-ed/soa#249): scan the slot's RESOLVED
   * service-port band — every service the slot's closure could launch (the
   * profile's `portOverrides`, minus the slot's `excludedServices`) — for sockets
   * still LISTENing after the teardown, and warn loudly per survivor with pid +
   * port + a paste-ready kill hint. The scan runs through the injectable
   * `OrphanScanner` seam (no raw exec here); any scanner failure degrades open
   * (reports nothing), so the audit can never fail `down` itself.
   */
  private async auditOrphans(profile: InstanceProfile): Promise<void> {
    const excluded = new Set<ServiceId>(profile.excludedServices);
    const portToService = new Map<number, ServiceId>();
    for (const [id, port] of Object.entries(profile.portOverrides) as [ServiceId, number][]) {
      if (!excluded.has(id)) portToService.set(port, id);
    }

    const survivors = await this.getOrphanScanner().scan([...portToService.keys()]);
    if (survivors.length === 0) return; // clean teardown — stay silent.

    this.log(
      `⚠ ORPHANS SURVIVED down — ${survivors.length} listener(s) still on slot ` +
        `${profile.slot}'s service ports (likely watch children of an older build; ` +
        'they will serve STALE code to the next up):',
    );
    for (const s of survivors) {
      this.log(`⚠   ${this.describeOrphan(s, portToService.get(s.port))}`);
    }
  }

  /** One survivor line: `port 4011 (programs-api): pid 873122 (node) — kill it:  kill -9 873122`. */
  private describeOrphan(s: OrphanListener, service: ServiceId | undefined): string {
    const who = service ?? 'unknown service';
    const hint =
      s.pid !== undefined
        ? `kill it:  kill -9 ${s.pid}`
        : `find it:  sudo lsof -iTCP:${s.port} -sTCP:LISTEN`;
    const holder = s.pid !== undefined ? `pid ${s.pid}${s.command ? ` (${s.command})` : ''}` : 'holder not visible';
    return `port ${s.port} (${who}): ${holder} — ${hint}`;
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
