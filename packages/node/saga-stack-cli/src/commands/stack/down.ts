/**
 * `saga-stack stack down` — stop the running stack.
 *
 * Default (no `--mesh`): `flagMap.down()` → `up.sh --down` — up.sh skips the up
 * path, stops the services, and LEAVES the mesh (postgres/rabbitmq/redis/
 * connect-mongo) up. Unchanged M1 behaviour.
 *
 * With `--mesh` (plan M2 — "stack down --mesh: also make down infra"): after the
 * services are stopped, ALSO tear the mesh down. There is NO up.sh antecedent flag
 * (up.sh's `--down` never touches the mesh), so this is a native runtime step
 * layered on the M1 wrap — the faithful inverse of up.sh's `mesh_up`, which brings
 * the mesh up with `make up PROJECT=saga-mesh …` in `$SOA/infra`. The teardown runs
 * `make down PROJECT=saga-mesh` there (infra `down:` = `docker compose down`,
 * volumes preserved).
 *
 *   node bin/dev.js stack down            # services down, mesh stays up
 *   node bin/dev.js stack down --mesh     # services down + mesh down
 *
 * SLOT > 0 (M7 Phase 3): the host-global `up.sh --down` service-stop is NEVER run
 * (its `pkill -f tsup` + slot-0 STATE would kill slot 0's watchers). Instead the
 * slot's OWN dev servers are stopped NATIVELY by `stopServices(profile.stateDir)` —
 * SIGTERM→grace→SIGKILL of exactly the pids the native `up --slot N` recorded under
 * the slot's state dir (`/tmp/sds-synthetic-s<N>`), which physically cannot reach
 * slot 0's pidfiles. With `--mesh` the slot-correct native mesh teardown runs too.
 * Slot 0 is unchanged (up.sh --down wrapper).
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import { meshDown, resolveRepoRoot } from '../../runtime/index.js';
import type { MeshDownResult, ScriptContext, StopServiceResult } from '../../runtime/index.js';

export default class StackDown extends BaseCommand {
  static description =
    'Stop the running stack (wraps up.sh --down; leaves the mesh up unless --mesh).';

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
   * M7 Phase 3: `stack down --slot N` stops the slot's OWN services natively
   * (`stopServices` kill-by-pidfile against the slot's state dir) and, with
   * `--mesh`, tears down the RIGHT per-slot mesh project. The DESTRUCTIVE
   * host-global `up.sh --down` service-stop is NEVER run at slot > 0 (see BLOCKER-2
   * below). Slot 0 is unchanged (up.sh wrapper).
   */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackDown);

    // M7: the slot profile supplies the per-slot COMPOSE_PROJECT_NAME for the mesh
    // teardown. At slot 0 project stays `soa` (undefined here → the default).
    const profile = deriveInstance({ slot: flags.slot });

    // ── M7 BLOCKER-2: at slot > 0 do NOT run the host-global `up.sh --down`. ──
    // up.sh --down does `pkill -f tsup` (HOST-GLOBAL — kills every slot's watchers)
    // and kills the pids recorded under the hardcoded slot-0 STATE
    // (/tmp/sds-synthetic) — running it from a slot would kill slot 0's services.
    // So at slot > 0 we run the NATIVE slot-safe service-stop (Phase 3) instead: it
    // enumerates only the pidfiles under THIS slot's state dir and NEVER a global
    // pkill, so it cannot reach slot 0's watchers. With --mesh the slot-correct mesh
    // teardown runs after.
    if (profile.slot > 0) {
      // Phase 3: native, slot-safe service-stop — SIGTERM→grace→SIGKILL of exactly
      // the pids native `up --slot N` recorded. An EXPLICIT `--state-dir` wins;
      // otherwise the slot's `profile.stateDir` (`/tmp/sds-synthetic-s<N>`). This
      // MUST mirror `up`'s resolution (`up.ts` ~:470) — `up --slot N --state-dir
      // /custom` records pids under /custom, so a `down` that ignored `--state-dir`
      // would enumerate the slot's default dir, find nothing, and leak every server.
      // (Not a slot-safety breach — `down` always drives a slot>0 dir — just an
      // under-kill that this closes.)
      const stateDir = flags['state-dir'] ?? profile.stateDir;
      const stopper = this.getServiceStopper();
      const stopped = await stopper(stateDir);
      this.reportStopped(profile, stateDir, stopped);

      if (!flags.mesh) return;

      // --mesh: tear down ONLY this slot's mesh project (never the default `soa`).
      const mesh = await this.tearMeshDown(flags, profile);
      this.log(
        mesh.ok
          ? `mesh (${profile.project}): down`
          : `mesh (${profile.project}): make down exited ${mesh.code}`,
      );
      if (mesh.code !== 0) this.exit(mesh.code);
      return;
    }

    // ── Slot 0: unchanged M1 behaviour. ──
    // 1. Stop the services (up.sh --down). Without --mesh this is the whole job,
    //    so a non-zero exit propagates as before. With --mesh we still tear the
    //    mesh down even if services_down reported non-zero, so defer propagation
    //    and surface the worst code after the mesh teardown.
    const servicesCode = await this.runScript(flagMap.down(), flags, {
      propagateExit: !flags.mesh,
    });

    if (!flags.mesh) return;

    // 2. --mesh: ALSO tear the mesh down (inverse of up.sh mesh_up's
    //    `make up PROJECT=saga-mesh`).
    const mesh = await this.tearMeshDown(flags, profile);

    const code = servicesCode !== 0 ? servicesCode : mesh.code;
    if (code !== 0) this.exit(code);
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
    const ctx: ScriptContext = {
      dev: flags.dev,
      repoRoots: flags.soa ? { SOA: flags.soa } : {},
    };
    return meshDown({
      soaRoot: resolveRepoRoot('SOA', ctx),
      runner: this.getRunner(),
      project: profile.slot === 0 ? undefined : profile.project,
    });
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
