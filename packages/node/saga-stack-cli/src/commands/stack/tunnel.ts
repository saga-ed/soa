/**
 * `saga-stack stack tunnel <verb>` — expose the local stack via the vms
 * rendezvous box (M2 thin wrapper over tunnel.sh).
 *
 * Verbs are tunnel.sh's own dispatch (`case "${1:-up}"`):
 *   up            start the reverse tunnels (bootstraps the moniker on first run)
 *   down          stop the tunnels
 *   status        tunnel process + per-URL health probes
 *   moniker       print the moniker (bootstrapping it if absent)
 *   urls          print the public URL table
 *   aws-profile   print the resolved dev-account AWS profile (sibling tooling reads it)
 *
 * MONIKER IS NEVER A FLAG. tunnel.sh refuses the moniker on argv on purpose (a
 * placeholder in a shared command cross-contaminates stacks) and prompts on the
 * TTY on first use. So the command spawns with stdio inherited (BaseCommand's
 * runner default) for EVERY verb — the moniker prompt and frpc progress own the
 * user's terminal, exactly like the script. `AWS_PROFILE` is resolved by
 * tunnel.sh itself from the ambient env, so it is not surfaced as a flag.
 *
 *   node bin/dev.js stack tunnel up
 *   node bin/dev.js stack tunnel status
 *   node bin/dev.js stack tunnel moniker
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import type { TunnelVerb } from '../../core/flag-map.js';

const VERBS: readonly TunnelVerb[] = ['up', 'down', 'status', 'moniker', 'urls', 'aws-profile'];

export default class StackTunnel extends BaseCommand {
  static description =
    'Expose the local synthetic-dev stack via the vms rendezvous box (wraps tunnel.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %> up',
    '<%= config.bin %> <%= command.id %> status',
    '<%= config.bin %> <%= command.id %> moniker',
  ];

  static args = {
    verb: Args.string({
      description: 'tunnel action (moniker is prompted on the TTY, never taken as a flag)',
      options: [...VERBS],
      default: 'up',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'vms-base': Flags.string({
      description: 'rendezvous domain (tunnel.sh env VMS_BASE; default vms.wootdev.com)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackTunnel);
    const plan = flagMap.tunnel(args.verb as TunnelVerb, { vmsBase: flags['vms-base'] });
    await this.runScript(plan, flags);
  }
}
