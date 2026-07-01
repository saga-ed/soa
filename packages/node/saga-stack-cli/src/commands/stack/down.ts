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
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import { meshDown, resolveRepoRoot } from '../../runtime/index.js';
import type { ScriptContext } from '../../runtime/index.js';

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

  async run(): Promise<void> {
    const { flags } = await this.parse(StackDown);

    // 1. Stop the services (up.sh --down). Without --mesh this is the whole job,
    //    so a non-zero exit propagates as before. With --mesh we still tear the
    //    mesh down even if services_down reported non-zero, so defer propagation
    //    and surface the worst code after the mesh teardown.
    const servicesCode = await this.runScript(flagMap.down(), flags, {
      propagateExit: !flags.mesh,
    });

    if (!flags.mesh) return;

    // 2. --mesh: ALSO tear the mesh down (inverse of up.sh mesh_up's
    //    `make up PROJECT=saga-mesh`). IO stays in runtime/ (the shared Runner).
    const ctx: ScriptContext = {
      dev: flags.dev,
      repoRoots: flags.soa ? { SOA: flags.soa } : {},
    };
    const mesh = await meshDown({
      soaRoot: resolveRepoRoot('SOA', ctx),
      runner: this.getRunner(),
    });

    const code = servicesCode !== 0 ? servicesCode : mesh.code;
    if (code !== 0) this.exit(code);
  }
}
