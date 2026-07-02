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
 * SLOT > 0 (M7 Phase 2): the host-global `up.sh --down` service-stop is NEVER run
 * (its `pkill -f tsup` + slot-0 STATE would kill slot 0's watchers). Only the
 * slot-correct native mesh teardown runs, and only with `--mesh`. Stop a slot's
 * own services by killing its process group / Ctrl-C until native per-slot
 * service-stop lands in Phase 3. Slot 0 is unchanged.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import { meshDown, resolveRepoRoot } from '../../runtime/index.js';
import type { MeshDownResult, ScriptContext } from '../../runtime/index.js';

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
   * M7 Phase 2: `stack down --mesh --slot N` tears down the RIGHT per-slot mesh
   * project. At slot > 0 the DESTRUCTIVE host-global `up.sh --down` service-stop is
   * NOT run at all (see BLOCKER-2 below) — only the slot-correct native mesh
   * teardown runs, and native per-slot service-stop is Phase 3.
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
    // So at slot > 0 we run ONLY the slot-correct native mesh teardown (when --mesh)
    // and NEVER the up.sh service-stop.
    if (profile.slot > 0) {
      this.warn(
        `slot ${profile.slot}: NOT running the host-global 'up.sh --down' (its 'pkill -f tsup' + ` +
          'slot-0 STATE=/tmp/sds-synthetic would kill slot 0\'s watchers). Native per-slot ' +
          "service-stop (kill-by-pidfile against this slot's state dir) is Phase 3 — for now stop " +
          "slot N's services by killing that slot's process group / Ctrl-C.",
      );

      if (!flags.mesh) return;

      // --mesh: tear down ONLY this slot's mesh project (never the default `soa`).
      const mesh = await this.tearMeshDown(flags, profile);
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
}
